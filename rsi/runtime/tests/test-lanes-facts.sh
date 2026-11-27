#!/bin/bash
# test-lanes-facts.sh — `lanes.py facts` prints the loop's mutable state as one pasted block.
#
# STATUS.md is rewritten by a director model that used to characterise the mutable
# directories from prose. On 2026-11-20 it reported "sendback queue empty" at 16:27 while a
# rework file had been waiting since 16:23 — the fourth false line that day. The fix is one
# command whose output is copied verbatim: the sendback queue, the active lanes, the cloud
# claims and the merged tail, read once, each value stamped with the read time.
#
# The block is a stable key=value contract, one key per line:
#   now= state= sendback_pending= sendback= lanes_active= lanes= cloud_claims= cloud=
#   merged_today= merged_last=
# `unknown` is not `0` and not `none`: a queue path that exists but cannot be read as a
# directory prints unknown, so a broken read can never masquerade as an empty queue.
#
# Hermetic: temp RSI_STATE, pinned --now seam, no network, no gh, no model calls.
# Prints "PASS <case>" per case and exits non-zero on the first failure.
# Set RSI_TEST_ONLY=<case> to run one case.
set -u
RUNTIME="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
ONLY="${RSI_TEST_ONLY:-}"
ok() { echo "PASS $*"; }; bad() { echo "FAIL $*" >&2; exit 1; }
run_case() { [ -z "$ONLY" ] || [ "$1" = "$ONLY" ]; }
CASE="?"

# 2026-11-20 10:00:00 +08:00 — the sealed clock every case is read against.
NOW="$(python3 - <<'PY'
import datetime
print(int(datetime.datetime(2026, 11, 20, 10, 0, 0,
                             tzinfo=datetime.timezone(datetime.timedelta(hours=8))).timestamp()))
PY
)"

run_facts() {
  local st="$1"; shift
  RSI_STATE="$st" RSI_RUNS="$T/runs" python3 "$RUNTIME/lanes.py" facts --now "$NOW" "$@" \
    >"$T/out" 2>"$T/err"
  rc=$?; O="$(cat "$T/out")"; E="$(cat "$T/err")"
}
field() { sed -n "s/^$1=//p" <<<"$O"; }
# run_lanes <state> <args...> — any lanes.py invocation against a caller-owned state dir.
run_lanes() {
  local st="$1"; shift
  RSI_STATE="$st" RSI_RUNS="$T/runs" python3 "$RUNTIME/lanes.py" "$@" >"$T/out" 2>"$T/err"
  rc=$?; O="$(cat "$T/out")"; E="$(cat "$T/err")"
}
want() {
  local k="$1" v="$2" got
  got="$(field "$k")"
  [ "$got" = "$v" ] || bad "$CASE: $k: want '$v', got '$got' (out: $O / err: $E)"
}
# sendback <state> <slug> <minutes-before-now> [extra lines...] — a queued rework file
# with a pinned mtime. `sentinel` at minutes=0 means "exactly now".
sendback() {
  mkdir -p "$1/sendback"
  python3 - "$1/sendback/$2.md" "$3" "$NOW" "${@:4}" <<'PY'
import os, sys
path, mins, now = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
body = "item: R-x\nattempt: 1\n" + "".join(l + "\n" for l in sys.argv[4:])
open(path, "w").write(body)
os.utime(path, (now - mins * 60, now - mins * 60))
PY
}
# hold_lane <state> <lane> <item> <slug> — an active claim (real clock: is_active reads it).
hold_lane() {
  mkdir -p "$1/lanes"
  python3 - "$1" "$2" "$3" "$4" <<'PY'
import json, sys, time
st, lane, item, slug = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
json.dump({"lane": lane, "slug": slug, "item": item, "brief": "/dev/null", "mode": "new",
           "paths": ["rsi/runtime/a.py"], "status": "claimed", "claimed_at": time.time()},
          open(f"{st}/lanes/{lane}.json", "w"))
PY
}

# --- empty -----------------------------------------------------------------------------------
# A fresh state dir is genuinely empty: every count is 0 and every list is none. The exact
# block is compared, so the key order is part of the contract too.
if run_case empty; then
  CASE=empty; ST="$T/empty"; mkdir -p "$ST"
  run_facts "$ST"
  [ "$rc" -eq 0 ] || bad "empty: expected exit 0, got $rc ($E)"
  expected="now=2026-11-20T10:00:00+08:00
state=ok
sendback_pending=0
sendback=none
lanes_active=0
lanes=none
cloud_claims=0
cloud=none
merged_today=0
merged_last=none"
  [ "$O" = "$expected" ] || bad "empty: block differs (got: $O)"
  ok empty
fi

# --- three -----------------------------------------------------------------------------------
# Three queued reworks, oldest first — the order unclaimed_sendbacks() already returns and the
# order the rework dispatcher takes them in — with ages measured from --now. An archived
# sendback under sendback/done/ is not in the queue and must not be counted.
# (The brief's example writes `a.md:0m,b.md:30m,c.md:90m`; that lists the newest first, which
# contradicts its own "oldest first" contract line, so the fixture names files by age instead.)
if run_case three; then
  CASE=three; ST="$T/three"; mkdir -p "$ST/sendback/done"
  sendback "$ST" old 90; sendback "$ST" mid 30; sendback "$ST" new 0
  printf 'item: R-gone\n' > "$ST/sendback/done/x.md"
  run_facts "$ST"
  [ "$rc" -eq 0 ] || bad "three: expected exit 0, got $rc ($E)"
  want state ok
  want sendback_pending 3
  want sendback "old.md:90m,mid.md:30m,new.md:0m"
  ok three
fi

# --- active-lane -----------------------------------------------------------------------------
# A sendback whose slug an active lane already runs is not waiting (the canonical
# unclaimed_sendbacks() filter); the lane itself is reported with its item.
if run_case active-lane; then
  CASE=active-lane; ST="$T/active"; mkdir -p "$ST"
  sendback "$ST" old 90; sendback "$ST" mid 30; sendback "$ST" new 0
  hold_lane "$ST" 1 R-x mid
  run_facts "$ST"
  [ "$rc" -eq 0 ] || bad "active-lane: expected exit 0, got $rc ($E)"
  want sendback_pending 2
  want sendback "old.md:90m,new.md:0m"
  want lanes_active 1
  want lanes "R-x:mid"
  ok active-lane
fi

# --- size-ok ---------------------------------------------------------------------------------
# A size-only sendback whose cap the CEO waived (`source: hold-size` plus
# merge/<slug>.size-ok) is skipped by autofill, so it is not waiting either.
if run_case size-ok; then
  CASE=size-ok; ST="$T/sizeok"; mkdir -p "$ST/merge"
  sendback "$ST" old 90; sendback "$ST" size-only 5 "source: hold-size"
  : > "$ST/merge/size-only.size-ok"
  run_facts "$ST"
  [ "$rc" -eq 0 ] || bad "size-ok: expected exit 0, got $rc ($E)"
  want sendback_pending 1
  want sendback "old.md:90m"
  ok size-ok
fi

# --- not-a-dir -------------------------------------------------------------------------------
# sendback exists but is a regular file: the read failed, so the block says unknown and
# still exits 0. Printing 0/none here is the defect this seam exists to prevent.
if run_case not-a-dir; then
  CASE=not-a-dir; ST="$T/notadir"; mkdir -p "$ST"
  printf 'not a directory\n' > "$ST/sendback"
  run_facts "$ST"
  [ "$rc" -eq 0 ] || bad "not-a-dir: expected exit 0, got $rc ($E)"
  want state ok
  want sendback_pending unknown
  want sendback unknown
  ok not-a-dir
fi

# --- merged ----------------------------------------------------------------------------------
# Only well-formed rows dated today (Asia/Singapore) count; yesterday's row and the
# malformed row are ignored, and the tail names the last today row.
if run_case merged; then
  CASE=merged; ST="$T/merged"; mkdir -p "$ST"
  cat > "$ST/merged.log" <<'LOG'
2026-11-20 09:15 PR #41 alpha R-alpha merged aaaa1111 https://example.invalid/pr/41
2026-11-20 09:40 PR #42 beta R-beta merged bbbb2222 https://example.invalid/pr/42
2026-11-19 23:50 PR #40 gamma R-gamma merged cccc3333 https://example.invalid/pr/40
2026-11-20 09:50 this line is malformed
LOG
  run_facts "$ST"
  [ "$rc" -eq 0 ] || bad "merged: expected exit 0, got $rc ($E)"
  want merged_today 2
  want merged_last "beta bbbb2222 at 09:40"
  ok merged
fi

# --- unknown-state ---------------------------------------------------------------------------
# $RSI_STATE itself is a file: nothing can be read, so every key is unknown and the exit
# code is 2. This is the one case that is not exit 0.
if run_case unknown-state; then
  CASE=unknown-state; ST="$T/notastate"; printf 'not a state dir\n' > "$ST"
  run_facts "$ST"
  [ "$rc" -eq 2 ] || bad "unknown-state: expected exit 2, got $rc ($O / $E)"
  for k in state sendback_pending sendback lanes_active lanes cloud_claims cloud \
           merged_today merged_last; do
    want "$k" unknown
  done
  ok unknown-state
fi

# --- unknown-subcommand-names-the-withdrawal -------------------------------------------------
# The ledgers written since 2026-11-27 17:19 record `lanes.py release <lane>` to undo a
# claim, and no such subcommand has ever existed. The error path must name the command that
# actually withdraws a claim, verbatim, so the reader of the ledger is not left with argparse's
# bare choices list.
if run_case unknown-subcommand-names-the-withdrawal; then
  CASE=unknown-subcommand-names-the-withdrawal; ST="$T/unknown"; mkdir -p "$ST"
  run_lanes "$ST" release 2
  [ "$rc" -eq 2 ] || bad "$CASE: expected exit 2, got $rc ($O / $E)"
  grep -q 'unknown subcommand' <<<"$E" \
    || bad "$CASE: stderr does not say 'unknown subcommand' (err: $E)"
  grep -q 'release' <<<"$E" || bad "$CASE: stderr does not name the typed subcommand (err: $E)"
  grep -qF 'lanes.py finish <lane> --status cancelled --note "<why>"' <<<"$E" \
    || bad "$CASE: stderr lacks the withdrawal command (err: $E)"
  ok "$CASE"
fi

# --- unknown-subcommand-has-no-side-effect ---------------------------------------------------
# A mistyped command is a read-only dead end: the hint is written to stderr before anything
# touches $RSI_STATE, so an empty state dir stays empty.
if run_case unknown-subcommand-has-no-side-effect; then
  CASE=unknown-subcommand-has-no-side-effect; ST="$T/unknown-side-effect"; mkdir -p "$ST"
  run_lanes "$ST" release 2
  [ "$rc" -eq 2 ] || bad "$CASE: expected exit 2, got $rc ($O / $E)"
  for d in lanes cloud sendback; do
    [ ! -e "$ST/$d" ] || bad "$CASE: mistyped command created $d/ ($(ls -A "$ST"))"
  done
  [ -z "$(ls -A "$ST")" ] || bad "$CASE: state dir gained entries ($(ls -A "$ST"))"
  ok "$CASE"
fi

# --- known-subcommands-unchanged -------------------------------------------------------------
# --help and a real subcommand keep argparse's behaviour: no hint on the error path, and the
# facts block is byte-identical to the empty case.
if run_case known-subcommands-unchanged; then
  CASE=known-subcommands-unchanged; ST="$T/known-unchanged"; mkdir -p "$ST"
  run_lanes "$ST" --help
  [ "$rc" -eq 0 ] || bad "$CASE: --help expected exit 0, got $rc ($O / $E)"
  case "$E" in
    *"withdraw a claim:"*) bad "$CASE: --help printed the unknown-subcommand hint (err: $E)" ;;
  esac
  run_lanes "$ST" facts --now "$NOW"
  [ "$rc" -eq 0 ] || bad "$CASE: facts expected exit 0, got $rc ($O / $E)"
  [ -z "$E" ] || bad "$CASE: facts wrote to stderr ($E)"
  expected="now=2026-11-20T10:00:00+08:00
state=ok
sendback_pending=0
sendback=none
lanes_active=0
lanes=none
cloud_claims=0
cloud=none
merged_today=0
merged_last=none"
  [ "$O" = "$expected" ] || bad "$CASE: facts block differs (got: $O)"
  ok "$CASE"
fi

# --- no-arguments-still-exits-2 --------------------------------------------------------------
# Argparse's required-subparser behaviour is untouched: no subcommand is still usage error 2,
# and the hint is not printed for a call that names no subcommand at all.
if run_case no-arguments-still-exits-2; then
  CASE=no-arguments-still-exits-2; ST="$T/no-args"; mkdir -p "$ST"
  run_lanes "$ST"
  [ "$rc" -eq 2 ] || bad "$CASE: expected exit 2, got $rc ($O / $E)"
  ok "$CASE"
fi

echo "all cases passed"
