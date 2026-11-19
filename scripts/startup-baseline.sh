#!/usr/bin/env bash
# Measure daemon startup, phase by phase, in throwaway state directories.
#
# "Startup is slow" is not actionable until it is a number attributed to a
# phase. This boots the real `kin` binary with KIN_STARTUP_TRACE=1, times the
# gap from spawn to the first successful /api/health, and reports each phase's
# median cold (fresh state dir) and warm (same dir booted again).
#
# The daemon is handed its true spawn instant (KIN_STARTUP_ORIGIN_MS), so the
# table covers exec -> ServeWith as `process`, every named boot phase, and the
# post-ready wait as `ready→health`. The named segments sum to the measured
# wall clock; `ready→health` is quantised by the 50ms health poll.
#
# --db-fixture-size N first fills a throwaway database with synthetic rows
# until it is within 2% of N bytes, so `store-open` can be measured at the size
# of a real database. The rows are synthetic, written by the stdlib sqlite3
# module, and never come from a real state directory.
#
# Safety: every boot uses a mktemp state dir and a freshly reserved free port.
# It never touches a live daemon, a real state directory, or ~/.kin; a state
# dir under $HOME/.kin is refused before anything is opened.
#
# Usage:
#   ./scripts/startup-baseline.sh [--runs N] [--json] [--db-fixture-size BYTES]
#   ./scripts/startup-baseline.sh --selftest [--db-fixture-size BYTES]
#
# --selftest boots once and fails unless every phase line appears: `process`
# plus the 11 boot phases, each exactly once. With --db-fixture-size it seeds
# the database first and additionally asserts the fixture size, the fixture
# lines, and the $HOME/.kin refusal path. It is this script's own red/green
# check; it is deliberately NOT wired into check.sh, because it boots a real
# binary and startup timing is not a CI gate.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNS=3
JSON=0
SELFTEST=0
FIXTURE_SIZE=""

usage() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --runs) RUNS="${2:-}"; shift 2 ;;
    --runs=*) RUNS="${1#*=}"; shift ;;
    --json) JSON=1; shift ;;
    --selftest) SELFTEST=1; shift ;;
    --db-fixture-size) FIXTURE_SIZE="${2:-}"; shift 2 ;;
    --db-fixture-size=*) FIXTURE_SIZE="${1#*=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if ! [[ "$RUNS" =~ ^[0-9]+$ ]] || [[ "$RUNS" -lt 1 ]]; then
  echo "FAIL: --runs must be a positive integer, got '$RUNS'" >&2
  exit 2
fi
if [[ -n "$FIXTURE_SIZE" ]] && { ! [[ "$FIXTURE_SIZE" =~ ^[0-9]+$ ]] || [[ "$FIXTURE_SIZE" -lt 1 ]]; }; then
  echo "FAIL: --db-fixture-size must be a positive integer, got '$FIXTURE_SIZE'" >&2
  exit 2
fi

BUILD_DIR="$(mktemp -d)"
LOGDIR="$(mktemp -d)"
RESULTS="$BUILD_DIR/runs.tsv"
PHASES="$BUILD_DIR/phases.tsv"
: >"$RESULTS"
: >"$PHASES"
BIN="$BUILD_DIR/kin"
PID=""
KEEP_STATE=""
SEED_RUN=0

# Every request is bounded, like smoke.sh: a handler that deadlocks must fail
# this script in seconds, not hold the terminal.
CURL=(curl -sS --connect-timeout 2 --max-time 10)

cleanup() {
  if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
    kill -KILL "$PID" 2>/dev/null
    wait "$PID" 2>/dev/null
  fi
  [[ -n "$KEEP_STATE" ]] && rm -rf "$KEEP_STATE"
  rm -rf "$BUILD_DIR" "$LOGDIR"
}
trap cleanup EXIT

say() { if [[ "$JSON" == "1" ]]; then echo "$*" >&2; else echo "$*"; fi; }

fail() { # message [log]
  local msg="$1" log="${2:-}"
  echo "FAIL: $msg" >&2
  if [[ -n "$log" && -f "$log" ]]; then
    echo "--- daemon startup trace (last 40 lines) ---" >&2
    local trace
    trace="$(grep -E 'kin: startup |panic:|fatal error:' "$log" | tail -40)"
    if [[ -n "$trace" ]]; then
      printf '%s\n' "$trace" | sed -E 's/([?&]token=)[^ &]+/\1<redacted>/g' >&2
    else
      echo "(no startup trace lines; the daemon did not reach the first phase mark)" >&2
      tail -20 "$log" | sed -E 's/([?&]token=)[^ &]+/\1<redacted>/g' >&2
    fi
    echo "--- end trace ---" >&2
  fi
  exit 1
}

free_port() {
  python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'
}

now_ms() {
  python3 -c 'import time; print(time.time_ns() // 1_000_000)'
}

file_size() {
  stat -f%z "$1" 2>/dev/null || stat -c%s "$1"
}

# check_state_dir refuses anything under $HOME/.kin. It resolves the throwaway
# path (which may sit behind a symlinked /var) but never probes the home state
# directory itself: the comparison is against $HOME's real path plus ".kin".
check_state_dir() { # dir
  local real home_kin
  real="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1")" || return 1
  home_kin="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$HOME")/.kin"
  case "$real" in
    "$home_kin"|"$home_kin"/*)
      echo "FAIL: refusing to use a state directory under $home_kin: $real" >&2
      return 1
      ;;
  esac
}

# parse_trace appends one row per phase line: kind, run, phase, ms, total.
parse_trace() { # log kind run
  grep -oE 'kin: startup [a-z-]+ [0-9]+ms total=[0-9]+ms' "$1" |
    awk -v kind="$2" -v run="$3" '{
      ms = $4; sub(/ms$/, "", ms)
      total = $5; sub(/^total=/, "", total); sub(/ms$/, "", total)
      print kind "\t" run "\t" $3 "\t" ms "\t" total
    }' >>"$PHASES"
}

# boot starts one daemon, waits for /api/health, records the wall clock, and
# kills it hard (SIGKILL: shutdown time is not startup time).
boot() { # state kind run
  local state="$1" kind="$2" run="$3"
  local port base log t0 t1 elapsed i ready_total post
  check_state_dir "$state" || fail "refusing state directory $state"
  port="$(free_port)" || fail "could not pick a free port"
  base="http://127.0.0.1:$port"
  log="$LOGDIR/$kind-$run.log"

  # t0 is both the script's wall-clock zero and the origin handed to the
  # daemon, so the trace's total= and the wall clock share one instant.
  t0="$(now_ms)"
  KIN_STARTUP_ORIGIN_MS="$t0" KIN_STATE_DIR="$state" KIN_PORT="$port" KIN_STARTUP_TRACE=1 \
    "$BIN" serve --port "$port" >>"$log" 2>&1 &
  PID=$!

  for i in $(seq 1 1200); do # ~60s at 50ms plus the request time
    if "${CURL[@]}" -fs -o /dev/null "$base/api/health" 2>/dev/null; then
      break
    fi
    if ! kill -0 "$PID" 2>/dev/null; then
      PID=""
      fail "the daemon ($kind run $run) exited before answering /api/health" "$log"
    fi
    sleep 0.05
  done
  if ! "${CURL[@]}" -fs -o /dev/null "$base/api/health" 2>/dev/null; then
    fail "the daemon ($kind run $run) did not answer /api/health within 60s" "$log"
  fi
  t1="$(now_ms)"
  elapsed=$((t1 - t0))

  kill -KILL "$PID" 2>/dev/null
  wait "$PID" 2>/dev/null
  PID=""

  printf '%s\t%s\t%s\t%s\n' "$kind" "$run" "$elapsed" "$log" >>"$RESULTS"
  parse_trace "$log" "$kind" "$run"

  # ready→health is the one segment the trace cannot see: it ends when this
  # script's poll gets an answer, so it is derived from the trace's own total=
  # and the wall clock. That keeps every row additive instead of counting the
  # poll twice. Its resolution is the 50ms poll, not the millisecond clock.
  ready_total="$(awk -F'\t' -v k="$kind" -v r="$run" '$1 == k && $2 == r && $3 == "ready" { print $5 }' "$PHASES" | tail -1)"
  if [[ "$ready_total" =~ ^[0-9]+$ ]]; then
    post=$((elapsed - ready_total))
    printf '%s\t%s\t%s\t%s\t%s\n' "$kind" "$run" "ready→health" "$post" "$elapsed" >>"$PHASES"
  fi
}

run_one() { # state kind run
  boot "$1" "$2" "$3"
  local elapsed
  elapsed="$(awk -F'\t' -v k="$2" -v r="$3" '$1 == k && $2 == r { print $3 }' "$RESULTS")"
  say "  $2 run $3: ${elapsed}ms to healthy"
}

assert_fixture_size() { # path target tolerance_percent
  local got target pct
  got="$(file_size "$1")"
  target="$2"
  pct="$3"
  python3 - "$got" "$target" "$pct" <<'PY'
import sys
got, target, pct = int(sys.argv[1]), int(sys.argv[2]), float(sys.argv[3])
if abs(got - target) > target * pct / 100.0:
    print("FAIL: fixture size %d is outside %.0f%% of %d" % (got, pct, target), file=sys.stderr)
    sys.exit(1)
print("fixture: %d bytes (%.1f%% of %d)" % (got, got * 100.0 / target, target))
PY
}

# seed_fixture fills a throwaway database with synthetic rows until the file is
# within 2% of target bytes. The schema comes from the daemon's own migrations:
# one boot on the empty throwaway dir, then SIGKILL (boot already kills hard).
# The store's schema is embedded in internal/store/migrate.go (there is no
# migrations/ directory); the tables inflated here are `tasks`, `events`, and
# `agent_sessions`, with a transcript_index_state watermark ahead of every
# synthetic event so opening the file measures the open path, not a backfill.
seed_fixture() { # state target_bytes
  local state="$1" target="$2"
  local db="$state/kin.db"
  check_state_dir "$state" || fail "refusing state directory $state"
  say "  seeding a synthetic ~$target-byte database (throwaway rows only)"
  # Each seeding boot needs its own run id: phases and results are keyed by
  # (kind, run), and a shared id would make the derived-segment lookup read
  # every previous seeding boot at once.
  SEED_RUN=$((SEED_RUN + 1))
  boot "$state" seed "$SEED_RUN"
  [[ -f "$db" ]] || fail "fixture: the daemon did not create $db" "$LOGDIR/seed-$SEED_RUN.log"

  python3 - "$db" "$target" <<'PY' || fail "fixture: seeding $db to $target bytes"
import os
import sqlite3
import sys
import time

db, target = sys.argv[1], int(sys.argv[2])
low, high = int(target * 0.98), int(target * 1.02)
deadline = time.time() + 60

con = sqlite3.connect(db)
con.execute("PRAGMA journal_mode=WAL")
con.execute("PRAGMA synchronous=OFF")

def file_size():
    # WAL growth is invisible to stat until it is checkpointed.
    con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    return os.path.getsize(db)

now = int(time.time())
tasks = ["fixture-task-%05d" % i for i in range(400)]
with con:
    for i, tid in enumerate(tasks):
        con.execute(
            "INSERT OR IGNORE INTO tasks (id, title, agent, cwd, prompt, status, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (tid, "synthetic startup fixture %d" % i, "claudecode", "/tmp/fixture",
             "synthetic row for a startup measurement; not a real task", "done", now),
        )
        # Ahead of every synthetic event: the selector asks "seq > indexed_seq",
        # so it finds nothing to replay.
        con.execute(
            "INSERT OR REPLACE INTO transcript_index_state (task_id, event_epoch, indexed_seq)"
            " VALUES (?, 0, ?)",
            (tid, 1 << 30),
        )
    for i in range(3000):
        con.execute(
            "INSERT OR IGNORE INTO agent_sessions"
            " (id, device_id, agent_id, external_ref, first_seen_at, last_seen_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            ("fixture-session-%05d" % i, "fixture-device", "claudecode",
             "fixture-%d" % i, now, now, now),
        )

types = ("message", "tool_use", "tool_result", "notice", "result")
seq = {tid: 0 for tid in tasks}
row_overhead = 250  # b-tree bookkeeping around a row's 4 KB payload
batch = 0
while True:
    current = file_size()
    if current >= low:
        break
    if time.time() > deadline:
        print("FAIL: could not reach %d bytes within 60s (stuck at %d)" % (low, current), file=sys.stderr)
        sys.exit(1)
    # Fill half the remaining distance per batch, so the last batch lands at or
    # below the target and never past the +2% bound.
    rows = max(1, (target - current) // 2 // (4096 + row_overhead))
    payload = (("synthetic startup fixture payload batch %04d " % batch) * 110)[:4096]
    with con:
        for n in range(rows):
            tid = tasks[(batch * rows + n) % len(tasks)]
            seq[tid] += 1
            con.execute(
                "INSERT INTO events (task_id, seq, ts, type, payload) VALUES (?, ?, ?, ?, ?)",
                (tid, seq[tid], now, types[n % len(types)], payload),
            )
    batch += 1

size = file_size()
if size > high:
    print("FAIL: fixture overshot to %d bytes (limit %d)" % (size, high), file=sys.stderr)
    sys.exit(1)
print("  seeded %d tasks, 3000 sessions, %d events; %d bytes"
      % (len(tasks), sum(seq.values()), size))
PY

  assert_fixture_size "$db" "$target" 2 || fail "fixture: database size is outside 2% of $target"
}

say "building ./kin"
(cd "$ROOT" && go build -o "$BIN" ./cmd/kin) || fail "go build ./cmd/kin"

if [[ "$SELFTEST" == "1" ]]; then
  # `process` first: it is the segment that covers exec -> ServeWith and must
  # appear exactly once like every boot phase.
  required="process state-dir lock store-open device adopt agents engine-build engine-start browser listen ready"

  if [[ -n "$FIXTURE_SIZE" ]]; then
    # The refusal path is asserted before anything boots: a state dir under
    # $HOME/.kin must be rejected by the check itself.
    if check_state_dir "$HOME/.kin/startup-baseline-selftest" 2>/dev/null; then
      fail "selftest: check_state_dir accepted a path under \$HOME/.kin"
    fi
  fi

  STATE="$(mktemp -d)"
  KEEP_STATE="$STATE"
  if [[ -n "$FIXTURE_SIZE" ]]; then
    say "selftest: seeding a $FIXTURE_SIZE-byte database, then one cold boot"
    seed_fixture "$STATE" "$FIXTURE_SIZE"
    assert_fixture_size "$STATE/kin.db" "$FIXTURE_SIZE" 5 ||
      fail "selftest: fixture size is outside 5% of $FIXTURE_SIZE"
  else
    say "selftest: one cold boot"
  fi
  run_one "$STATE" cold 1

  missing=""
  for phase in $required; do
    grep -qE "^cold	1	$phase	" "$PHASES" || missing="$missing $phase"
  done
  if [[ -n "$missing" ]]; then
    fail "selftest: missing phase line(s):$missing" "$LOGDIR/cold-1.log"
  fi
  for phase in $required; do
    count="$(awk -F'\t' -v p="$phase" '$1 == "cold" && $2 == "1" && $3 == p { n++ } END { print n + 0 }' "$PHASES")"
    [[ "$count" == "1" ]] || fail "selftest: phase $phase appeared $count times, want 1" "$LOGDIR/cold-1.log"
  done
  echo "ok startup-baseline selftest: 12 phase lines, each once, in a $(awk -F'\t' '$1 == "cold" { print $3 "ms" }' "$RESULTS") boot"
  exit 0
fi

say "cold/warm startup, $RUNS run(s) each"

run_index=1
while [[ "$run_index" -le "$RUNS" ]]; do
  STATE="$(mktemp -d)"
  KEEP_STATE="$STATE"
  say "run $run_index/$RUNS (empty database)"
  run_one "$STATE" cold "$run_index"
  run_one "$STATE" warm "$run_index"
  rm -rf "$STATE"
  KEEP_STATE=""
  run_index=$((run_index + 1))
done

if [[ -n "$FIXTURE_SIZE" ]]; then
  say "cold/warm startup at ~$FIXTURE_SIZE bytes, $RUNS run(s) each"
  run_index=1
  while [[ "$run_index" -le "$RUNS" ]]; do
    STATE="$(mktemp -d)"
    KEEP_STATE="$STATE"
    say "run $run_index/$RUNS (seeded database)"
    seed_fixture "$STATE" "$FIXTURE_SIZE"
    run_one "$STATE" fixture-cold "$run_index"
    run_one "$STATE" fixture-warm "$run_index"
    rm -rf "$STATE"
    KEEP_STATE=""
    run_index=$((run_index + 1))
  done
fi

python3 - "$RESULTS" "$PHASES" "$JSON" "$RUNS" <<'PY'
import json
import statistics
import sys

results_path, phases_path, want_json, runs = sys.argv[1:5]
run_rows = [line.rstrip("\n").split("\t") for line in open(results_path) if line.strip()]
phase_rows = [line.rstrip("\n").split("\t") for line in open(phases_path) if line.strip()]

order = []
by_phase = {}
for kind, run, phase, ms, total in phase_rows:
    if phase not in order:
        order.append(phase)
    by_phase.setdefault((kind, phase), []).append(int(ms))

# Seed boots are setup, not measurements: only these kinds are reported.
kind_labels = [
    ("cold", "cold"),
    ("warm", "warm"),
    ("fixture-cold", "seeded cold"),
    ("fixture-warm", "seeded warm"),
]
present = {kind for kind, *_ in phase_rows}
kinds = [(kind, label) for kind, label in kind_labels if kind in present]

totals = {}
for kind, run, elapsed, log in run_rows:
    totals.setdefault(kind, []).append(int(elapsed))

def median(xs):
    return round(statistics.median(xs)) if xs else None

def fmt(v):
    return "—" if v is None else "%dms" % v

def phase_row(phase):
    row = {"phase": phase}
    for kind, _ in kinds:
        row[kind.replace("-", "_") + "_median_ms"] = median(by_phase.get((kind, phase), []))
    return row

if want_json == "1":
    out = {
        "runs": int(runs),
        "kinds": [kind for kind, _ in kinds],
        "phases": [phase_row(phase) for phase in order],
        "total_to_healthy": {},
    }
    for kind, _ in kinds:
        key = kind.replace("-", "_")
        out["total_to_healthy"][key + "_median_ms"] = median(totals.get(kind, []))
        out["total_to_healthy"][key + "_runs_ms"] = totals.get(kind, [])
    print(json.dumps(out, indent=2))
    sys.exit(0)

width = max([len("phase")] + [len(p) for p in order] + [len("total-to-healthy")]) + 2
print()
print("%-*s" % (width, "phase") + "".join(" %14s" % label for _, label in kinds))
print("%s" % ("-" * width) + "".join(" " + "-" * 14 for _ in kinds))
for row in [phase_row(phase) for phase in order]:
    print("%-*s" % (width, row["phase"]) +
          "".join(" %14s" % fmt(row[kind.replace("-", "_") + "_median_ms"]) for kind, _ in kinds))
print("%s" % ("-" * width) + "".join(" " + "-" * 14 for _ in kinds))
print("%-*s" % (width, "total-to-healthy") +
      "".join(" %14s" % fmt(median(totals.get(kind, []))) for kind, _ in kinds))

for kind, label in kinds:
    print()
    print("%s runs (ms to healthy): %s" % (label, ", ".join(str(v) for v in totals.get(kind, []))))

# The rows of one boot must add up to that boot's wall clock. The only residual
# is flooring: every trace line reports whole milliseconds.
segment_sums = {}
for kind, run, phase, ms, total in phase_rows:
    segment_sums[(kind, run)] = segment_sums.get((kind, run), 0) + int(ms)
residuals = [
    (abs(segment_sums[(kind, run)] - int(elapsed)), kind, run)
    for kind, run, elapsed, log in run_rows
    if (kind, run) in segment_sums
]
if residuals:
    worst = max(residuals)
    print()
    print("segments sum to the wall clock within %dms (worst: %s run %s); "
          "each row floors to whole ms and ready→health is quantised by the 50ms poll"
          % (worst[0], worst[1], worst[2]))
PY
