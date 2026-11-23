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
# gh, git, lane or dispatch call and writes no lock or .tier. The cooldown cases drive the real
# dispatcher through the RSI_PR_LIST_CMD / RSI_START_LOG seams (the shape test-merge-batch.sh
# uses), and the yield case stays on --slot-select-check. Hermetic: mktemp dirs, no network,
# no gh, no model. The PAUSE flag in the temp control tree keeps an unwired seam (the red run)
# from falling through to the real dispatcher; the dispatcher cases deliberately omit it, because
# PAUSE exits the dispatcher before it reads a row.
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
# run_slots [RSI_SLOT_YIELD_MIN] [KEY=VALUE ...] — run the seam over $T/rows. Sets RC and OUT.
# Extra assignments reach the seam's environment: --slot-select-check has no PR payload, so the
# spec-mover hold reads UX_SPEC_MOVERS from there (the hold's test hook).
run_slots() {
  local yield=""
  if [ $# -ge 1 ]; then yield="$1"; shift; fi
  if [ -n "$yield" ]; then
    RSI_CTRL="$CTRL" RSI_SLOT_YIELD_MIN="$yield" env "$@" bash "$MERGE" --slot-select-check < "$T/rows" > "$T/out" 2>&1
  else
    RSI_CTRL="$CTRL" env "$@" bash "$MERGE" --slot-select-check < "$T/rows" > "$T/out" 2>&1
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

# A held big is not a big this pass will start: it keeps its 11-minute .queued_at while the CEO
# hold is in place, so the small must take the slot rather than yield it to a verifier that will
# not run and leave the reserved slot idle for as long as the hold lasts.
held_big_still_lets_small_start() {
  reset; lock big-run large; lock small-run small; queued big-auth large 11; write_rows large
  touch "$S/big-auth.blocked"
  run_slots
  started held-big-still-lets-small-start small-docs
  not_yielded held-big-still-lets-small-start small-docs
  not_started held-big-still-lets-small-start big-auth
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

# ---------------------------------------------------------------------------------------------
# UX cooldown (R-slot-cooldown): after a walk that could not run, merge.sh writes
# state/merge/<slug>.uxcooldown = <expiry_epoch> <diff-hash> <reason>, and nothing used to read it,
# so every dispatch cycle paid a verifier for a PR that could not merge. The dispatcher now rests
# such a row — iff the cooldown is live AND names the diff the review cache holds — and says one
# line naming when the PR returns. Everything else fails open: a missing .reviewed, an empty or
# different DH, or a malformed line means "verify it", because one wasted slot costs less than a
# stranded PR.
#
# R-uxcooldown-hold adds a second reason to rest, for a cooldown that has EXPIRED on the same diff:
# while an open PR changes the walker spec (the UX_SPEC_PATHS family ux_carry_key() digests), the
# walk this PR would pay for is about to be re-derived against a different spec, so the row waits
# for that PR to merge instead of spending the one heavy slot on a verdict about to be invalidated.
# The hold is bounded (RSI_UX_HOLD_MAX_MIN, default 180 minutes, 0 disables), never rests a PR
# against itself, and needs a readable `files` list, so the light gh fallback fails open.
#
# These cases drive the REAL dispatcher through the same seams as test-merge-batch.sh
# (RSI_CTRL copy, RSI_PR_LIST_CMD, RSI_START_LOG, RSI_PR_STATE_CMD), with no PAUSE file: PAUSE
# exits the dispatcher before it reads a row. The yield case uses the --slot-select-check seam
# instead, because it is about the yield candidate set; the batch case runs the batch path with
# RSI_BATCH_VERIFY=1.
# Hermetic: mktemp dirs, no network, no gh, no model, no lane.

reset_dispatch() { # fresh control tree and state, and NO PAUSE
  rm -rf "$CTRL"; mkdir -p "$CTRL/rsi"
  cp -R "$RSI/runtime" "$CTRL/rsi/runtime"
  mkdir -p "$S" "$CTRL/rsi/state/sendback"
  : > "$T/start.log"
}
# pr_json <n> <slug> <title> <path> <additions> — one fixture PR carrying the fields the
# dispatcher and batch formation read (headRefOid + statusCheckRollup included; batch needs them).
pr_json() {
  printf '{"number":%s,"headRefName":"rsi/%s","isDraft":false,"labels":[],"title":"%s","body":"RSI item: R-%s","headRefOid":"%s","statusCheckRollup":[{"__typename":"CheckRun","status":"COMPLETED","conclusion":"SUCCESS"}],"files":[{"path":"%s","additions":%s,"deletions":0}]}' \
    "$1" "$2" "$3" "$2" "$(printf '%s' "$2" | shasum | cut -c1-40)" "$4" "$5"
}
one_pr_json() { printf '[\n'; pr_json "$@"; printf '\n]\n'; }   # gh pr list returns an array
# pr_json_files <n> <slug> <title> <additions> <path> [<path> ...] — one fixture PR carrying several
# files (the list the spec-mover scan reads); every file carries the same additions count.
pr_json_files() {
  local n="$1" slug="$2" title="$3" add="$4" files="" p
  shift 4
  for p in "$@"; do
    files="${files:+$files,}{\"path\":\"$p\",\"additions\":$add,\"deletions\":0}"
  done
  printf '{"number":%s,"headRefName":"rsi/%s","isDraft":false,"labels":[],"title":"%s","body":"RSI item: R-%s","headRefOid":"%s","statusCheckRollup":[{"__typename":"CheckRun","status":"COMPLETED","conclusion":"SUCCESS"}],"files":[%s]}' \
    "$n" "$slug" "$title" "$slug" "$(printf '%s' "$slug" | shasum | cut -c1-40)" "$files"
}
run_dispatch() { # [1 to enable batch formation] [KEY=VALUE ...] — extra assignments reach the dispatcher
  local batch="0"
  if [ $# -ge 1 ]; then batch="$1"; shift; fi
  RSI_CTRL="$CTRL" RSI_PR_LIST_CMD="cat $T/pr.json" RSI_START_LOG="$T/start.log" \
    RSI_BATCH_VERIFY="$batch" RSI_PR_STATE_CMD='echo OPEN' env "$@" bash "$MERGE" > "$T/dispatch.out" 2>&1
  RC=$?; OUT="$(cat "$T/dispatch.out")"
}
cooldown() { # <slug> <dh> <expiry-epoch> — the exact format merge.sh/ux-gate.sh write
  printf '%s %s ux gate exceeded 900s\n' "$3" "$2" > "$S/$1.uxcooldown"
}
reviewed() { printf '%s PASS deadbeef reviewer\n' "$2" > "$S/$1.reviewed"; }
started_pr() {
  grep -qx "one $2 $3" "$T/start.log" || fail "$1: dispatcher did not start $3 ($(cat "$T/start.log"); $OUT)"
}
not_started_pr() {
  grep -qx "one $2 $3" "$T/start.log" && fail "$1: dispatcher started $3 though it must rest ($(cat "$T/start.log"))"
  return 0
}
# The dispatcher's own one-line reason, naming the slug, a return time and the rested diff.
said_skip() {
  grep -qE "^\[[0-9:]+\] #$2 $3: UX cooldown until [0-9]{2}:[0-9]{2} \(dh $4\), skip$" "$T/dispatch.out" \
    || fail "$1: no one-line cooldown skip naming '$3', its return time and the diff ($OUT)"
}
not_said_skip() {
  grep -q 'UX cooldown' "$T/dispatch.out" && fail "$1: a cooldown skip line appeared though the row must verify ($OUT)"
  return 0
}
# The spec-mover hold's one line names the mover (lowest number) and the reason, not a return time.
said_hold() { # <case> <n> <slug> <mover-n> <mover-slug>
  grep -qE "^\[[0-9:]+\] #$2 $3: UX cooldown held for #$4 $5 \(walker spec moves\), skip$" "$T/dispatch.out" \
    || fail "$1: no spec-mover hold line naming #$4 $5 ($OUT)"
}

# Future expiry + the cooldown's DH equals .reviewed's DH: rest the row, say when it returns, and
# do not let it accrue queue-wait minutes (that number feeds the slot yield).
cooldown_skips_same_diff() {
  reset_dispatch
  one_pr_json 301 small-docs "docs: fix a typo" docs/notes.md 3 > "$T/pr.json"
  reviewed small-docs aaaa1111
  cooldown small-docs aaaa1111 "$(( $(date +%s) + 1800 ))"
  run_dispatch
  [ "$RC" -eq 0 ] || fail "cooldown-skips-same-diff: dispatcher rc=$RC ($OUT)"
  not_started_pr cooldown-skips-same-diff 301 small-docs
  said_skip cooldown-skips-same-diff 301 small-docs aaaa1111
  [ -e "$S/small-docs.queued_at" ] && fail "cooldown-skips-same-diff: a rested PR accrued queue-wait time"
  return 0
}

# The expiry passed: the cooldown is over, verify it again.
cooldown_expired_requeues() {
  reset_dispatch
  one_pr_json 301 small-docs "docs: fix a typo" docs/notes.md 3 > "$T/pr.json"
  reviewed small-docs aaaa1111
  cooldown small-docs aaaa1111 "$(( $(date +%s) - 60 ))"
  run_dispatch
  started_pr cooldown-expired-requeues 301 small-docs
  not_said_skip cooldown-expired-requeues
}

# The cooldown was written for an older diff: the PR changed, so the walk must be retried.
cooldown_new_diff_requeues() {
  reset_dispatch
  one_pr_json 301 small-docs "docs: fix a typo" docs/notes.md 3 > "$T/pr.json"
  reviewed small-docs aaaa1111
  cooldown small-docs bbbb2222 "$(( $(date +%s) + 1800 ))"
  run_dispatch
  started_pr cooldown-new-diff-requeues 301 small-docs
  not_said_skip cooldown-new-diff-requeues
}

# Fail-open control: a missing .reviewed cache (the cooldown cannot be tied to a diff), then a
# malformed cooldown line, both mean "verify it". A missing cache must never strand a PR.
cooldown_unknown_verifies() {
  reset_dispatch
  one_pr_json 301 small-docs "docs: fix a typo" docs/notes.md 3 > "$T/pr.json"
  cooldown small-docs aaaa1111 "$(( $(date +%s) + 1800 ))"
  run_dispatch
  started_pr cooldown-unknown-verifies 301 small-docs
  not_said_skip cooldown-unknown-verifies
  reset_dispatch
  one_pr_json 301 small-docs "docs: fix a typo" docs/notes.md 3 > "$T/pr.json"
  reviewed small-docs aaaa1111
  printf 'soon aaaa1111 ux gate exceeded 900s\n' > "$S/small-docs.uxcooldown"
  run_dispatch
  started_pr cooldown-unknown-verifies 301 small-docs
  not_said_skip cooldown-unknown-verifies
}

# A cooled big is not a yield target: slot_big_rows must exclude it, or the small yields the last
# general slot to a verifier the cooldown will not start and the reserved slot sits idle.
cooldown_big_is_not_a_yield_target() {
  reset; lock big-run large; lock small-run small; queued big-auth large 11; write_rows large
  reviewed big-auth dddd4444
  cooldown big-auth dddd4444 "$(( $(date +%s) + 1800 ))"
  run_slots
  started cooldown-big-is-not-a-yield-target small-docs
  not_yielded cooldown-big-is-not-a-yield-target small-docs
  not_started cooldown-big-is-not-a-yield-target big-auth
}

# With RSI_BATCH_VERIFY=1 the row loop is a second entry point: a cooled PR must not join the
# batch (the batch runner would pay a union gate for it), while its ready neighbours still do.
cooldown_skips_batch_member() {
  reset_dispatch
  {
    printf '[\n'
    pr_json 201 p-cool "docs: cooled docs" docs/cool.md 3; printf ',\n'
    pr_json 202 p-two "feat: two" internal/two/b.go 450; printf ',\n'
    pr_json 203 p-three "docs: three" docs/three.md 3
    printf '\n]\n'
  } > "$T/pr.json"
  reviewed p-cool d1; reviewed p-two d2; reviewed p-three d3
  cooldown p-cool d1 "$(( $(date +%s) + 1800 ))"
  run_dispatch 1
  local members
  members="$(ls "$S"/batch-*.members 2>/dev/null | head -1)"
  [ -n "$members" ] || fail "cooldown-skips-batch-member: no batch formed from the two ready PRs ($OUT)"
  grep -q '^MEMBER [0-9]*	p-two	' "$members" || fail "cooldown-skips-batch-member: p-two is not a member ($(cat "$members"); $OUT)"
  grep -q '^MEMBER [0-9]*	p-three	' "$members" || fail "cooldown-skips-batch-member: p-three is not a member ($(cat "$members"); $OUT)"
  grep -q 'p-cool' "$members" && fail "cooldown-skips-batch-member: the cooled PR joined the batch ($(cat "$members"))"
  grep -q '^batch .*p-cool' "$T/start.log" && fail "cooldown-skips-batch-member: a batch start names the cooled PR ($(cat "$T/start.log"))"
  grep -qx 'one 201 p-cool' "$T/start.log" && fail "cooldown-skips-batch-member: the cooled PR got a single verifier ($(cat "$T/start.log"))"
  said_skip cooldown-skips-batch-member 201 p-cool d1
  return 0
}

# --- spec-mover hold (R-uxcooldown-hold) -------------------------------------------------------
# #630's UX gate spent 30 min first walk + 25 min confirm walk on the single heavy slot re-deriving
# a J4 red that #644 (journeys.json, the walker spec) was about to invalidate, then #644 queued 33
# min behind it. A cooldown that has expired on the same diff now rests the row while an open PR
# changes the walker spec — bounded by RSI_UX_HOLD_MAX_MIN (default 180, 0 disables) — so the walk
# happens once, against the spec that is about to land. The mover set comes from the same `gh pr
# list` payload as the rows; a payload without `files` (the light fallback) has no movers.

# A cooldown expired 5 minutes ago on the reviewed diff, and open PRs change the walker spec:
# rest the row, name the lowest-numbered mover (305 is listed first in the payload), and charge it
# no queue-wait time.
cooldown_held_for_spec_mover() {
  reset_dispatch
  {
    printf '[\n'
    pr_json 301 small-docs "docs: fix a typo" docs/notes.md 3; printf ',\n'
    pr_json_files 305 tune-walker "fix(rsi): widen the optional-step grace" 8 rsi/runtime/ux/optional-grace.mjs; printf ',\n'
    pr_json_files 302 fix-walker "fix(rsi): walk J4 on sessions" 12 rsi/runtime/ux/journeys.json rsi/runtime/ux/walk-log.mjs
    printf '\n]\n'
  } > "$T/pr.json"
  reviewed small-docs aaaa1111
  cooldown small-docs aaaa1111 "$(( $(date +%s) - 300 ))"
  run_dispatch
  [ "$RC" -eq 0 ] || fail "cooldown-held-for-spec-mover: dispatcher rc=$RC ($OUT)"
  not_started_pr cooldown-held-for-spec-mover 301 small-docs
  said_hold cooldown-held-for-spec-mover 301 small-docs 302 fix-walker
  [ -e "$S/small-docs.queued_at" ] && fail "cooldown-held-for-spec-mover: a held PR accrued queue-wait time"
  return 0
}

# The mover merged: while it is open the row rests, and once the open list holds only 301 the same
# marker verifies. The pair is what proves the hold — not the fixture — is doing the resting.
cooldown_hold_ends_when_mover_merges() {
  reset_dispatch
  {
    printf '[\n'
    pr_json 301 small-docs "docs: fix a typo" docs/notes.md 3; printf ',\n'
    pr_json_files 302 fix-walker "fix(rsi): walk J4 on sessions" 12 rsi/runtime/ux/journeys.json
    printf '\n]\n'
  } > "$T/pr.json"
  reviewed small-docs aaaa1111
  cooldown small-docs aaaa1111 "$(( $(date +%s) - 300 ))"
  run_dispatch
  not_started_pr cooldown-hold-ends-when-mover-merges 301 small-docs
  said_hold cooldown-hold-ends-when-mover-merges 301 small-docs 302 fix-walker
  # The mover merged; the same cooldown marker is the only state left.
  one_pr_json 301 small-docs "docs: fix a typo" docs/notes.md 3 > "$T/pr.json"
  : > "$T/start.log"
  run_dispatch
  started_pr cooldown-hold-ends-when-mover-merges 301 small-docs
  not_said_skip cooldown-hold-ends-when-mover-merges
}

# A PR that is itself a spec mover is never rested by its own presence — it starts, and it still
# holds another cooled PR. 302 rests against 301; no hold line names 301.
cooldown_hold_skips_self() {
  reset_dispatch
  {
    printf '[\n'
    pr_json_files 301 fix-walker "fix(rsi): walk J4 on sessions" 12 rsi/runtime/ux/journeys.json; printf ',\n'
    pr_json 302 cold-docs "docs: another cooled doc" docs/other.md 3
    printf '\n]\n'
  } > "$T/pr.json"
  reviewed fix-walker aaaa1111; reviewed cold-docs bbbb2222
  cooldown fix-walker aaaa1111 "$(( $(date +%s) - 300 ))"
  cooldown cold-docs bbbb2222 "$(( $(date +%s) - 300 ))"
  run_dispatch
  started_pr cooldown-hold-skips-self 301 fix-walker
  not_started_pr cooldown-hold-skips-self 302 cold-docs
  said_hold cooldown-hold-skips-self 302 cold-docs 301 fix-walker
  grep -qE '^\[[0-9:]+\] #301 fix-walker: UX cooldown held for' "$T/dispatch.out" \
    && fail "cooldown-hold-skips-self: the mover was held by its own presence ($OUT)"
  return 0
}

# The hold is real at the default bound, then gone when RSI_UX_HOLD_MAX_MIN=1: an expiry 10
# minutes past cannot outlive a one-minute bound, however many movers are open.
cooldown_hold_bounded() {
  reset_dispatch
  {
    printf '[\n'
    pr_json 301 small-docs "docs: fix a typo" docs/notes.md 3; printf ',\n'
    pr_json_files 302 fix-walker "fix(rsi): walk J4 on sessions" 12 rsi/runtime/ux/walk.mjs
    printf '\n]\n'
  } > "$T/pr.json"
  reviewed small-docs aaaa1111
  cooldown small-docs aaaa1111 "$(( $(date +%s) - 600 ))"
  run_dispatch
  not_started_pr cooldown-hold-bounded 301 small-docs
  said_hold cooldown-hold-bounded 301 small-docs 302 fix-walker
  : > "$T/start.log"
  run_dispatch 0 RSI_UX_HOLD_MAX_MIN=1
  started_pr cooldown-hold-bounded 301 small-docs
  not_said_skip cooldown-hold-bounded
}

# A cooldown written for an older diff is never evidence about this one: the DH rule wins over the
# hold, exactly as it wins over the plain cooldown.
cooldown_hold_fails_open_on_new_diff() {
  reset_dispatch
  {
    printf '[\n'
    pr_json 301 small-docs "docs: fix a typo" docs/notes.md 3; printf ',\n'
    pr_json_files 302 fix-walker "fix(rsi): walk J4 on sessions" 12 rsi/runtime/ux/journeys.json
    printf '\n]\n'
  } > "$T/pr.json"
  reviewed small-docs aaaa1111
  cooldown small-docs aaaa1111 "$(( $(date +%s) - 300 ))"
  run_dispatch
  not_started_pr cooldown-hold-fails-open-on-new-diff 301 small-docs
  said_hold cooldown-hold-fails-open-on-new-diff 301 small-docs 302 fix-walker
  # The PR moved: the marker names the previous diff, so neither reason may rest it.
  reviewed small-docs bbbb2222
  : > "$T/start.log"
  run_dispatch
  started_pr cooldown-hold-fails-open-on-new-diff 301 small-docs
  not_said_skip cooldown-hold-fails-open-on-new-diff
}

# The batch path reads the same hold: a held PR joins neither the batch nor a single verifier,
# while its ready neighbours still form the batch.
cooldown_hold_not_a_batch_member() {
  reset_dispatch
  {
    printf '[\n'
    pr_json 201 p-cool "docs: cooled docs" docs/cool.md 3; printf ',\n'
    pr_json 202 p-two "feat: two" internal/two/b.go 450; printf ',\n'
    pr_json 203 p-three "docs: three" docs/three.md 3; printf ',\n'
    pr_json_files 204 p-walk "fix(rsi): move the walker" 12 rsi/runtime/ux/journeys.json
    printf '\n]\n'
  } > "$T/pr.json"
  reviewed p-cool d1; reviewed p-two d2; reviewed p-three d3
  cooldown p-cool d1 "$(( $(date +%s) - 300 ))"
  run_dispatch 1
  local members
  members="$(ls "$S"/batch-*.members 2>/dev/null | head -1)"
  [ -n "$members" ] || fail "cooldown-hold-not-a-batch-member: no batch formed from the two ready PRs ($OUT)"
  grep -q 'p-cool' "$members" && fail "cooldown-hold-not-a-batch-member: the held PR joined the batch ($(cat "$members"))"
  grep -q '^MEMBER [0-9]*	p-two	' "$members" || fail "cooldown-hold-not-a-batch-member: p-two is not a member ($(cat "$members"); $OUT)"
  grep -q '^MEMBER [0-9]*	p-three	' "$members" || fail "cooldown-hold-not-a-batch-member: p-three is not a member ($(cat "$members"); $OUT)"
  grep -q '^batch .*p-cool' "$T/start.log" && fail "cooldown-hold-not-a-batch-member: a batch start names the held PR ($(cat "$T/start.log"))"
  grep -qx 'one 201 p-cool' "$T/start.log" && fail "cooldown-hold-not-a-batch-member: the held PR got a single verifier ($(cat "$T/start.log"))"
  said_hold cooldown-hold-not-a-batch-member 201 p-cool 204 p-walk
  return 0
}

# A held big is not a yield target: the small keeps the last general slot instead of yielding it
# to a verifier the hold will not start, so the reserved slot does not sit idle. The seam has no
# gh payload, so the mover set arrives through the UX_SPEC_MOVERS test hook.
cooldown_hold_not_a_yield_target() {
  reset; lock big-run large; lock small-run small; queued big-auth large 11; write_rows large
  reviewed big-auth dddd4444
  cooldown big-auth dddd4444 "$(( $(date +%s) - 300 ))"
  run_slots "" "UX_SPEC_MOVERS=$(printf '302\tfix-walker')"
  started cooldown-hold-not-a-yield-target small-docs
  not_yielded cooldown-hold-not-a-yield-target small-docs
  not_started cooldown-hold-not-a-yield-target big-auth
}

run() { # <case name> <function>
  if [ -n "$ONLY" ] && [ "$1" != "$ONLY" ]; then return 0; fi
  "$2" || exit 1
  pass "$1"
}

run small-yields-last-slot small_yields_last_slot
run small-starts-under-threshold small_starts_under_threshold
run held-big-still-lets-small-start held_big_still_lets_small_start
run small-keeps-reserved-slot small_keeps_reserved_slot
run medium-counts-as-big medium_counts_as_big
run zero-disables-yield zero_disables_yield
run absent-tier-counts-as-big absent_tier_counts_as_big
run malformed-threshold-falls-back malformed_threshold_falls_back
run one-predicate-two-callers one_predicate_two_callers
run cooldown-skips-same-diff cooldown_skips_same_diff
run cooldown-expired-requeues cooldown_expired_requeues
run cooldown-new-diff-requeues cooldown_new_diff_requeues
run cooldown-unknown-verifies cooldown_unknown_verifies
run cooldown-big-is-not-a-yield-target cooldown_big_is_not_a_yield_target
run cooldown-skips-batch-member cooldown_skips_batch_member
run cooldown-held-for-spec-mover cooldown_held_for_spec_mover
run cooldown-hold-ends-when-mover-merges cooldown_hold_ends_when_mover_merges
run cooldown-hold-skips-self cooldown_hold_skips_self
run cooldown-hold-bounded cooldown_hold_bounded
run cooldown-hold-fails-open-on-new-diff cooldown_hold_fails_open_on_new_diff
run cooldown-hold-not-a-batch-member cooldown_hold_not_a_batch_member
run cooldown-hold-not-a-yield-target cooldown_hold_not_a_yield_target
echo ALL-PASS
