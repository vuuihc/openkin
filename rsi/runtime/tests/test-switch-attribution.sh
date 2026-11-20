#!/bin/bash
# test-switch-attribution.sh — the area switch's split must be printed, and never faked.
#
# `switch-latency.mjs --print` is the claim check for docs/plans/2026-11-20-switch-latency.md:
# the document's numbers have to be readable back from the JSON without a daemon or a
# browser. That makes the printer the place where a half-measured run must stay visible:
#
#   - a leg whose runs all attributed prints the nearest-rank split per phase;
#   - a partly attributed leg says `attributed n/N (k unmeasured)` and never prints a
#     split over more runs than it names;
#   - a leg with no attributed run prints `attributed 0/N (<reason>)` and no phase line
#     at all, so a run that could not split cannot be read as a fast read or a fast render;
#   - a guard JSON still exits 2 with its recorded guard, never a table;
#   - a JSON from before attribution existed prints table 1 byte for byte as it did.
#
# Nearest-rank p50/p90 are computed by hand from the fixture runs, not by calling the
# script's stats(): with 5 runs p50 is the 3rd smallest and p90 the 5th.
#
# Hermetic: bash + node only, fixtures in a mktemp dir. No daemon, no browser, no
# network, no rsi/state. Prints "PASS <case>" per case; every case runs even when an
# earlier one fails, and the exit status is non-zero if any did.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
SCRIPT="$ROOT/rsi/runtime/ux/switch-latency.mjs"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT

FAILED=0
CASE_FAILED=0
name=""
fail() { echo "FAIL $name: $*" >&2; CASE_FAILED=1; FAILED=1; }
start() { name="$1"; CASE_FAILED=0; echo "CASE $name"; }
finish() {
  if [ "$CASE_FAILED" -eq 0 ]; then echo "PASS $name"; else echo "FAIL $name" >&2; fi
}
# print_json <fixture> — run the claim check; stdout/stderr land in $T/out, $T/err.
print_json() {
  node "$SCRIPT" --print "$1" > "$T/out" 2> "$T/err"
  status=$?
}
expect_contains() { grep -Fq -- "$1" "$T/out" || fail "output does not contain: $1"; }
expect_absent() { if grep -Fq -- "$1" "$T/out"; then fail "output must not contain: $1"; fi; }
expect_status() { [ "$status" -eq "$1" ] || fail "exit $status, want $1 (stderr: $(cat "$T/err"))"; }

# --- 1. a fully attributed leg prints the exact nearest-rank split -------------------------------
# dispatch [3,4,5,6,7] -> p50 5, p90 7; read [50,55,60,65,70] -> p50 60, p90 70;
# render [20,25,30,35,40] -> p50 30, p90 40. Totals are the per-run sums.
start "attributed-split-prints"
cat > "$T/all.json" <<'EOF'
{"schema": 1, "sha": "aaaaaaa", "runs": 5, "entry": "/assets/index-test.js", "machine": {"platform": "darwin", "release": "test", "arch": "arm64", "cpus": 8}, "node": "v22.0.0", "loadavgBefore": [0.5, 0.6, 0.7], "loadavgAfter": [0.5, 0.6, 0.7], "legs": {
  "mac-area-to-area": {"viewport": "1100x760", "p50": 95, "p90": 116, "min": 73, "max": 116, "runs": [73, 84, 95, 106, 116],
    "attribution": {"total": 5, "attributed": 5,
      "dispatch": {"runs": [3, 4, 5, 6, 7], "p50": 5, "p90": 7, "min": 3, "max": 7},
      "read": {"runs": [50, 55, 60, 65, 70], "p50": 60, "p90": 70, "min": 50, "max": 70},
      "render": {"runs": [20, 25, 30, 35, 40], "p50": 30, "p90": 40, "min": 20, "max": 40},
      "unattributed": []}}
}}
EOF
print_json "$T/all.json"
expect_status 0
expect_contains "attr mac-area-to-area attributed 5/5 dispatch p50 5 p90 7 · read p50 60 p90 70 · render p50 30 p90 40"
expect_absent "unmeasured"
finish

# --- 2. a partly attributed leg names the shortfall and splits only over the measured runs -------
# Run 3 is unattributed; dispatch [3,4,6,7] -> p50 4, p90 7; read [50,55,65,70] -> p50 55, p90 70;
# render [20,25,35,40] -> p50 25, p90 40.
start "partial-attribution-is-honest"
cat > "$T/partial.json" <<'EOF'
{"schema": 1, "sha": "bbbbbbb", "runs": 5, "entry": "/assets/index-test.js", "machine": {"platform": "darwin", "release": "test", "arch": "arm64", "cpus": 8}, "node": "v22.0.0", "loadavgBefore": [0.5, 0.6, 0.7], "loadavgAfter": [0.5, 0.6, 0.7], "legs": {
  "mac-area-to-area": {"viewport": "1100x760", "p50": 95, "p90": 116, "min": 73, "max": 116, "runs": [73, 84, 95, 106, 116],
    "attribution": {"total": 5, "attributed": 4,
      "dispatch": {"runs": [3, 4, 6, 7], "p50": 4, "p90": 7, "min": 3, "max": 7},
      "read": {"runs": [50, 55, 65, 70], "p50": 55, "p90": 70, "min": 50, "max": 70},
      "render": {"runs": [20, 25, 35, 40], "p50": 25, "p90": 40, "min": 20, "max": 40},
      "unattributed": [{"run": 3, "reason": "no /api/projects resource entry after the press"}]}}
}}
EOF
print_json "$T/partial.json"
expect_status 0
expect_contains "attr mac-area-to-area attributed 4/5 (1 unmeasured) dispatch p50 4 p90 7 · read p50 55 p90 70 · render p50 25 p90 40"
finish

# --- 3. no attributed run prints the reason and no phase numbers --------------------------------
start "no-attribution-prints-no-split"
cat > "$T/none.json" <<'EOF'
{"schema": 1, "sha": "ccccccc", "runs": 5, "entry": "/assets/index-test.js", "machine": {"platform": "darwin", "release": "test", "arch": "arm64", "cpus": 8}, "node": "v22.0.0", "loadavgBefore": [0.5, 0.6, 0.7], "loadavgAfter": [0.5, 0.6, 0.7], "legs": {
  "mac-area-to-area": {"viewport": "1100x760", "p50": 95, "p90": 116, "min": 73, "max": 116, "runs": [73, 84, 95, 106, 116],
    "attribution": {"total": 5, "attributed": 0, "reason": "no /api/projects resource entry after the press"}},
  "mac-chat-to-chat": {"viewport": "1100x760", "p50": 55, "p90": 70, "min": 40, "max": 70, "runs": [40, 50, 55, 60, 70],
    "attribution": {"total": 5, "attributed": 0, "reason": "no data read named for this leg"}}
}}
EOF
print_json "$T/none.json"
expect_status 0
expect_contains "attr mac-area-to-area attributed 0/5 (no /api/projects resource entry after the press)"
expect_contains "attr mac-chat-to-chat attributed 0/5 (no data read named for this leg)"
expect_absent "dispatch p50"
finish

# --- 4. a guard JSON is not a table -------------------------------------------------------------
start "guard-fixture-exits-2"
cat > "$T/guard.json" <<'EOF'
{"schema": 1, "sha": "ddddddd", "runs": 5, "legs": {}, "guard": {"code": "a", "name": "destination-never-appeared", "detail": "the destination never became visible"}}
EOF
print_json "$T/guard.json"
expect_status 2
grep -Fq "this JSON recorded a guard, not numbers:" "$T/err" || fail "stderr does not name the guard: $(cat "$T/err")"
finish

# --- 5. a JSON from before attribution still prints table 1 unchanged ---------------------------
start "legacy-json-table-unchanged"
cat > "$T/legacy.json" <<'EOF'
{"schema": 1, "sha": "eeeeeee", "runs": 5, "entry": "/assets/index-test.js", "machine": {"platform": "darwin", "release": "test", "arch": "arm64", "cpus": 8}, "node": "v22.0.0", "loadavgBefore": [0.5, 0.6, 0.7], "loadavgAfter": [0.5, 0.6, 0.7], "legs": {
  "mac-area-to-area": {"viewport": "1100x760", "p50": 95, "p90": 116, "min": 73, "max": 116, "runs": [73, 84, 95, 106, 116]}
}}
EOF
print_json "$T/legacy.json"
expect_status 0
expect_contains "switch latency — eeeeeee · 5 measured runs + 1 warm-up per leg · nearest-rank p50/p90 · ms"
# The table's column layout is its public shape: 21 + 12 + 6 + 8 + 8 + 8.
expect_contains "$(printf '%-21s%-12s%6s%8s%8s%8s' 'mac-area-to-area' '1100x760' 95 116 73 116)"
expect_contains "runs mac-area-to-area: 73, 84, 95, 106, 116"
expect_contains "loadavg before 0.5 0.6 0.7 · after 0.5 0.6 0.7 (1m 5m 15m)"
expect_absent "attr "
finish

if [ "$FAILED" -ne 0 ]; then echo "switch-attribution: failed" >&2; exit 1; fi
echo "ok switch-attribution (5 cases)"
