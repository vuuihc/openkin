#!/bin/bash
# test-merge-slot-priority.sh — a small-safe PR yields the last free general verifier slot to a
# big/medium PR that has queued SLOT_YIELD_MIN (default 10) minutes.
#
# The merge lane runs MERGE_WORKERS (2) general slots plus SMALL_SLOTS (1) reserved. Rows are
# considered small-first (dispatch_rows sorts small-safe ahead of big), so a freshly arrived docs
# fix could take the last free general slot while a large PR had already waited 10+ minutes for
# it; the big PR then queued behind a 20-30 minute verifier it had already outwaited. A small now
# yields that slot — but only when the big can actually start under the general-slot rule, so the
# reserved slot never sits idle (case 3 is the anti-starvation control).
#
# Exercises merge.sh --slot-select-check: the same slot_claim() the dispatcher loop calls, over the
# same TSV rows on stdin and the same live locks and .tier/.queued_at files. It exits before any
# gh, git, lane or dispatch call and writes no lock or .tier. Hermetic: mktemp dirs, no network,
# no gh, no model. The PAUSE flag in the temp control tree keeps an unwired seam (the red run)
# from falling through to the real dispatcher.
# Prints "PASS <case>" per case and exits non-zero on the first failure.
# Set RSI_TEST_ONLY=<case name> to run one case (used to show the red run per case).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
RSI="$(cd "$HERE/../.." && pwd)"
MERGE="$RSI/runtime/merge.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
ONLY="${RSI_TEST_ONLY:-}"
RC=0; OUT=""
CTRL="$T/ctrl"
S="$CTRL/rsi/state/merge"

pass() { echo "PASS $*"; }
fail() { echo "FAIL $*" >&2; exit 1; }

# reset — a fresh state dir with the PAUSE guard, and the two live locks the cases share.
reset() { rm -rf "$CTRL/rsi/state"; mkdir -p "$S"; : > "$CTRL/rsi/state/PAUSE"; }
# lock <slug> <tier> — a running verifier: a lock whose pid is this shell, plus the tier it records.
lock() { mkdir -p "$S/$1.lock"; echo $$ > "$S/$1.lock/pid"; echo "$2" > "$S/$1.tier"; }
# queued <slug> <tier|""> <minutes-ago> — a PR that has waited; an empty tier is never written,
# which is what a PR that has not started looks like on disk (the dispatcher's unknown = large).
queued() {
  [ -z "$2" ] || echo "$2" > "$S/$1.tier"
  echo $(( $(date +%s) - ${3:-0} * 60 )) > "$S/$1.queued_at"
}
# write_rows <big-tier> — the dispatcher's own order: small-safe first, then the big/medium row.
write_rows() {
  printf '301\tsmall-docs\tdocs: fix a typo\tsmall\t\n' > "$T/rows"
  printf '302\tbig-auth\tfeat(auth): rework sessions\t%s\t\n' "$1" >> "$T/rows"
}
# run_slots [RSI_SLOT_YIELD_MIN] — run the seam over $T/rows. Sets RC and OUT.
run_slots() {
  if [ $# -ge 1 ]; then
    RSI_CTRL="$CTRL" RSI_SLOT_YIELD_MIN="$1" bash "$MERGE" --slot-select-check < "$T/rows" > "$T/out" 2>&1
  else
    RSI_CTRL="$CTRL" bash "$MERGE" --slot-select-check < "$T/rows" > "$T/out" 2>&1
  fi
  RC=$?; OUT="$(cat "$T/out")"
}

# started <case> <slug> / not_started <case> <slug> / yielded <case> <small> <waiter>
started() {
  [ "$RC" -eq 0 ] || fail "$1: seam failed rc=$RC ($OUT)"
  printf '%s\n' "$OUT" | awk -F'\t' -v s="$2" '$1=="START" && $3==s {f=1} END {exit !f}' \
    || fail "$1: '$2' did not start ($OUT)"
}
not_started() {
  printf '%s\n' "$OUT" | awk -F'\t' -v s="$2" '$1=="START" && $3==s {f=1} END {exit !f}' \
    && fail "$1: '$2' started but must wait ($OUT)"
  return 0
}
# The small's SKIP line must name both the yield and the waiting PR.
yielded() {
  printf '%s\n' "$OUT" | awk -F'\t' -v s="$2" -v w="$3" \
    '$1=="SKIP" && $3==s && $4 ~ /yield/ && index($4,w) {f=1} END {exit !f}' \
    || fail "$1: no yield line for '$2' naming '$3' ($OUT)"
}
not_yielded() {
  printf '%s\n' "$OUT" | awk -F'\t' -v s="$2" '$1=="SKIP" && $3==s && $4 ~ /yield/ {f=1} END {exit !f}' \
    && fail "$1: '$2' yielded though it must not ($OUT)"
  return 0
}
# The seam is a read-only picker: no lock and no .tier may appear for the row it did not start.
untouched() {
  [ -e "$S/$2.lock" ] && fail "$1: seam created a lock for '$2'"
  [ -e "$S/$2.tier" ] && fail "$1: seam wrote .tier for '$2'"
  return 0
}
no_lock() { [ -e "$S/$2.lock" ] && fail "$1: seam created a lock for '$2'"; return 0; }

# --- cases -------------------------------------------------------------------------------------

# The motivating case: one big + one small running, the last free general slot is at stake, and a
# large PR has waited 11 minutes. The small yields; the large starts.
small_yields_last_slot() {
  reset; lock big-run large; lock small-run small; queued big-auth large 11; write_rows large
  run_slots
  yielded small-yields-last-slot small-docs big-auth
  not_started small-yields-last-slot small-docs
  started small-yields-last-slot big-auth
  untouched small-yields-last-slot small-docs
  no_lock small-yields-last-slot big-auth
}

# A big that has waited only 5 minutes has not outwaited the small: today's small-first order stays.
small_starts_under_threshold() {
  reset; lock big-run large; lock small-run small; queued big-auth large 5; write_rows large
  run_slots
  started small-starts-under-threshold small-docs
  not_yielded small-starts-under-threshold small-docs
  not_started small-starts-under-threshold big-auth
}

# Anti-starvation control: two bigs running means the waiting big cannot start under the
# general-slot rule, so the small keeps the reserved slot instead of letting it idle.
small_keeps_reserved_slot() {
  reset; lock big-a large; lock big-b large; queued big-auth large 11; write_rows large
  run_slots
  started small-keeps-reserved-slot small-docs
  not_yielded small-keeps-reserved-slot small-docs
  not_started small-keeps-reserved-slot big-auth
}

# A medium PR is a big for the yield: it uses a general slot exactly like a large one.
medium_counts_as_big() {
  reset; lock big-run large; lock small-run small; queued big-auth medium 11; write_rows medium
  run_slots
  yielded medium-counts-as-big small-docs big-auth
  not_started medium-counts-as-big small-docs
  started medium-counts-as-big big-auth
}

# RSI_SLOT_YIELD_MIN=0 is the ops escape hatch: the yield is off, the small takes the slot.
zero_disables_yield() {
  reset; lock big-run large; lock small-run small; queued big-auth large 11; write_rows large
  run_slots 0
  started zero-disables-yield small-docs
  not_yielded zero-disables-yield small-docs
}

# No .tier is what a never-started queued PR looks like: it is a big (unknown = large), so the
# yield still fires — the production path, not just the fixture with a tier file.
absent_tier_counts_as_big() {
  reset; lock big-run large; lock small-run small; queued big-auth "" 11; write_rows large
  run_slots
  yielded absent-tier-counts-as-big small-docs big-auth
  not_started absent-tier-counts-as-big small-docs
}

# A malformed knob falls back to 10 minutes, like the other numeric knobs in merge.sh.
malformed_threshold_falls_back() {
  reset; lock big-run large; lock small-run small; queued big-auth large 11; write_rows large
  run_slots banana
  yielded malformed-threshold-falls-back small-docs big-auth
  not_started malformed-threshold-falls-back small-docs
}

# Both call sites read the one predicate; a re-inlined slot rule is this bug coming back.
one_predicate_two_callers() {
  local seam loop
  seam="$(grep -c 'slot_claim "\$tier"' "$MERGE")"
  loop="$(grep -c 'slot_claim "\$TIER"' "$MERGE")"
  [ "$seam" -eq 1 ] || fail "one-predicate-two-callers: seam calls slot_claim $seam times, want 1"
  [ "$loop" -eq 1 ] || fail "one-predicate-two-callers: dispatcher calls slot_claim $loop times, want 1"
}

run() { # <case name> <function>
  if [ -n "$ONLY" ] && [ "$1" != "$ONLY" ]; then return 0; fi
  "$2" || exit 1
  pass "$1"
}

run small-yields-last-slot small_yields_last_slot
run small-starts-under-threshold small_starts_under_threshold
run small-keeps-reserved-slot small_keeps_reserved_slot
run medium-counts-as-big medium_counts_as_big
run zero-disables-yield zero_disables_yield
run absent-tier-counts-as-big absent_tier_counts_as_big
run malformed-threshold-falls-back malformed_threshold_falls_back
run one-predicate-two-callers one_predicate_two_callers
echo ALL-PASS
