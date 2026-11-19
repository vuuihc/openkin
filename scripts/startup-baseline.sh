#!/usr/bin/env bash
# Measure daemon startup, phase by phase, in throwaway state directories.
#
# "Startup is slow" is not actionable until it is a number attributed to a
# phase. This boots the real `kin` binary with KIN_STARTUP_TRACE=1, times the
# gap from spawn to the first successful /api/health, and reports each phase's
# median cold (fresh state dir) and warm (same dir booted again).
#
# Safety: every boot uses a mktemp state dir and a freshly reserved free port.
# It never touches a live daemon, a real state directory, or ~/.kin.
#
# Usage:
#   ./scripts/startup-baseline.sh [--runs N] [--json]
#   ./scripts/startup-baseline.sh --selftest
#
# --selftest boots once and fails unless every phase line appears. It is this
# script's own red/green check; it is deliberately NOT wired into check.sh,
# because it boots a real binary and startup timing is not a CI gate.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNS=3
JSON=0
SELFTEST=0

usage() {
  sed -n '2,20p' "${BASH_SOURCE[0]}" | sed -E 's/^# ?//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --runs) RUNS="${2:-}"; shift 2 ;;
    --runs=*) RUNS="${1#*=}"; shift ;;
    --json) JSON=1; shift ;;
    --selftest) SELFTEST=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if ! [[ "$RUNS" =~ ^[0-9]+$ ]] || [[ "$RUNS" -lt 1 ]]; then
  echo "FAIL: --runs must be a positive integer, got '$RUNS'" >&2
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
  local port base log t0 t1 elapsed i
  port="$(free_port)" || fail "could not pick a free port"
  base="http://127.0.0.1:$port"
  log="$LOGDIR/$kind-$run.log"

  t0="$(now_ms)"
  KIN_STATE_DIR="$state" KIN_PORT="$port" KIN_STARTUP_TRACE=1 \
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
}

run_one() { # state kind run
  boot "$1" "$2" "$3"
  local elapsed
  elapsed="$(awk -F'\t' -v k="$2" -v r="$3" '$1 == k && $2 == r { print $3 }' "$RESULTS")"
  say "  $2 run $3: ${elapsed}ms to healthy"
}

say "building ./kin"
(cd "$ROOT" && go build -o "$BIN" ./cmd/kin) || fail "go build ./cmd/kin"

if [[ "$SELFTEST" == "1" ]]; then
  STATE="$(mktemp -d)"
  KEEP_STATE="$STATE"
  say "selftest: one cold boot"
  run_one "$STATE" cold 1

  required="state-dir lock store-open device adopt agents engine-build engine-start browser listen ready"
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
  echo "ok startup-baseline selftest: 11 phase lines, each once, in a $(awk -F'\t' '$1 == "cold" { print $3 "ms" }' "$RESULTS") boot"
  exit 0
fi

say "cold/warm startup, $RUNS run(s) each"

run_index=1
while [[ "$run_index" -le "$RUNS" ]]; do
  STATE="$(mktemp -d)"
  KEEP_STATE="$STATE"
  say "run $run_index/$RUNS"
  run_one "$STATE" cold "$run_index"
  run_one "$STATE" warm "$run_index"
  rm -rf "$STATE"
  KEEP_STATE=""
  run_index=$((run_index + 1))
done

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

totals = {"cold": [], "warm": []}
for kind, run, elapsed, log in run_rows:
    totals.setdefault(kind, []).append(int(elapsed))

def median(xs):
    return round(statistics.median(xs)) if xs else None

def fmt(v):
    return "—" if v is None else "%dms" % v

def report_rows():
    rows = []
    for phase in order:
        rows.append({
            "phase": phase,
            "cold_median_ms": median(by_phase.get(("cold", phase), [])),
            "warm_median_ms": median(by_phase.get(("warm", phase), [])),
        })
    return rows

if want_json == "1":
    print(json.dumps({
        "runs": int(runs),
        "phases": report_rows(),
        "total_to_healthy": {
            "cold_median_ms": median(totals.get("cold", [])),
            "warm_median_ms": median(totals.get("warm", [])),
            "cold_runs_ms": totals.get("cold", []),
            "warm_runs_ms": totals.get("warm", []),
        },
    }, indent=2))
    sys.exit(0)

width = max([len("phase")] + [len(p) for p in order] + [len("total-to-healthy")]) + 2
print()
print("%-*s %14s %14s" % (width, "phase", "cold median", "warm median"))
print("%s %s %s" % ("-" * width, "-" * 14, "-" * 14))
for row in report_rows():
    print("%-*s %14s %14s" % (width, row["phase"], fmt(row["cold_median_ms"]), fmt(row["warm_median_ms"])))
print("%s %s %s" % ("-" * width, "-" * 14, "-" * 14))
print("%-*s %14s %14s" % (
    width, "total-to-healthy",
    fmt(median(totals.get("cold", []))),
    fmt(median(totals.get("warm", []))),
))
print()
print("cold runs (ms to healthy): %s" % ", ".join(str(v) for v in totals.get("cold", [])))
print("warm runs (ms to healthy): %s" % ", ".join(str(v) for v in totals.get("warm", [])))
PY
