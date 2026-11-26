#!/bin/bash
# test-merge-pr-select.sh — a legitimate rsi/ceo-* PR must reach the merge lane.
#
# The PR-selection filter skipped every head starting with rsi/ceo-, not just the loop's own
# control branch. PR #392 (head rsi/ceo-ok-marker) therefore sat open with zero cycles.log
# entries while other PRs were verified; it had to be re-opened from another head as #395.
# Only rsi/ceo-loop — the loop's working branch, auto-synced to origin/main, never a
# deliverable — is a control branch. The same shape hit the dream rule: the DREAM job's own
# branch is rsi/dream-<date>, but the filter skipped every rsi/dream-* head, so #535
# (rsi/dream-phone-line, a real slice) sat green and MERGEABLE with zero cycles.log entries.
# Only the date-stamped dream branch is excluded now; a dream-* deliverable is selected.
#
# One predicate (rsi/runtime/pr_select.py) now answers both callers: the dispatcher's row
# filter and the open-PR backpressure counter in common.sh. The row filter leaves the
# needs-ceo/hold labels to ceo_hold_skip() one step later, so a CEO marker can still release a
# labelled hold (test-merge-ceo-ok.sh pins that); the selector applies them because a held PR
# is not a candidate.
#
# Hermetic: mktemp dirs, no network, no gh (a fake gh on GH only for the backpressure case).
# Exercises merge.sh --pr-select-check (the selection seam, no lock/fetch/state write) and
# rsi_open_pr_counts() as common.sh defines it. The PAUSE flag in the temp control tree means
# even an unwired seam falls through the dispatcher without reaching gh or dispatch.
# Prints "PASS <case>" per case and exits non-zero on the first failure.
# Set RSI_TEST_ONLY=<case name> to run one case (used to show the red run per case).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
RSI="$(cd "$HERE/../.." && pwd)"                 # the rsi/ dir: RSI_DIR for merge.sh and common.sh
MERGE="$RSI/runtime/merge.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
ONLY="${RSI_TEST_ONLY:-}"
RC=0; OUT=""
# A PAUSE flag covers the red run on an unmodified merge.sh: the seam does not exist there, so
# the dispatcher path is entered, and PAUSE is the first thing it honours — no gh, fetch or
# dispatch happens either way.
mkdir -p "$T/ctrl/rsi/state"; : > "$T/ctrl/rsi/state/PAUSE"
# The row filter imports these next to merge.sh; copying keeps common.sh's +x heal off the
# real tree. pr_select.py is absent during the red run, which only makes the red redder.
mkdir -p "$T/ctrl/rsi/runtime"
for f in item_marker.py review-tier.py pr_select.py; do
  [ -f "$RSI/runtime/$f" ] && cp "$RSI/runtime/$f" "$T/ctrl/rsi/runtime/"
done

pass() { echo "PASS $*"; }
fail() { echo "FAIL $*" >&2; exit 1; }

# run_select <fixture.json> — run the selection seam over a gh `pr list` array. Sets RC and OUT.
run_select() {
  RSI_CTRL="$T/ctrl" bash "$MERGE" --pr-select-check < "$1" > "$T/out" 2>&1
  RC=$?; OUT="$(cat "$T/out")"
}

# expect_one <case> <slug> — exactly one selected row, and its slug is <slug>.
expect_one() {
  local rows
  [ "$RC" -eq 0 ] || fail "$1: selection failed rc=$RC ($OUT)"
  rows="$(printf '%s\n' "$OUT" | grep -c . || true)"
  [ "$rows" -eq 1 ] || fail "$1: want exactly 1 row, got $rows: $OUT"
  [ "$(printf '%s\n' "$OUT" | cut -f2)" = "$2" ] \
    || fail "$1: slug is '$(printf '%s\n' "$OUT" | cut -f2)', want '$2' ($OUT)"
}

# expect_none <case> — the seam exists and selected nothing.
expect_none() {
  [ "$RC" -eq 0 ] || fail "$1: selection failed rc=$RC ($OUT)"
  [ -z "$OUT" ] || fail "$1: want no rows, got: $OUT"
}

# --- fixtures ----------------------------------------------------------------------------------
# One PR shaped like the one that was stranded: a CEO-named head, a claimed item, no labels.
cat > "$T/ceo.json" <<'EOF'
[{"number":392,"headRefName":"rsi/ceo-ok-marker","isDraft":false,"labels":[],
  "title":"feat(rsi): let a CEO approval marker clear the deps hold",
  "body":"Symptom: the hold never cleared.\n\nRSI item: R-ceo-ok-marker\n",
  "files":[{"path":"rsi/runtime/merge.sh","additions":10,"deletions":2}]}]
EOF
cat > "$T/control.json" <<'EOF'
[{"number":401,"headRefName":"rsi/ceo-loop","isDraft":false,"labels":[],"title":"loop",
  "body":"","files":[{"path":"rsi/runtime/merge.sh","additions":1,"deletions":0}]}]
EOF
cat > "$T/dream.json" <<'EOF'
[{"number":402,"headRefName":"rsi/dream-2026-11-19","isDraft":false,"labels":[],"title":"dream",
  "body":"","files":[{"path":"rsi/runtime/merge.sh","additions":1,"deletions":0}]}]
EOF
cat > "$T/dream-compact.json" <<'EOF'
[{"number":507,"headRefName":"rsi/dream-20261121","isDraft":false,"labels":[],"title":"dream",
  "body":"","files":[{"path":"rsi/DECISIONS.md","additions":3,"deletions":0}]}]
EOF
# A deliverable whose head happens to start with dream- is not the DREAM job's branch (#535).
cat > "$T/dream-deliverable.json" <<'EOF'
[{"number":535,"headRefName":"rsi/dream-phone-line","isDraft":false,"labels":[],
  "title":"feat(rsi): make the phone line part of the DREAM report contract",
  "body":"RSI item: R-dream-phone-line",
  "files":[{"path":"rsi/runtime/prompts/dream.md","additions":3,"deletions":1}]}]
EOF
cat > "$T/non-rsi.json" <<'EOF'
[{"number":403,"headRefName":"feat/console","isDraft":false,"labels":[],"title":"console",
  "body":"","files":[{"path":"ui/src/App.tsx","additions":1,"deletions":0}]}]
EOF
cat > "$T/draft.json" <<'EOF'
[{"number":404,"headRefName":"rsi/wip-slice","isDraft":true,"labels":[],"title":"wip",
  "body":"RSI item: R-wip-slice","files":[{"path":"rsi/runtime/merge.sh","additions":1,"deletions":0}]}]
EOF
cat > "$T/hold.json" <<'EOF'
[{"number":405,"headRefName":"rsi/held-slice","isDraft":false,"labels":[{"name":"hold"}],"title":"held",
  "body":"RSI item: R-held-slice","files":[{"path":"rsi/runtime/merge.sh","additions":1,"deletions":0}]}]
EOF
cat > "$T/needs-ceo.json" <<'EOF'
[{"number":406,"headRefName":"rsi/ceo-slice","isDraft":false,"labels":[{"name":"needs-ceo"}],"title":"held",
  "body":"RSI item: R-ceo-slice","files":[{"path":"rsi/runtime/merge.sh","additions":1,"deletions":0}]}]
EOF
# Small-safe (docs-only) before large (a risky auth path), then by PR number among equals.
# The large one has the LOWEST number and must still come last.
cat > "$T/order.json" <<'EOF'
[{"number":10,"headRefName":"rsi/large-pr","isDraft":false,"labels":[],"title":"large",
  "body":"RSI item: R-large-pr","files":[{"path":"internal/auth/session.go","additions":1,"deletions":0}]},
 {"number":21,"headRefName":"rsi/small-b","isDraft":false,"labels":[],"title":"small b",
  "body":"RSI item: R-small-b","files":[{"path":"docs/b.md","additions":1,"deletions":0}]},
 {"number":20,"headRefName":"rsi/small-a","isDraft":false,"labels":[],"title":"small a",
  "body":"RSI item: R-small-a","files":[{"path":"docs/a.md","additions":1,"deletions":0}]}]
EOF
# Two small-safe PRs for the queue-wait order: the higher-numbered one listed second.
cat > "$T/fifo.json" <<'EOF'
[{"number":784,"headRefName":"rsi/rework-loop","isDraft":false,"labels":[],"title":"small a",
  "body":"RSI item: R-rework-loop","files":[{"path":"docs/a.md","additions":1,"deletions":0}]},
 {"number":790,"headRefName":"rsi/settings-coarse-links","isDraft":false,"labels":[],"title":"small b",
  "body":"RSI item: R-settings-coarse-links","files":[{"path":"docs/b.md","additions":1,"deletions":0}]}]
EOF

# --- cases -------------------------------------------------------------------------------------

# The motivating case: a CEO-named head with a claimed item is selected, not skipped.
ceo_pr_claimed() {
  run_select "$T/ceo.json"
  expect_one ceo-pr-claimed ceo-ok-marker
}

# The loop's own working branch is the one rsi/ceo-* head that stays excluded.
control_branch_skipped() {
  run_select "$T/control.json"
  expect_none control-branch-skipped
}

# The DREAM job's date branch is not a deliverable; both date spellings it has used stay out.
dream_branch_skipped() {
  run_select "$T/dream.json"
  expect_none dream-branch-skipped
}
dream_compact_date_skipped() {
  run_select "$T/dream-compact.json"
  expect_none dream-compact-date-skipped
}

# A real slice named dream-* is selected: the prefix rule stranded #535 for 2.5 hours.
dream_deliverable_selected() {
  run_select "$T/dream-deliverable.json"
  expect_one dream-deliverable-selected dream-phone-line
}

# Regression pins: selection stays rsi/* only, non-draft, and not a labelled CEO hold.
non_rsi_skipped() {
  run_select "$T/non-rsi.json"
  expect_none non-rsi-skipped
}
draft_skipped() {
  run_select "$T/draft.json"
  expect_none draft-skipped
}
hold_label_skipped() {
  run_select "$T/hold.json"
  expect_none hold-label-skipped
}
needs_ceo_label_skipped() {
  run_select "$T/needs-ceo.json"
  expect_none needs-ceo-label-skipped
}

# The extraction must not reorder: small-safe first, then longest-waiting, then PR number.
small_before_large() {
  local got
  run_select "$T/order.json"
  [ "$RC" -eq 0 ] || fail "small-before-large: selection failed rc=$RC ($OUT)"
  got="$(printf '%s\n' "$OUT" | cut -f2 | paste -sd, -)"
  [ "$got" = "small-a,small-b,large-pr" ] \
    || fail "small-before-large: order is '$got', want 'small-a,small-b,large-pr' ($OUT)"
}

# A small that has been eligible longest is served first: #790 waited 200 minutes while the
# lower-numbered #784 re-queued a minute ago, so #790's row must come first. Before the
# longest-waiting sort, #784 always won on number and #790 starved with "small slots busy".
longest_waiting_first() {
  rm -rf "$T/ctrl/rsi/state/merge"; mkdir -p "$T/ctrl/rsi/state/merge"
  echo $(( $(date +%s) - 200 * 60 )) > "$T/ctrl/rsi/state/merge/settings-coarse-links.queued_at"
  echo $(( $(date +%s) - 60 )) > "$T/ctrl/rsi/state/merge/rework-loop.queued_at"
  run_select "$T/fifo.json"
  local got
  [ "$RC" -eq 0 ] || fail "longest-waiting-first: selection failed rc=$RC ($OUT)"
  got="$(printf '%s\n' "$OUT" | cut -f2 | paste -sd, -)"
  [ "$got" = "settings-coarse-links,rework-loop" ] \
    || fail "longest-waiting-first: order is '$got', want 'settings-coarse-links,rework-loop' ($OUT)"
}

# A PR that has never been eligible has no .queued_at: those sort after waiting ones, then by
# number — the old order is preserved when nothing has waited.
never_queued_orders_by_number() {
  rm -rf "$T/ctrl/rsi/state/merge"
  run_select "$T/fifo.json"
  local got
  [ "$RC" -eq 0 ] || fail "never-queued-orders-by-number: selection failed rc=$RC ($OUT)"
  got="$(printf '%s\n' "$OUT" | cut -f2 | paste -sd, -)"
  [ "$got" = "rework-loop,settings-coarse-links" ] \
    || fail "never-queued-orders-by-number: order is '$got', want 'rework-loop,settings-coarse-links' ($OUT)"
}

# A PR that has never been eligible still comes after one that has waited: only #790 has a
# .queued_at (120 minutes old), and #784 must sort after it. If the never-queued default
# regresses from sys.maxsize to 0, a brand-new PR jumps every PR already in the queue and
# only this case notices.
never_queued_after_waiting() {
  rm -rf "$T/ctrl/rsi/state/merge"; mkdir -p "$T/ctrl/rsi/state/merge"
  echo $(( $(date +%s) - 120 * 60 )) > "$T/ctrl/rsi/state/merge/settings-coarse-links.queued_at"
  run_select "$T/fifo.json"
  local got
  [ "$RC" -eq 0 ] || fail "never-queued-after-waiting: selection failed rc=$RC ($OUT)"
  got="$(printf '%s\n' "$OUT" | cut -f2 | paste -sd, -)"
  [ "$got" = "settings-coarse-links,rework-loop" ] \
    || fail "never-queued-after-waiting: order is '$got', want 'settings-coarse-links,rework-loop' ($OUT)"
}

# The backpressure counter shares the same predicate: a CEO-named PR is active again, a dream
# PR is not. Total counts every open PR, as before.
backpressure_counts_ceo_pr() {
  local bp="$T/bp" out
  rm -rf "$bp"; mkdir -p "$bp/bin" "$bp/state" "$bp/ctrl/rsi/state"
  cat > "$bp/prs.json" <<'EOF'
[{"number":392,"headRefName":"rsi/ceo-ok-marker","isDraft":false,"labels":[]},
 {"number":402,"headRefName":"rsi/dream-2026-11-19","isDraft":false,"labels":[]}]
EOF
  cat > "$bp/bin/gh" <<'EOF'
#!/bin/bash
cat "$GH_FIXTURE"
EOF
  chmod +x "$bp/bin/gh"
  out="$(RSI_CTRL="$bp/ctrl" RUNTIME="$RSI" TMPSTATE="$bp/state" TMPGH="$bp/bin/gh" \
    GH_FIXTURE="$bp/prs.json" bash -c '
      set -u
      source "$RUNTIME/runtime/common.sh"
      RSI_DIR="$RUNTIME"; STATE="$TMPSTATE"; GH="$TMPGH"; GH_REPO=owner/example
      unset RSI_OPEN_PR_COUNT
      rsi_open_pr_counts
    ' 2>&1)" || fail "backpressure-counts-ceo-pr: rsi_open_pr_counts failed ($out)"
  [ "$out" = "1 2" ] \
    || fail "backpressure-counts-ceo-pr: got '$out', want '1 2' (active total)"
}

# Both call sites read the one module. A re-inlined rsi/ceo-* exclusion is this bug coming back.
shared_predicate_wired() {
  local f
  for f in "$MERGE" "$RSI/runtime/common.sh"; do
    grep -q 'from pr_select import is_candidate' "$f" \
      || fail "shared-predicate-wired: $f does not import the shared predicate"
    if grep -q 'startswith("rsi/ceo-")' "$f"; then
      fail "shared-predicate-wired: $f carries an inline rsi/ceo-* exclusion again"
    fi
    if grep -q 'startswith("rsi/dream-")' "$f"; then
      fail "shared-predicate-wired: $f carries an inline rsi/dream-* prefix exclusion again"
    fi
  done
}

run() { # <case name> <function>
  if [ -n "$ONLY" ] && [ "$1" != "$ONLY" ]; then return 0; fi
  "$2" || exit 1
  pass "$1"
}

run ceo-pr-claimed ceo_pr_claimed
run control-branch-skipped control_branch_skipped
run dream-branch-skipped dream_branch_skipped
run dream-compact-date-skipped dream_compact_date_skipped
run dream-deliverable-selected dream_deliverable_selected
run non-rsi-skipped non_rsi_skipped
run draft-skipped draft_skipped
run hold-label-skipped hold_label_skipped
run needs-ceo-label-skipped needs_ceo_label_skipped
run small-before-large small_before_large
run longest-waiting-first longest_waiting_first
run never-queued-orders-by-number never_queued_orders_by_number
run never-queued-after-waiting never_queued_after_waiting
run backpressure-counts-ceo-pr backpressure_counts_ceo_pr
run shared-predicate-wired shared_predicate_wired
echo ALL-PASS
