#!/bin/bash
# test-loop-sendback-stale.sh — a rework lane can push the fix while the merge lane is still
# reviewing. Bouncing the PR on the SHA that failed would then hand back a head that already
# contains the fix, burning one of three attempts and 10-20 minutes of lane time. When the live
# PR head differs from the reviewed SHA, sendback() must suppress the bounce, record it under
# sendback/done/ and let the next cycle re-verify the newer head. If the head cannot be read,
# fail closed: write the sendback exactly as today.
#
# Hermetic: temp RSI_CTRL (STATE redirected into it), the PR head stubbed through RSI_PR_HEAD_CMD,
# no network, no git, no locks. Drives merge.sh --stale-check, the early seam that calls the same
# sendback() the land loop calls and exits before PAUSE, locks, fetch, gate, review and dispatch.
# Every case leaves $STATE/PAUSE set: if the seam ever moved behind the PAUSE check the cases fail
# (and a dispatcher run would otherwise reach the real gh).
# Prints "PASS <case>" per case and exits non-zero on the first failure.
# Set RSI_TEST_ONLY=<case name> to run one case (used to show the red run per case).
#
# A second group (`item-*`) lives here because the same merge lane reads the slice id out of the
# PR body, and both readers must agree: `RSI item: **F1**` used to parse as "" at both, so the
# lane silently used R-<slug>, slices.py never marked the slice done and the F1-F3 package.json
# allow-list was bypassed (PR #67, 2026-11-15 13:14-13:34). Those cases drive item_marker.py, the
# one implementation, plus a source guard and the verifier seam (`--item-check`).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
MERGE="$(cd "$HERE/.." && pwd)/merge.sh"
ROOT="$(cd "$HERE/../../.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
SLUG="sendback-stale"
ITEM="R-loop-sendback-stale"
CASE=""; RC=0; DET=""
ONLY="${RSI_TEST_ONLY:-}"

pass() { echo "PASS $*"; }
fail() { echo "FAIL $*" >&2; exit 1; }
st() { echo "$RSI_CTRL/rsi/state"; }
sf() { echo "$(st)/sendback/$SLUG.md"; }
att() { cat "$(st)/merge/$SLUG.attempts" 2>/dev/null || echo 0; }
stale_done() { ls "$(st)/sendback/done/$SLUG.stale-"*.md 2>/dev/null | wc -l | tr -d ' '; }

# --- stub --------------------------------------------------------------------------------------
# RSI_PR_HEAD_CMD replaces the `gh pr view ... --json headRefOid` call. STUB_HEAD_OUT is the live
# head it prints; STUB_HEAD_FAIL=1 makes it exit non-zero (a gh failure or timeout);
# STUB_HEAD_EMPTY_OK=1 exits 0 with no output (gh can succeed and print nothing).
cat > "$T/head-stub.sh" <<'SH'
#!/bin/bash
set -eu
[ -n "${STUB_HEAD_ARG_FILE:-}" ] && printf '%s' "${1:-UNSET}" > "$STUB_HEAD_ARG_FILE"
[ "${STUB_HEAD_FAIL:-0}" = 1 ] && exit 1
[ "${STUB_HEAD_EMPTY_OK:-0}" = 1 ] && exit 0
[ -n "${STUB_HEAD_OUT:-}" ] || exit 1
printf '%s\n' "$STUB_HEAD_OUT"
SH

# new_case <name> — fresh control tree and detail file, PAUSE left set on purpose (see header).
# merge.sh resolves the item parser under RSI_DIR, so each control tree gets its own copy of the
# module at the deployed path: the seam then fails if a reader looks anywhere else.
new_case() {
  CASE="$1"
  RSI_CTRL="$T/ctrl-$CASE"
  rm -rf "$RSI_CTRL"
  mkdir -p "$RSI_CTRL/rsi/state/merge" "$RSI_CTRL/rsi/runtime"
  cp "$ROOT/rsi/runtime/item_marker.py" "$RSI_CTRL/rsi/runtime/item_marker.py"
  touch "$RSI_CTRL/rsi/state/PAUSE"
  DET="$T/$CASE.detail.txt"
  printf 'raw failure report for %s\n' "$CASE" > "$DET"
  STUB_HEAD_OUT=""; STUB_HEAD_FAIL=0; STUB_HEAD_EMPTY_OK=0; STUB_HEAD_ARG_FILE=""
}

# run_seam <pr> <sha> — call merge.sh --stale-check the way the merge lane would call sendback().
# An empty <sha> is passed through as an empty argument (the sync_main conflict path). The override
# reads the PR number as $1, the seam's documented contract.
run_seam() {
  RSI_CTRL="$RSI_CTRL" \
  RSI_PR_HEAD_CMD="bash $T/head-stub.sh \"\$1\"" \
  STUB_HEAD_OUT="$STUB_HEAD_OUT" STUB_HEAD_FAIL="$STUB_HEAD_FAIL" \
  STUB_HEAD_EMPTY_OK="$STUB_HEAD_EMPTY_OK" STUB_HEAD_ARG_FILE="$STUB_HEAD_ARG_FILE" \
    bash "$MERGE" --stale-check "$SLUG" "$ITEM" "$1" "$2" "$DET" > "$T/$CASE.out" 2>&1
  RC=$?
}

# --- cases -------------------------------------------------------------------------------------

# The motivating case: the lane pushed the fix while the review ran. The stale reviewed SHA must
# not cost an attempt or write a sendback; the suppression is recorded for the CEO feed.
test_head_moved_suppresses_sendback() {
  new_case head_moved
  STUB_HEAD_OUT=bbbb2222
  run_seam 242 aaaa1111
  [ "$RC" -eq 0 ] || fail "head_moved: seam exited $RC ($(tr '\n' ' ' < "$T/$CASE.out"))"
  [ ! -e "$(sf)" ] || fail "head_moved: wrote $(sf) for a head that already contains the fix"
  [ ! -e "$(st)/merge/$SLUG.attempts" ] || fail "head_moved: counted an attempt ($(att))"
  [ "$(grep -c . "$(st)/needs-ceo.md" 2>/dev/null || echo 0)" = 1 ] \
    || fail "head_moved: needs-ceo.md is not exactly one line: $(cat "$(st)/needs-ceo.md" 2>/dev/null)"
  grep -q 'PR #242 rsi/sendback-stale: head moved aaaa1111 -> bbbb2222 during review; sendback suppressed' \
    "$(st)/needs-ceo.md" || fail "head_moved: needs-ceo line wrong: $(cat "$(st)/needs-ceo.md")"
  [ -s "$(st)/sendback/done/$SLUG.stale-aaaa1111.md" ] \
    || fail "head_moved: no sendback/done/$SLUG.stale-aaaa1111.md"
  cmp -s "$DET" "$(st)/sendback/done/$SLUG.stale-aaaa1111.md" \
    || fail "head_moved: the stale detail copy is not the failure report"
  grep -q 'head moved past reviewed aaaa1111 -> bbbb2222; sendback suppressed' "$T/$CASE.out" \
    || fail "head_moved: no operator log line ($(tr '\n' ' ' < "$T/$CASE.out"))"
}

# An earlier attempt count survives a suppressed sendback untouched: nothing about the PR's
# rework budget changes when the failure is stale.
test_head_moved_keeps_existing_attempts() {
  new_case head_moved_attempts
  echo 2 > "$(st)/merge/$SLUG.attempts"
  STUB_HEAD_OUT=bbbb2222
  run_seam 242 aaaa1111
  [ "$(att)" = 2 ] || fail "head_moved_attempts: attempts became $(att), want 2"
  [ ! -e "$(sf)" ] || fail "head_moved_attempts: wrote a sendback"
  [ "$(stale_done)" = 1 ] || fail "head_moved_attempts: stale detail copy missing"
}

# The ordinary case still works: the head is the one that was reviewed, so the sendback is real.
test_head_same_writes_sendback() {
  new_case head_same
  STUB_HEAD_OUT=aaaa1111
  run_seam 242 aaaa1111
  [ "$RC" -eq 0 ] || fail "head_same: seam exited $RC"
  [ -s "$(sf)" ] || fail "head_same: no sendback written for the reviewed head"
  [ "$(att)" = 1 ] || fail "head_same: attempts is $(att), want 1"
  [ "$(stale_done)" = 0 ] || fail "head_same: copied a stale detail for an unchanged head"
  [ ! -s "$(st)/needs-ceo.md" ] || fail "head_same: wrote a suppression note"
}

# Fail closed: a gh failure or empty output must never swallow a real failure.
test_head_fetch_failure_fails_closed() {
  new_case head_fail
  STUB_HEAD_FAIL=1
  run_seam 242 aaaa1111
  [ -s "$(sf)" ] || fail "head_fail: no sendback when the head could not be read"
  [ "$(att)" = 1 ] || fail "head_fail: attempts is $(att), want 1"
  [ "$(stale_done)" = 0 ] || fail "head_fail: suppressed on a failed head fetch"
}

# sync_main's mechanical sendback runs before SHA exists; an empty reviewed SHA keeps today's
# behaviour even when the stub would report a different live head.
test_empty_sha_writes_sendback() {
  new_case empty_sha
  STUB_HEAD_OUT=bbbb2222
  run_seam 242 ""
  [ -s "$(sf)" ] || fail "empty_sha: no sendback for an empty reviewed SHA"
  [ "$(att)" = 1 ] || fail "empty_sha: attempts is $(att), want 1"
  [ "$(stale_done)" = 0 ] || fail "empty_sha: suppressed with no SHA to compare against"
}

# gh can succeed and print nothing. No head is no evidence the head moved: fail closed.
test_empty_head_output_fails_closed() {
  new_case head_empty_ok
  STUB_HEAD_EMPTY_OK=1
  run_seam 242 aaaa1111
  [ -s "$(sf)" ] || fail "head_empty_ok: no sendback when the head fetch printed nothing"
  [ "$(att)" = 1 ] || fail "head_empty_ok: attempts is $(att), want 1"
  [ "$(stale_done)" = 0 ] || fail "head_empty_ok: suppressed with no head"
}

# A gh notice on stdout is not an oid. Suppressing on it would swallow a real failure every cycle
# while gate and review re-run; only a well-formed oid may suppress.
test_malformed_head_output_fails_closed() {
  new_case head_malformed
  STUB_HEAD_OUT=$'warning: token scope\nbbbb2222'
  run_seam 242 aaaa1111
  [ -s "$(sf)" ] || fail "head_malformed: no sendback for a non-oid head line"
  [ "$(att)" = 1 ] || fail "head_malformed: attempts is $(att), want 1"
  [ "$(stale_done)" = 0 ] || fail "head_malformed: suppressed on a malformed head"
}

# The seam contract says the command receives <pr-number>: with `bash -c "$CMD" "$1"` it would
# silently become $0. Pin it so a refactor cannot break a real override.
test_head_command_receives_the_pr_number() {
  new_case head_arg
  STUB_HEAD_OUT=aaaa1111
  STUB_HEAD_ARG_FILE="$T/head_arg.txt"
  run_seam 242 aaaa1111
  [ "$(cat "$T/head_arg.txt" 2>/dev/null)" = 242 ] \
    || fail "head_arg: stub saw '$(cat "$T/head_arg.txt" 2>/dev/null)', want 242"
  [ -s "$(sf)" ] || fail "head_arg: the ordinary sendback is missing"
}

run() {
  if [ -n "$ONLY" ] && [ "$1" != "$ONLY" ]; then return 0; fi
  RAN=$((RAN+1))
  "$1" || exit 1
  pass "$1"
}

# --- item marker cases -------------------------------------------------------------------------
# `RSI item:` is hand-written markdown: the id can be wrapped in **, __, ` or ~~, sit after a
# list bullet, or carry a trailing note. Both old readers returned "" for bold and then fell back
# to R-<slug> without a word, so the slice never counted as done. Each shape is pinned below.

# parse_body <text> — run the same command the verifier runs, against this case's control tree.
parse_body() { printf '%s\n' "$1" | python3 "$RSI_CTRL/rsi/runtime/item_marker.py"; }
# item_check <body-file> — drive merge.sh --item-check, the verifier seam (parse + fallback).
item_check() {
  RSI_CTRL="$RSI_CTRL" bash "$MERGE" --item-check "$SLUG" "$1" 2>&1
}
# want_item <case> <body> <expected> — one parser shape; the failure prints what was seen.
want_item() {
  new_case "$1"
  local got; got="$(parse_body "$2")"
  [ "$got" = "$3" ] || fail "$1: parsed '$got' from '$2', want '$3'"
}

test_item_bold() { want_item item-bold 'RSI item: **F1**' F1; }
test_item_bold_no_space() { want_item item-bold-no-space 'RSI item:**F1**' F1; }
test_item_underscore() { want_item item-underscore 'RSI item: __R-x__' R-x; }
test_item_code_span() { want_item item-code-span 'RSI item: `F5a`' F5a; }
test_item_list_line() { want_item item-list-line '- RSI item: R-z — note' R-z; }
test_item_trailing_note() { want_item item-trailing-note 'RSI item: F1 (part a)' F1; }
test_item_absent() { want_item item-absent 'no marker here' ''; }
test_item_empty_marker() { want_item item-empty-marker 'RSI item: **' ''; }
test_item_not_a_prefix() { want_item item-not-a-prefix 'RSI items: F1' ''; }

# Ids already on main must parse exactly as before: the fix may not rename a slice.
test_item_existing_ids() {
  new_case item_existing_ids
  local id got
  for id in R-result003-covered F5a R-walk-mutant; do
    got="$(parse_body "RSI item: $id")"
    [ "$got" = "$id" ] || fail "item-existing-ids: parsed '$got', want '$id'"
  done
}

# Bonus: the bold case through the verifier seam, so the id reaching slices.py is proven, not
# just the parser. `--item-check` calls the same item_id() the verifier uses, including R-<slug>.
test_item_bold_verifier_seam() {
  new_case item_bold_seam
  printf 'opening line\nRSI item: **F1**\n\nbody\n' > "$T/$CASE.body"
  local got; got="$(item_check "$T/$CASE.body")"
  [ "$got" = F1 ] || fail "item-bold-verifier: seam printed '$got', want F1 (fell back to R-$SLUG)"
}

# The fallback is the only fallback: no marker (or an empty one) still resolves to R-<slug>.
test_item_absent_verifier_fallback() {
  new_case item_absent_seam
  printf 'RSI item: **\n' > "$T/$CASE.body"
  local got; got="$(item_check "$T/$CASE.body")"
  [ "$got" = "R-$SLUG" ] || fail "item-absent-verifier: seam printed '$got', want R-$SLUG"
}

# Source guard (test-utf8-truncation.sh's pattern): both readers in merge.sh delegate, and the
# marker literal lives only in item_marker.py, so no inline regex can drift from the rule again.
test_item_one_implementation() {
  local f="$ROOT/rsi/runtime/merge.sh"
  [ -f "$f" ] || fail "item-one-implementation: missing $f"
  grep -q 'item_marker.py' "$f" \
    || fail "item-one-implementation: merge.sh no longer calls runtime/item_marker.py"
  grep -q 'from item_marker import parse_item' "$f" \
    || fail "item-one-implementation: the dispatcher reader does not import the shared parser"
  if grep -n 'RSI item:' "$f" >&2; then
    fail "item-one-implementation: merge.sh carries an inline marker reader; call item_id/item_marker.py"
  fi
}

# run_item <case-name> <function> — RSI_TEST_ONLY accepts either the case name or the function.
run_item() {
  if [ -n "$ONLY" ] && [ "$ONLY" != "$1" ] && [ "$ONLY" != "$2" ]; then return 0; fi
  RAN=$((RAN+1))
  "$2" || exit 1
  pass "$1"
}

RAN=0
run test_head_moved_suppresses_sendback
run test_head_moved_keeps_existing_attempts
run test_head_same_writes_sendback
run test_head_fetch_failure_fails_closed
run test_empty_sha_writes_sendback
run test_empty_head_output_fails_closed
run test_malformed_head_output_fails_closed
run test_head_command_receives_the_pr_number
run_item item-bold test_item_bold
run_item item-bold-no-space test_item_bold_no_space
run_item item-underscore test_item_underscore
run_item item-code-span test_item_code_span
run_item item-list-line test_item_list_line
run_item item-trailing-note test_item_trailing_note
run_item item-absent test_item_absent
run_item item-empty-marker test_item_empty_marker
run_item item-not-a-prefix test_item_not_a_prefix
run_item item-existing-ids test_item_existing_ids
run_item item-bold-verifier test_item_bold_verifier_seam
run_item item-absent-verifier test_item_absent_verifier_fallback
run_item item-one-implementation test_item_one_implementation
[ "$RAN" -gt 0 ] || fail "RSI_TEST_ONLY='$ONLY' matched no case"
echo ALL-PASS
