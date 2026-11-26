#!/bin/bash
# test-lanes-claim-paths.sh — a whitespace-joined --paths argument must be split, or refused.
#
# A caller that passes one quoted "$PATHS" delivers a single argv word. `claim` used to
# record that whole 30-path blob as one path, which can never match a file, so
# lane.sh --worker-contract-check called every touched file outside the footprint and the
# lane lost its claim and went idle for a fill cycle (followup 1832, 2026-11-24 07:36:
# row 3 `delete-pagesb2c-del`). The argument is now split on whitespace; a joined argument
# that splits into a non-path token is refused (exit 2) instead of silently claiming a
# narrower scope than the caller asked for. A tracked path that really contains a space stays
# one path: `git diff --raw` hands it to claim as one argv word, so splitting it would refuse a
# file that exists.
#
# Hermetic: stubbed sysctl/vm_stat on PATH, temp RSI_STATE and RSI_RUNS, pinned
# thresholds, no network, no gh, no repo writes. Prints "PASS <case>" per case and
# exits non-zero on the first failure.
# Set RSI_TEST_ONLY=<case> to run one case (used to show the red run per case).
set -u
RUNTIME="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$RUNTIME/../.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
ONLY="${RSI_TEST_ONLY:-}"
ok() { echo "PASS $*"; }; bad() { echo "FAIL $*" >&2; exit 1; }
# run_case <case> — skip unless RSI_TEST_ONLY names it.
run_case() { [ -z "$ONLY" ] || [ "$1" = "$ONLY" ]; }

# --- stubs ---------------------------------------------------------------------------------
# sysctl answers the swapusage and pressure probes; anything else fails like an unknown key
# so an unexpected probe cannot silently read the real machine.
mkdir -p "$T/bin"
cat > "$T/bin/sysctl" <<'SH'
#!/bin/sh
case "${2:-}" in
  vm.swapusage) echo "vm.swapusage: total = 4096.00M  used = 100.00M  free = 3996.00M" ;;
  kern.memorystatus_vm_pressure_level) echo 1 ;;
  *) exit 1 ;;
esac
SH
# vm_stat reports 4 equal page buckets summing to 5900 MB (page size 16384 → 64 pages/MB).
cat > "$T/bin/vm_stat" <<'SH'
#!/bin/sh
p=$(( 5900 * 64 )); q=$(( p / 4 ))
cat <<EOF
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               ${q}.
Pages inactive:                           ${q}.
Pages speculative:                        ${q}.
Pages purgeable:                          ${q}.
EOF
SH
chmod +x "$T/bin/sysctl" "$T/bin/vm_stat"

# run_lanes <state> -- lanes.py args. Every threshold is pinned so neither a loaded machine
# nor an exported RSI_* value can move the outcome.
run_lanes() {
  local st="$1"; shift
  RSI_STATE="$st" RSI_RUNS="$T/runs" PATH="$T/bin:$PATH" \
  RSI_MAX_LANES=2 RSI_LOAD_MAX=9999 RSI_MEM_AVAIL_MIN_MB=0 RSI_SWAP_USED_MAX_MB=999999999 \
  RSI_LANE2_MEM_MIN_MB=0 RSI_LANE2_PRESSURE_MAX=99 RSI_LANE2_SWAP_FREE_MIN_MB=0 \
  python3 "$RUNTIME/lanes.py" "$@"
}
brief="$T/brief.md"; printf 'brief\n' > "$brief"

# claim <state> <lane> <slug> <item> [extra args...] — sets O (stdout), E (stderr), rc.
# Never aborts, so a refusal can be asserted.
claim() {
  local st="$1" lane="$2" slug="$3" item="$4"; shift 4
  run_lanes "$st" claim "$lane" --slug "$slug" --item "$item" --brief "$brief" \
    "$@" >"$T/out" 2>"$T/err"
  rc=$?; O="$(cat "$T/out")"; E="$(cat "$T/err")"
}
# cloud_claim <state> <slug> <item> [extra args...] — same capture contract.
cloud_claim() {
  local st="$1" slug="$2" item="$3"; shift 3
  run_lanes "$st" cloud-claim --slug "$slug" --item "$item" --brief "$brief" \
    "$@" >"$T/out" 2>"$T/err"
  rc=$?; O="$(cat "$T/out")"; E="$(cat "$T/err")"
}
# recorded_paths <json-file> — the `paths` list as compact JSON, read as a list (never a
# substring), so a blob holding the same characters cannot satisfy a two-path assertion.
recorded_paths() {
  python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))["paths"]))' "$1"
}

# --- test_joined_argument_is_split ----------------------------------------------------------------
# One quoted argv word holding two paths must record two paths, in order.
if run_case test_joined_argument_is_split; then
  ST="$T/c1"; mkdir -p "$ST"
  claim "$ST" 1 path-split R-paths --paths "rsi/runtime/a.py rsi/runtime/b.py"
  [ "$rc" -eq 0 ] && grep -q "CLAIMED lane 1" <<<"$O" \
    || bad "test_joined_argument_is_split: claim failed ($rc): $O / $E"
  got="$(recorded_paths "$ST/lanes/1.json")"
  [ "$got" = '["rsi/runtime/a.py", "rsi/runtime/b.py"]' ] \
    || bad "test_joined_argument_is_split: recorded paths are not the two split paths: $got"
  ok test_joined_argument_is_split
fi

# --- test_joined_cloud_argument_is_split ----------------------------------------------------------
# The cloud hand-off is the same chokepoint and must record the same two paths.
if run_case test_joined_cloud_argument_is_split; then
  ST="$T/c2"; mkdir -p "$ST"
  cloud_claim "$ST" path-split R-paths --paths "rsi/runtime/a.py rsi/runtime/b.py"
  [ "$rc" -eq 0 ] && grep -q "CLOUD-CLAIMED" <<<"$O" \
    || bad "test_joined_cloud_argument_is_split: cloud claim failed ($rc): $O / $E"
  got="$(recorded_paths "$ST/cloud/path-split.json")"
  [ "$got" = '["rsi/runtime/a.py", "rsi/runtime/b.py"]' ] \
    || bad "test_joined_cloud_argument_is_split: recorded paths are not the two split paths: $got"
  ok test_joined_cloud_argument_is_split
fi

# --- test_no_path_element_contains_a_space --------------------------------------------------------
# The recorded list must not keep the joined blob: no element may contain whitespace.
if run_case test_no_path_element_contains_a_space; then
  ST="$T/c3"; mkdir -p "$ST"
  claim "$ST" 1 path-split R-paths --paths "rsi/runtime/a.py rsi/runtime/b.py"
  [ "$rc" -eq 0 ] || bad "test_no_path_element_contains_a_space: claim failed ($rc): $O / $E"
  python3 -c '
import json, sys
paths = json.load(open(sys.argv[1]))["paths"]
bad = [p for p in paths if any(c.isspace() for c in p)]
sys.exit(1 if bad else 0)' "$ST/lanes/1.json" \
    || bad "test_no_path_element_contains_a_space: an element still holds whitespace: $(recorded_paths "$ST/lanes/1.json")"
  ok test_no_path_element_contains_a_space
fi

# --- test_joined_invalid_token_refused ------------------------------------------------------------
# A joined argument holding prose must fail closed: exit 2, name the offending token, and
# write no lane record. Silently dropping the token would claim less than the caller asked.
if run_case test_joined_invalid_token_refused; then
  ST="$T/c4"; mkdir -p "$ST"
  claim "$ST" 1 path-split R-paths --paths "rsi/runtime/a.py thing"
  [ "$rc" -eq 2 ] || bad "test_joined_invalid_token_refused: expected exit 2, got $rc (out: $O / err: $E)"
  grep -q "REFUSED: --paths argument contains whitespace and splits into a non-path token: 'thing' (from 'rsi/runtime/a.py thing')" <<<"$O" \
    || bad "test_joined_invalid_token_refused: refusal does not quote the token and the argument: $O"
  [ ! -f "$ST/lanes/1.json" ] || bad "test_joined_invalid_token_refused: lane 1 was written anyway"
  ok test_joined_invalid_token_refused
fi

# --- test_plain_multi_arg_unchanged ---------------------------------------------------------------
# Control: two separate argv words after one --paths still claim, with the same two paths.
if run_case test_plain_multi_arg_unchanged; then
  ST="$T/c5"; mkdir -p "$ST"
  claim "$ST" 1 path-plain R-paths --paths rsi/runtime/a.py rsi/runtime/b.py
  [ "$rc" -eq 0 ] && grep -q "CLAIMED lane 1" <<<"$O" \
    || bad "test_plain_multi_arg_unchanged: claim failed ($rc): $O / $E"
  got="$(recorded_paths "$ST/lanes/1.json")"
  [ "$got" = '["rsi/runtime/a.py", "rsi/runtime/b.py"]' ] \
    || bad "test_plain_multi_arg_unchanged: recorded paths changed: $got"
  ok test_plain_multi_arg_unchanged
fi

# --- test_ignored_path_still_dropped --------------------------------------------------------------
# The split must not resurrect an IGNORED path (web/dist/index.html) as a claim.
if run_case test_ignored_path_still_dropped; then
  ST="$T/c6"; mkdir -p "$ST"
  claim "$ST" 1 path-ignored R-paths --paths "web/dist/index.html rsi/runtime/a.py"
  [ "$rc" -eq 0 ] && grep -q "CLAIMED lane 1" <<<"$O" \
    || bad "test_ignored_path_still_dropped: claim failed ($rc): $O / $E"
  got="$(recorded_paths "$ST/lanes/1.json")"
  [ "$got" = '["rsi/runtime/a.py"]' ] \
    || bad "test_ignored_path_still_dropped: IGNORED path was recorded: $got"
  ok test_ignored_path_still_dropped
fi

# --- test_real_path_with_space_stays_atomic --------------------------------------------------
# A tracked path containing spaces arrives as one argv word from `git diff --raw`; it must be
# recorded as that one path, not refused as a joined argument.
if run_case test_real_path_with_space_stays_atomic; then
  ST="$T/c7"; mkdir -p "$ST"
  spaced="design/Kin Main Window (standalone).orig.html"
  [ -f "$REPO/$spaced" ] || bad "test_real_path_with_space_stays_atomic: fixture path missing: $spaced"
  claim "$ST" 1 path-spaced R-paths --paths "$spaced"
  [ "$rc" -eq 0 ] && grep -q "CLAIMED lane 1" <<<"$O" \
    || bad "test_real_path_with_space_stays_atomic: claim failed ($rc): $O / $E"
  got="$(recorded_paths "$ST/lanes/1.json")"
  [ "$got" = "[\"$spaced\"]" ] \
    || bad "test_real_path_with_space_stays_atomic: the spaced path was split or dropped: $got"
  ok test_real_path_with_space_stays_atomic
fi

# --- test_joined_cloud_invalid_token_refused -------------------------------------------------
# The same fail-closed guard through the cloud hand-off: exit 2, names the token, writes no record.
if run_case test_joined_cloud_invalid_token_refused; then
  ST="$T/c8"; mkdir -p "$ST"
  cloud_claim "$ST" path-split R-paths --paths "rsi/runtime/a.py thing"
  [ "$rc" -eq 2 ] || bad "test_joined_cloud_invalid_token_refused: expected exit 2, got $rc (out: $O / err: $E)"
  grep -q "non-path token: 'thing'" <<<"$O" \
    || bad "test_joined_cloud_invalid_token_refused: refusal does not quote the token: $O"
  [ ! -f "$ST/cloud/path-split.json" ] || bad "test_joined_cloud_invalid_token_refused: cloud record was written anyway"
  ok test_joined_cloud_invalid_token_refused
fi
