#!/bin/bash
# test-claim-merged.sh — a lane claim must refuse an item whose PR already merged.
#
# The loop appends one line per landed PR to $STATE/merged.log:
#   YYYY-MM-DD HH:MM PR #N <slug> <item> merged <sha> <url>
# On 2026-11-19 a notification-copy item still read "queued for reproduction" hours
# after its PR merged and shipped; only a manual re-read of product code stopped a
# worker being paid to redo finished work. Prose notes failed four times that day, so
# `claim` and `cloud-claim` refuse an item already in the merged log (exit 9) unless
# the caller asks to deliver it again with --redeliver, or claims a rework (whose PR
# is open by definition).
#
# Hermetic: stubbed sysctl/vm_stat on PATH, temp RSI_STATE and RSI_RUNS, pinned
# thresholds, no network, no gh, no repo writes. Prints "PASS <case>" per case and
# exits non-zero on the first failure.
# Set RSI_TEST_ONLY=<case> to run one case (used to show the red run per case).
set -u
RUNTIME="$(cd "$(dirname "$0")/.." && pwd)"
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
    --paths rsi/runtime/a.py "$@" >"$T/out" 2>"$T/err"
  rc=$?; O="$(cat "$T/out")"; E="$(cat "$T/err")"
}
# cloud_claim <state> <slug> <item> [extra args...] — same capture contract.
cloud_claim() {
  local st="$1" slug="$2" item="$3"; shift 3
  run_lanes "$st" cloud-claim --slug "$slug" --item "$item" --brief "$brief" \
    --paths rsi/runtime/a.py "$@" >"$T/out" 2>"$T/err"
  rc=$?; O="$(cat "$T/out")"; E="$(cat "$T/err")"
}
# merged_line <state> <slug> <item> [pr] [sha] — one well-formed merged.log row.
merged_line() {
  local st="$1" slug="$2" item="$3" pr="${4:-42}" sha="${5:-abc12345}"
  printf '2026-11-19 09:15 PR #%s %s %s merged %s https://example.invalid/pr/%s\n' \
    "$pr" "$slug" "$item" "$sha" "$pr" >> "$st/merged.log"
}

# --- merged-refused ------------------------------------------------------------------------
# The item landed an hour ago; a new claim for the same id must stop before any lane file
# exists, and say which PR and sha it landed in so the dispatcher can be re-read.
if run_case merged-refused; then
  ST="$T/c1"; mkdir -p "$ST"; merged_line "$ST" notif-copy R-alpha 42 abc12345
  claim "$ST" 1 notif-copy R-alpha
  [ "$rc" -eq 9 ] || bad "merged-refused: expected exit 9, got $rc (out: $O / err: $E)"
  grep -q "REFUSED: R-alpha already merged in PR #42" <<<"$O" \
    || bad "merged-refused: refusal does not name PR #42: $O"
  grep -q "abc12345" <<<"$O" || bad "merged-refused: refusal does not name the sha: $O"
  [ ! -f "$ST/lanes/1.json" ] || bad "merged-refused: lane 1 was written anyway"
  ok merged-refused
fi

# --- fresh-claimed -------------------------------------------------------------------------
# Control: an id absent from the merged log claims exactly as before.
if run_case fresh-claimed; then
  ST="$T/c2"; mkdir -p "$ST"; merged_line "$ST" notif-copy R-alpha 42 abc12345
  claim "$ST" 1 notif-fresh R-beta
  [ "$rc" -eq 0 ] && grep -q "CLAIMED lane 1" <<<"$O" \
    || bad "fresh-claimed: claim failed ($rc): $O / $E"
  [ -f "$ST/lanes/1.json" ] || bad "fresh-claimed: no lane file written"
  ok fresh-claimed
fi

# --- redeliver-allowed ---------------------------------------------------------------------
# Asking for it again on purpose is allowed, and says so on stderr (stdout stays parseable
# for the dispatcher).
if run_case redeliver-allowed; then
  ST="$T/c3"; mkdir -p "$ST"; merged_line "$ST" notif-copy R-alpha 42 abc12345
  claim "$ST" 1 notif-copy R-alpha --redeliver
  [ "$rc" -eq 0 ] && grep -q "CLAIMED lane 1" <<<"$O" \
    || bad "redeliver-allowed: claim refused ($rc): $O / $E"
  grep -q "^note: R-alpha merged in PR #42 (abc12345); delivering again on purpose$" <<<"$E" \
    || bad "redeliver-allowed: expected one note line on stderr, got: $E"
  ok redeliver-allowed
fi

# --- rework-bypasses -----------------------------------------------------------------------
# A rework's PR is open by definition, so a merged-log hit for the same item must not block it.
if run_case rework-bypasses; then
  ST="$T/c4"; mkdir -p "$ST"; merged_line "$ST" notif-copy R-alpha 42 abc12345
  claim "$ST" 1 notif-copy R-alpha --mode rework
  [ "$rc" -eq 0 ] && grep -q "CLAIMED lane 1" <<<"$O" \
    || bad "rework-bypasses: rework refused ($rc): $O / $E"
  ok rework-bypasses
fi

# --- cloud-merged-refused / cloud-fresh-claimed --------------------------------------------
# The cloud hand-off is the same chokepoint and needs the same guard.
if run_case cloud-merged-refused; then
  ST="$T/c5"; mkdir -p "$ST"; merged_line "$ST" notif-copy R-alpha 42 abc12345
  cloud_claim "$ST" notif-copy R-alpha
  [ "$rc" -eq 9 ] || bad "cloud-merged-refused: expected exit 9, got $rc (out: $O / err: $E)"
  grep -q "REFUSED: R-alpha already merged in PR #42" <<<"$O" \
    || bad "cloud-merged-refused: refusal does not name PR #42: $O"
  [ ! -f "$ST/cloud/notif-copy.json" ] || bad "cloud-merged-refused: cloud claim was written anyway"
  cloud_claim "$ST" notif-fresh R-beta
  [ "$rc" -eq 0 ] && grep -q "CLOUD-CLAIMED R-beta" <<<"$O" \
    || bad "cloud-fresh-claimed: cloud claim failed ($rc): $O / $E"
  ok cloud-merged-refused
  ok cloud-fresh-claimed
fi

# --- malformed-and-missing-log -------------------------------------------------------------
# Junk lines and a row with no item field must neither crash nor refuse; a fresh state dir
# has no merged.log at all and must fail open.
if run_case malformed-and-missing-log; then
  ST="$T/c6"; mkdir -p "$ST"
  {
    printf 'not a merged line\n'
    printf '\n'
    printf '2026-11-19 09:15 PR #9 slug merged abc url\n'   # only 8 fields: no item field
    printf '2026-11-19 09:16 MERGED #9 slug R-gamma merged abc url\n'
  } >> "$ST/merged.log"
  claim "$ST" 1 gamma R-gamma
  [ "$rc" -eq 0 ] && grep -q "CLAIMED lane 1" <<<"$O" \
    || bad "malformed-and-missing-log: malformed rows refused the claim ($rc): $O / $E"
  ST="$T/c6b"; mkdir -p "$ST"
  claim "$ST" 1 delta R-delta
  [ "$rc" -eq 0 ] && grep -q "CLAIMED lane 1" <<<"$O" \
    || bad "malformed-and-missing-log: missing merged.log refused the claim ($rc): $O / $E"
  ok malformed-and-missing-log
fi

# --- parses-the-item-field -----------------------------------------------------------------
# Field 5 is the slug and field 6 the item. A row whose *slug* is the id under claim must not
# refuse it: only the item field decides.
if run_case parses-the-item-field; then
  ST="$T/c7"; mkdir -p "$ST"
  merged_line "$ST" R-gamma R-other 77 deadbeef
  claim "$ST" 1 R-gamma R-gamma
  [ "$rc" -eq 0 ] && grep -q "CLAIMED lane 1" <<<"$O" \
    || bad "parses-the-item-field: slug field was read as the item ($rc): $O / $E"
  ok parses-the-item-field
fi

[ -z "$ONLY" ] || grep -qx "$ONLY" <<<"merged-refused
fresh-claimed
redeliver-allowed
rework-bypasses
cloud-merged-refused
malformed-and-missing-log
parses-the-item-field" || bad "RSI_TEST_ONLY='$ONLY' matched no case"

echo "test-claim-merged: ALL-PASS"
