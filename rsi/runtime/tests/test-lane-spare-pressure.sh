#!/bin/bash
# test-lane-spare-pressure.sh — the second local worker's floor must read memory pressure,
# not cumulative used swap.
#
# macOS keeps swapped pages allocated after the pressure that caused them has passed, so
# `swap used` is a high-water readout: on 2026-11-19 it read 2706 MB with
# kern.memorystatus_vm_pressure_level = 1 (normal) and ~5.9 GB reclaimable, yet lane 2 was
# refused on every claim from 2026-11-18 22:00 on. The floor now refuses on warning-or-worse
# VM pressure and on a real swap-free headroom minimum; used swap no longer decides.
# The first worker keeps the ordinary host_pressure thresholds, and reworks still preempt.
# `idle` is the fill's licence for a second worker, so it must answer the spare-lane floor the
# same way `claim` does — including on a cold start, where it used to print two lanes on a
# machine whose claim gate would immediately refuse the second one.
#
# Hermetic: stubbed sysctl/vm_stat on PATH, temp RSI_STATE, pinned thresholds; no network,
# no repo writes. Prints "PASS <case>" per case and exits non-zero on the first failure.
set -u
RUNTIME="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
ok() { echo "PASS $*"; }; bad() { echo "FAIL $*" >&2; exit 1; }

# --- stubs ---------------------------------------------------------------------------------
# sysctl answers the swapusage and pressure probes from the scenario env; anything else fails
# like an unknown key so an unexpected probe cannot silently read the real machine.
mkdir -p "$T/bin"
cat > "$T/bin/sysctl" <<'SH'
#!/bin/sh
case "${2:-}" in
  vm.swapusage) echo "vm.swapusage: total = ${STUB_SWAP_TOTAL:-4096.00}M  used = ${STUB_SWAP_USED}M  free = ${STUB_SWAP_FREE}M" ;;
  kern.memorystatus_vm_pressure_level) echo "${STUB_PRESSURE}" ;;
  *) exit 1 ;;
esac
SH
# vm_stat reports 4 equal page buckets summing to STUB_AVAIL_MB (page size 16384 → 64 pages/MB).
cat > "$T/bin/vm_stat" <<'SH'
#!/bin/sh
p=$(( ${STUB_AVAIL_MB} * 64 ))
q=$(( p / 4 ))
cat <<EOF
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               ${q}.
Pages inactive:                           ${q}.
Pages speculative:                        ${q}.
Pages purgeable:                          ${q}.
EOF
SH
chmod +x "$T/bin/sysctl" "$T/bin/vm_stat"

# run_lanes <state> <avail_mb> <pressure_level> <swap_used_mb> <swap_free_mb> -- lanes.py args
# Pins every threshold so neither a loaded machine nor an exported RSI_* value can move the
# outcome; only the spare-lane values under test are left at their declared defaults here.
run_lanes() {
  local st="$1" avail="$2" lvl="$3" used="$4" free="$5"; shift 5
  RSI_STATE="$st" RSI_RUNS="$T/runs" PATH="$T/bin:$PATH" \
  STUB_AVAIL_MB="$avail" STUB_PRESSURE="$lvl" STUB_SWAP_USED="$used" STUB_SWAP_FREE="$free" \
  RSI_MAX_LANES=2 RSI_LOAD_MAX=9999 RSI_MEM_AVAIL_MIN_MB=0 RSI_SWAP_USED_MAX_MB=999999999 \
  RSI_LANE2_MEM_MIN_MB=5120 RSI_LANE2_PRESSURE_MAX=1 RSI_LANE2_SWAP_FREE_MIN_MB=512 \
  python3 "$RUNTIME/lanes.py" "$@"
}
brief="$T/brief.md"; printf 'brief\n' > "$brief"

# claim_one <state> <avail> <level> <used> <free> <lane> <slug> <item> <path> [extra args...]
# Captures output in $out and the exit code in $rc; never aborts, so a refusal can be asserted.
claim_one() {
  local st="$1" avail="$2" lvl="$3" used="$4" free="$5" lane="$6" slug="$7" item="$8" path="$9"
  shift 9
  out="$(run_lanes "$st" "$avail" "$lvl" "$used" "$free" claim "$lane" \
    --slug "$slug" --item "$item" --brief "$brief" --paths "$path" "$@" 2>&1)"; rc=$?
}

# idle_one <state> <avail> <level> <used> <free> [extra args...]
# Keeps stdout in $out and stderr in $err, because the licence is what `idle` prints and the
# reason is what it says on stderr; folding them together would let either half hide.
idle_one() {
  local st="$1" avail="$2" lvl="$3" used="$4" free="$5"; shift 5
  out="$(run_lanes "$st" "$avail" "$lvl" "$used" "$free" idle "$@" 2>"$T/err")"; rc=$?
  err="$(cat "$T/err")"
}

# --- spare_allowed_when_swap_warm_but_pressure_normal --------------------------------------
# Today's false refusal: level 1, 5900 MB reclaimable, 2706 MB used / 1390 MB free swap.
# Lane 1 holds no pressure meaning, and lane 2 must start.
ST="$T/c1"; mkdir -p "$ST"
claim_one "$ST" 5900 1 2706 1390 1 alpha R-alpha rsi/runtime/a.py
[ "$rc" -eq 0 ] && grep -q "CLAIMED lane 1" <<<"$out" || bad "spare_allowed_when_swap_warm_but_pressure_normal: claim 1 failed ($rc): $out"
claim_one "$ST" 5900 1 2706 1390 2 beta R-beta rsi/runtime/b.py
[ "$rc" -eq 0 ] && grep -q "CLAIMED lane 2" <<<"$out" || bad "spare_allowed_when_swap_warm_but_pressure_normal: claim 2 refused ($rc): $out"
ok spare_allowed_when_swap_warm_but_pressure_normal

# --- idle_offers_lane_two_when_normal ------------------------------------------------------
ST="$T/c2"; mkdir -p "$ST"
claim_one "$ST" 5900 1 2706 1390 1 alpha R-alpha rsi/runtime/a.py
[ "$rc" -eq 0 ] || bad "idle_offers_lane_two_when_normal: claim 1 failed ($rc): $out"
out="$(run_lanes "$ST" 5900 1 2706 1390 idle 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && [ "$out" = "2" ] || bad "idle_offers_lane_two_when_normal: expected '2', got ($rc): $out"
ok idle_offers_lane_two_when_normal

# --- spare_refused_on_warning_pressure -----------------------------------------------------
# Level 2 (warning) is below host_pressure's critical floor (>= 4) but above the spare lane's
# floor: the spare yields, and lane 2's record is never written.
ST="$T/c3"; mkdir -p "$ST"
claim_one "$ST" 5900 1 100 3996 1 alpha R-alpha rsi/runtime/a.py
[ "$rc" -eq 0 ] || bad "spare_refused_on_warning_pressure: claim 1 failed ($rc): $out"
claim_one "$ST" 5900 2 100 3996 2 beta R-beta rsi/runtime/b.py
[ "$rc" -eq 8 ] || bad "spare_refused_on_warning_pressure: expected exit 8, got $rc: $out"
grep -q "REFUSED: spare lane held (vm_pressure_level 2" <<<"$out" \
  || bad "spare_refused_on_warning_pressure: refusal does not name vm_pressure_level 2: $out"
[ ! -f "$ST/lanes/2.json" ] || bad "spare_refused_on_warning_pressure: lane 2 was claimed anyway"
ok spare_refused_on_warning_pressure

# --- spare_refused_when_swap_free_low ------------------------------------------------------
# Used swap (600 MB) is below the old 1536 MB ceiling, but free headroom (100 MB) is below the
# 512 MB floor — the measure is free swap, not the cumulative counter.
ST="$T/c4"; mkdir -p "$ST"
claim_one "$ST" 5900 1 100 3996 1 alpha R-alpha rsi/runtime/a.py
[ "$rc" -eq 0 ] || bad "spare_refused_when_swap_free_low: claim 1 failed ($rc): $out"
claim_one "$ST" 5900 1 600 100 2 beta R-beta rsi/runtime/b.py
[ "$rc" -eq 8 ] || bad "spare_refused_when_swap_free_low: expected exit 8, got $rc: $out"
grep -q "swap free" <<<"$out" || bad "spare_refused_when_swap_free_low: refusal does not name swap free: $out"
[ ! -f "$ST/lanes/2.json" ] || bad "spare_refused_when_swap_free_low: lane 2 was claimed anyway"
ok spare_refused_when_swap_free_low

# --- spare_refused_when_avail_low ----------------------------------------------------------
# The reclaimable-memory check stays first and keeps its own message.
ST="$T/c5"; mkdir -p "$ST"
claim_one "$ST" 5900 1 100 3996 1 alpha R-alpha rsi/runtime/a.py
[ "$rc" -eq 0 ] || bad "spare_refused_when_avail_low: claim 1 failed ($rc): $out"
claim_one "$ST" 4000 1 100 3996 2 beta R-beta rsi/runtime/b.py
[ "$rc" -eq 8 ] || bad "spare_refused_when_avail_low: expected exit 8, got $rc: $out"
grep -q "avail mem" <<<"$out" || bad "spare_refused_when_avail_low: refusal does not name avail mem: $out"
[ ! -f "$ST/lanes/2.json" ] || bad "spare_refused_when_avail_low: lane 2 was claimed anyway"
ok spare_refused_when_avail_low

# --- first_lane_unaffected_by_warm_swap ----------------------------------------------------
# No other lane is active, so the spare-lane floor is not consulted even though reclaimable
# memory (3000 MB) is under LANE2_MEM_MIN_MB and used swap is warm; the first worker's floor
# is 2048 MB and it passes.
ST="$T/c6"; mkdir -p "$ST"
claim_one "$ST" 3000 1 2706 1390 1 alpha R-alpha rsi/runtime/a.py
[ "$rc" -eq 0 ] && grep -q "CLAIMED lane 1" <<<"$out" || bad "first_lane_unaffected_by_warm_swap: claim 1 failed ($rc): $out"
ok first_lane_unaffected_by_warm_swap

# --- rework_preempts_the_floor -------------------------------------------------------------
# Warning pressure holds a NEW spare lane (case 3) but a short rework still takes it.
ST="$T/c7"; mkdir -p "$ST"
claim_one "$ST" 5900 1 100 3996 1 alpha R-alpha rsi/runtime/a.py
[ "$rc" -eq 0 ] || bad "rework_preempts_the_floor: claim 1 failed ($rc): $out"
claim_one "$ST" 5900 2 100 3996 2 beta R-beta rsi/runtime/b.py --mode rework
[ "$rc" -eq 0 ] && grep -q "CLAIMED lane 2" <<<"$out" || bad "rework_preempts_the_floor: rework refused ($rc): $out"
ok rework_preempts_the_floor

# --- status_reports_pressure_and_swap_free -------------------------------------------------
# The fill reads this line to decide whether two lanes are honest; it must expose pressure and
# free headroom alongside the old fields.
ST="$T/c8"; mkdir -p "$ST"
out="$(run_lanes "$ST" 5900 1 2706 1390 status 2>&1)"; rc=$?
[ "$rc" -eq 0 ] || bad "status_reports_pressure_and_swap_free: status failed ($rc): $out"
grep -q "vm_pressure=1" <<<"$out" || bad "status_reports_pressure_and_swap_free: no vm_pressure=1: $out"
grep -q "swap_free_mb=1390" <<<"$out" || bad "status_reports_pressure_and_swap_free: no swap_free_mb=1390: $out"
grep -q "swap_used_mb=2706" <<<"$out" || bad "status_reports_pressure_and_swap_free: swap_used_mb field dropped: $out"
ok status_reports_pressure_and_swap_free

# --- idle_holds_second_lane_on_cold_start --------------------------------------------------
# The 2026-11-20 20:32 fill: empty state, 4000 MB reclaimable (floor 5120), pressure normal,
# 1390 MB free swap. `idle` used to print both lanes because no worker was active yet, and the
# second claim then died with REFUSED: spare lane held. The licence must name one lane only.
ST="$T/c9"; mkdir -p "$ST"
idle_one "$ST" 4000 1 2706 1390
[ "$rc" -eq 0 ] && [ "$out" = "1" ] \
  || bad "idle_holds_second_lane_on_cold_start: expected stdout '1' and exit 0, got ($rc): stdout='$out' stderr='$err'"
grep -q "spare lane held (avail mem" <<<"$err" \
  || bad "idle_holds_second_lane_on_cold_start: stderr does not name the floor: $err"
ok idle_holds_second_lane_on_cold_start

# --- idle_offers_both_on_cold_start_with_headroom ------------------------------------------
# The mirror: enough headroom on a cold start still licences both workers, so the fix cannot be
# "never print two lanes".
ST="$T/c10"; mkdir -p "$ST"
idle_one "$ST" 5900 1 2706 1390
[ "$rc" -eq 0 ] && [ "$out" = $'1\n2' ] \
  || bad "idle_offers_both_on_cold_start_with_headroom: expected stdout '1\\n2' and exit 0, got ($rc): stdout='$out' stderr='$err'"
ok idle_offers_both_on_cold_start_with_headroom

# --- idle_ignore_pressure_offers_both_on_cold_start ----------------------------------------
# --ignore-pressure is the rework dispatcher's bypass and must keep skipping the spare floor on
# a cold start too.
ST="$T/c11"; mkdir -p "$ST"
idle_one "$ST" 4000 1 2706 1390 --ignore-pressure
[ "$rc" -eq 0 ] && [ "$out" = $'1\n2' ] \
  || bad "idle_ignore_pressure_offers_both_on_cold_start: expected stdout '1\\n2' and exit 0, got ($rc): stdout='$out' stderr='$err'"
ok idle_ignore_pressure_offers_both_on_cold_start

# --- idle_agrees_with_claim_on_cold_start --------------------------------------------------
# One story across both commands: cold-start idle offers lane 1, the claim for lane 1 succeeds,
# and the next idle refuses to licence lane 2 with the same floor reason `claim 2` would give.
ST="$T/c12"; mkdir -p "$ST"
idle_one "$ST" 4000 1 2706 1390
[ "$rc" -eq 0 ] && [ "$out" = "1" ] || bad "idle_agrees_with_claim_on_cold_start: first idle did not offer lane 1 ($rc): stdout='$out' stderr='$err'"
claim_one "$ST" 4000 1 2706 1390 1 alpha R-alpha rsi/runtime/a.py
[ "$rc" -eq 0 ] && grep -q "CLAIMED lane 1" <<<"$out" || bad "idle_agrees_with_claim_on_cold_start: claim 1 failed ($rc): $out"
idle_one "$ST" 4000 1 2706 1390
[ "$rc" -eq 0 ] && [ -z "$out" ] || bad "idle_agrees_with_claim_on_cold_start: second idle still offered a lane ($rc): stdout='$out' stderr='$err'"
grep -q "spare lane held (avail mem" <<<"$err" || bad "idle_agrees_with_claim_on_cold_start: second idle does not name the floor: $err"
ok idle_agrees_with_claim_on_cold_start

echo "test-lane-spare-pressure: ALL-PASS"
