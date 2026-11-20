#!/bin/bash
# test-lane-sendback-reserve.sh — an unclaimed rework keeps the last usable lane.
#
# A merge cycle can write a sendback while the fill director is still running: on 2026-11-20 the
# fill started 08:56, merge sent #436 back at 09:05 and #435 at 09:03, and the director then
# claimed both lanes for NEW slices at 09:06. The merge lane's own `autofill rest` printed
# "no idle lane for rework link-exchange-bound", so two open PRs sat another 40 minutes while two
# fresh slices ran — the 2026-11-18 shape (#264 waited behind two 45-min slices) again. The
# director prompt already said "leave the lane for autofill"; prose lost the race to the clock.
#
# `lanes.py claim` now refuses a NEW claim (exit 10) only when it would leave no usable lane for a
# sendback that has no lane yet. Reworks keep taking the last lane, and with lanes to spare the
# guard changes nothing. The refused caller is told to run `lane.sh autofill`, which pulse
# already does right after `start-claimed`.
#
# Hermetic: stubbed sysctl/vm_stat on PATH, temp RSI_STATE, pinned thresholds, no network, no gh,
# no model calls. Prints "PASS <case>" per case and exits non-zero on the first failure.
# Set RSI_TEST_ONLY=<case> to run one case (used to show the red run per case).
set -u
RUNTIME="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
ONLY="${RSI_TEST_ONLY:-}"
ok() { echo "PASS $*"; }; bad() { echo "FAIL $*" >&2; exit 1; }
run_case() { [ -z "$ONLY" ] || [ "$1" = "$ONLY" ]; }

# --- stubs ---------------------------------------------------------------------------------
# sysctl answers the swapusage and pressure probes, anything else fails like an unknown key.
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

run_lanes() {
  local st="$1"; shift
  RSI_STATE="$st" RSI_RUNS="$T/runs" PATH="$T/bin:$PATH" \
  RSI_MAX_LANES=2 RSI_LOAD_MAX=9999 RSI_MEM_AVAIL_MIN_MB=0 RSI_SWAP_USED_MAX_MB=999999999 \
  RSI_LANE2_MEM_MIN_MB=0 RSI_LANE2_PRESSURE_MAX=99 RSI_LANE2_SWAP_FREE_MIN_MB=0 \
  python3 "$RUNTIME/lanes.py" "$@"
}
brief="$T/brief.md"; printf 'brief\n' > "$brief"

# claim <state> <lane> <slug> <item> [extra args...] — sets rc, O (stdout), E (stderr).
claim() {
  local st="$1" lane="$2" slug="$3" item="$4"; shift 4
  run_lanes "$st" claim "$lane" --slug "$slug" --item "$item" --brief "$brief" \
    --paths rsi/runtime/a.py "$@" >"$T/out" 2>"$T/err"
  rc=$?; O="$(cat "$T/out")"; E="$(cat "$T/err")"
}
# hold_lane <state> <lane> <slug> — a fresh claim record, active for CLAIM_TTL.
hold_lane() {
  mkdir -p "$1/lanes"
  python3 - "$1" "$2" "$3" <<'PY'
import json, sys, time
st, lane, slug = sys.argv[1], int(sys.argv[2]), sys.argv[3]
json.dump({"lane": lane, "slug": slug, "item": "R-" + slug, "brief": "/dev/null",
           "mode": "new", "paths": ["rsi/runtime/other.py"], "status": "claimed",
           "claimed_at": time.time()}, open(f"{st}/lanes/{lane}.json", "w"))
PY
}
# sendback <state> <slug> — the file merge.sh leaves for the rework dispatcher.
sendback() { mkdir -p "$1/sendback"; printf 'item: R-%s\nattempt: 1\n' "$2" > "$1/sendback/$2.md"; }

# --- last-lane-reserved --------------------------------------------------------------------
# Lane 1 is busy and #435-style sendback is waiting: the fresh slice must not take lane 2, and
# the refusal must name the sendback and the command that fills the slot.
if run_case last-lane-reserved; then
  ST="$T/r1"; mkdir -p "$ST"; hold_lane "$ST" 1 running-slice; sendback "$ST" link-exchange-bound
  claim "$ST" 2 fresh-slice R-fresh
  [ "$rc" -eq 10 ] || bad "last-lane-reserved: expected exit 10, got $rc (out: $O / err: $E)"
  grep -q "REFUSED: unclaimed rework link-exchange-bound gets the last free lane" <<<"$O" \
    || bad "last-lane-reserved: refusal does not name the sendback: $O"
  grep -q 'run `lane.sh autofill`$' <<<"$O" \
    || bad "last-lane-reserved: refusal does not end with autofill (old 'autofill rest'?): $O"
  [ ! -f "$ST/lanes/2.json" ] || bad "last-lane-reserved: lane 2 was written anyway"
  ok last-lane-reserved
fi

# --- lane-to-spare-allowed ------------------------------------------------------------------
# Control for the same state minus the busy lane: one claim is fine because a lane stays free.
if run_case lane-to-spare-allowed; then
  ST="$T/r2"; mkdir -p "$ST"; sendback "$ST" link-exchange-bound
  claim "$ST" 1 fresh-slice R-fresh
  [ "$rc" -eq 0 ] && grep -q "CLAIMED lane 1" <<<"$O" || bad "lane-to-spare-allowed: claim failed ($rc): $O / $E"
  ok lane-to-spare-allowed
fi

# --- rework-takes-last-lane ------------------------------------------------------------------
# A rework is the thing the guard protects: it must still claim the last lane.
if run_case rework-takes-last-lane; then
  ST="$T/r3"; mkdir -p "$ST"; hold_lane "$ST" 1 running-slice; sendback "$ST" link-exchange-bound
  claim "$ST" 2 link-exchange-bound R-link-exchange-bound --mode rework
  [ "$rc" -eq 0 ] && grep -q "CLAIMED lane 2" <<<"$O" || bad "rework-takes-last-lane: rework refused ($rc): $O / $E"
  ok rework-takes-last-lane
fi

# --- no-sendback-unaffected ------------------------------------------------------------------
# No sendback waiting: the last lane still goes to the fresh slice, exactly as before.
if run_case no-sendback-unaffected; then
  ST="$T/r4"; mkdir -p "$ST"; hold_lane "$ST" 1 running-slice
  claim "$ST" 2 fresh-slice R-fresh
  [ "$rc" -eq 0 ] && grep -q "CLAIMED lane 2" <<<"$O" || bad "no-sendback-unaffected: claim refused ($rc): $O / $E"
  ok no-sendback-unaffected
fi

# --- running-rework-does-not-reserve ---------------------------------------------------------
# A sendback stays in the queue for its whole rework run (lane.sh archives it at the end),
# so the file must not reserve a second lane: the live 10:0x state was lane 2 running
# link-exchange-bound with its sendback still queued, which must not block a fresh slice.
if run_case running-rework-does-not-reserve; then
  ST="$T/r6"; mkdir -p "$ST"; hold_lane "$ST" 1 link-exchange-bound; sendback "$ST" link-exchange-bound
  claim "$ST" 2 fresh-slice R-fresh
  [ "$rc" -eq 0 ] && grep -q "CLAIMED lane 2" <<<"$O" \
    || bad "running-rework-does-not-reserve: claim refused ($rc): $O / $E"
  ok running-rework-does-not-reserve
fi

# --- waived-hold-size-does-not-reserve -------------------------------------------------------
# source: hold-size plus a standing merge/<slug>.size-ok is a pair autofill deliberately
# skips without archiving (lane.sh:84-86); it must not hold the last lane with no rework coming.
if run_case waived-hold-size-does-not-reserve; then
  ST="$T/r7"; mkdir -p "$ST/merge" "$ST/sendback"; hold_lane "$ST" 1 running-slice
  printf 'item: R-size-only\nattempt: 1\nsource: hold-size\n' > "$ST/sendback/size-only.md"
  : > "$ST/merge/size-only.size-ok"
  claim "$ST" 2 fresh-slice R-fresh
  [ "$rc" -eq 0 ] && grep -q "CLAIMED lane 2" <<<"$O" \
    || bad "waived-hold-size-does-not-reserve: claim refused ($rc): $O / $E"
  ok waived-hold-size-does-not-reserve
fi

# --- hold-size-without-waiver-still-reserves -------------------------------------------------
# The pair is the exemption, not the source: a size sendback with no waiver still waits for
# its rework and keeps the last lane, exactly like any other.
if run_case hold-size-without-waiver-still-reserves; then
  ST="$T/r8"; mkdir -p "$ST/sendback"; hold_lane "$ST" 1 running-slice
  printf 'item: R-size-only\nattempt: 1\nsource: hold-size\n' > "$ST/sendback/size-only.md"
  claim "$ST" 2 fresh-slice R-fresh
  [ "$rc" -eq 10 ] || bad "hold-size-without-waiver-still-reserves: expected exit 10, got $rc (out: $O / err: $E)"
  ok hold-size-without-waiver-still-reserves
fi

# --- archived-sendback-unaffected ------------------------------------------------------------
# A sendback already moved under sendback/done/ is not waiting: the glob must not read it.
if run_case archived-sendback-unaffected; then
  ST="$T/r5"; mkdir -p "$ST/sendback/done"; hold_lane "$ST" 1 running-slice
  printf 'item: R-gone\n' > "$ST/sendback/done/gone.md"
  claim "$ST" 2 fresh-slice R-fresh
  [ "$rc" -eq 0 ] && grep -q "CLAIMED lane 2" <<<"$O" || bad "archived-sendback-unaffected: claim refused ($rc): $O / $E"
  ok archived-sendback-unaffected
fi

echo "all cases passed"
