#!/bin/bash
# test-merge-ceo-ok.sh — a deps/migrations/auth PR may pass the merge gate only when the CEO has
# recorded the owner's approval for that exact PR in state/merge/<slug>.ceo-ok.
#
# The hold at merge.sh step 2 exists so a dependency, migration or auth change never lands on an
# agent's word alone (MANDATE: needs CEO + ADR). Cleared by hand, it leaves no record of what the
# owner approved or when. The marker carries it: one line, four fields, and only the CEO writes it
# (same ownership rule as *.size-ok). A valid marker clears this one hold; a missing or incomplete
# marker keeps today's hold byte for byte, and the gate and independent review still run.
#
#   source=thread <id> · quote "<the owner's words>" · <YYYY-MM-DDTHH:MM±HH:MM> · pr <number>
#
# Hermetic: mktemp -d only. No git repo, no network, no state dirs, no gh. RSI_CTRL points at a
# temp tree holding PAUSE, so even an unwired seam falls through the dispatcher without side effects.
#
# Exercises merge.sh --ceo-ok-check, which runs the same ceo_ok_verdict() the hold block calls, and
# --ceo-hold-check / --dispatch-rows-check, which run the same ceo_hold_skip() and row filter the
# dispatcher uses: a marker naming this PR must release an older .blocked skip and the
# needs-ceo/hold labels, while a marker for another PR or a re-block written after the marker must
# not, otherwise the promise (the next verifier cycle merges, no manual hold edit) is never kept.
# Prints "PASS <case>" per case and exits non-zero on the first failure.
# Set RSI_TEST_ONLY=<case name> to run one case.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
MERGE="$(cd "$HERE/.." && pwd)/merge.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/ctrl/rsi/state"; : > "$T/ctrl/rsi/state/PAUSE"
R=""; RC=0; OUT=""
ONLY="${RSI_TEST_ONLY:-}"
MIGRATION='internal/store/migrations/0007_add_thing.sql'
AUTH='internal/auth/session.go'
CORS='internal/api/cors.go'
SECURE='internal/api/secure.go'
UNRELATED='ui/src/components/chat/ChatStream.tsx'
GOOD='source=thread thread-1 · quote "ship it" · 2026-11-19T09:00+08:00 · pr 352'

pass() { echo "PASS $*"; }
fail() { echo "FAIL $*" >&2; exit 1; }

# check <marker content | ABSENT> <changed paths> [pr] — call the seam. Sets RC and OUT.
check() {
  M="$T/marker"; CH="$T/changed"
  if [ "$1" = ABSENT ]; then rm -f "$M"; else printf '%s\n' "$1" > "$M"; fi
  printf '%s\n' "$2" > "$CH"
  RSI_CTRL="$T/ctrl" bash "$MERGE" --ceo-ok-check "$M" "$CH" "${3:-352}" > "$T/out" 2>&1
  RC=$?; OUT="$(cat "$T/out")"
}

expect_clear() { # <case>
  [ "$RC" -eq 0 ] || fail "$1: rc=$RC, want 0 ($OUT)"
  case "$OUT" in CLEAR*) ;; *) fail "$1: output is '$OUT', want a CLEAR line" ;; esac
}

expect_hold() { # <case>
  [ "$RC" -eq 1 ] || fail "$1: rc=$RC, want 1 ($OUT)"
  case "$OUT" in HOLD*) ;; *) fail "$1: output is '$OUT', want a HOLD line" ;; esac
}

expect_nohold() { # <case>
  [ "$RC" -eq 0 ] || fail "$1: rc=$RC, want 0 ($OUT)"
  case "$OUT" in NOHOLD*) ;; *) fail "$1: output is '$OUT', want a NOHOLD line" ;; esac
}

expect_exempt() { # <case>
  [ "$RC" -eq 3 ] || fail "$1: rc=$RC, want 3 ($OUT)"
  case "$OUT" in EXEMPT*) ;; *) fail "$1: output is '$OUT', want an EXEMPT line" ;; esac
}

# check_redline <item> <changed paths> [marker content | ABSENT] [pr] — call the step-2 hold
# decision seam. The changed-paths argument is deliberately word-split: each path is one line.
# Sets RC and OUT.
check_redline() {
  local slug=redline pr="${4:-352}"
  RH="$T/redline-changed"
  rm -f "$SM/$slug.ceo-ok"
  printf '%s\n' $2 > "$RH"
  [ "${3:-ABSENT}" = ABSENT ] || printf '%s\n' "$3" > "$SM/$slug.ceo-ok"
  RSI_CTRL="$T/ctrl" bash "$MERGE" --redline-hold-check "$RH" "$slug" "$1" "$pr" > "$T/out" 2>&1
  RC=$?; OUT="$(cat "$T/out")"
  rm -f "$SM/$slug.ceo-ok"
}

# A migration change with a marker naming this PR and the owner's words: the class holds no more.
accept_valid_migration_marker() { check "$GOOD" "$MIGRATION"; expect_clear accept-valid-migration-marker; }

# internal/auth is the same class, cleared by the same marker.
accept_valid_auth_marker() { check "$GOOD" "$AUTH"; expect_clear accept-valid-auth-marker; }

# No marker: today's hold.
refuse_missing_marker() { check ABSENT "$MIGRATION"; expect_hold refuse-missing-marker; }

# An empty marker proves nothing.
refuse_empty_marker() { check "" "$MIGRATION"; expect_hold refuse-empty-marker; }

# Every field but quote=: not the owner's words.
refuse_marker_without_quote() {
  check 'source=thread thread-1 · 2026-11-19T09:00+08:00 · pr 352' "$MIGRATION"
  expect_hold refuse-marker-without-quote
}

# Every field but source=: no provenance.
refuse_marker_without_source() {
  check 'quote "ship it" · 2026-11-19T09:00+08:00 · pr 352' "$MIGRATION"
  expect_hold refuse-marker-without-source
}

# Every field but the timestamp: no record of when the owner approved.
refuse_marker_without_time() {
  check 'source=thread thread-1 · quote "ship it" · pr 352' "$MIGRATION"
  expect_hold refuse-marker-without-time
}

# A marker for another PR must not approve this one on the same slug.
refuse_marker_for_another_pr() {
  check 'source=thread thread-9 · quote "ship it" · 2026-11-19T09:00+08:00 · pr 111' "$MIGRATION"
  expect_hold refuse-marker-for-another-pr
}

# source=thread TODO is a placeholder, not provenance.
refuse_placeholder_source() {
  check 'source=thread TODO · quote "ship it" · 2026-11-19T09:00+08:00 · pr 352' "$MIGRATION"
  expect_hold refuse-placeholder-source
}

# No deps/migrations/auth path: the marker is irrelevant either way, and the seam never holds.
no_hold_unrelated_paths() {
  check "$GOOD" "$UNRELATED"; expect_nohold no-hold-unrelated-paths
  check ABSENT "$UNRELATED"; expect_nohold no-hold-unrelated-paths
}

# --- red-line path list: deps, migrations, auth, and permission-boundary middleware --------------
# The CORS origin allow-list and the secure/CSRF middleware decide who may read the Hub from which
# origin; changing either is a permission change, held exactly like go.mod/migrations/auth.
hold_cors_origin_list() { check_redline R-x "$CORS"; expect_hold hold-cors-origin-list; }
hold_secure_middleware() { check_redline R-x "$SECURE"; expect_hold hold-secure-middleware; }

# The same marker rule clears it: valid for this PR clears, another PR's keeps the hold.
hold_cors_marker_clears() { check_redline R-x "$CORS" "$GOOD"; expect_clear hold-cors-marker-clears; }
hold_cors_stale_marker_keeps() {
  check_redline R-x "$CORS" 'source=thread thread-9 · quote "ship it" · 2026-11-19T09:00+08:00 · pr 111'
  expect_hold hold-cors-stale-marker-keeps
}

# The router and a test file are not permission boundaries: ordinary changes keep the normal gate.
no_hold_api_router() { check_redline R-x 'internal/api/api.go'; expect_clear no-hold-api-router; }
no_hold_cors_test_only() { check_redline R-x 'internal/api/cors_test.go'; expect_clear no-hold-cors-test-only; }

# Existing classes still hold; unrelated paths still do not.
hold_go_mod_still() { check_redline R-x 'go.mod'; expect_hold hold-go-mod-still; }
no_hold_docs() { check_redline R-x 'docs/product/IA.md'; expect_clear no-hold-docs; }

# The Astryx F1-F3 package.json exemption survives, and does not swallow a red-line path.
f2_package_only_exempt() { check_redline F2 'ui/package.json'; expect_exempt f2-package-only-exempt; }
f2_package_with_cors_stays_held() {
  check_redline F2 'ui/package.json internal/api/cors.go'
  expect_hold f2-package-with-cors-stays-held
}

# --- dispatcher holds: the marker releases the skip, not only the verifier's path check ----------
# A held deps/migrations/auth PR writes <slug>.blocked and the dispatcher used to skip it forever;
# the needs-ceo/hold labels are the same hold one step earlier. Both skips call ceo_hold_skip().
SM="$T/ctrl/rsi/state/merge"; mkdir -p "$SM"
# The row filter imports these from the temp RSI_DIR; copying (not linking) keeps common.sh's
# +x heal off the real tree.
mkdir -p "$T/ctrl/rsi/runtime"
cp "$HERE/../item_marker.py" "$HERE/../review-tier.py" "$HERE/../pr_select.py" "$T/ctrl/rsi/runtime/"

# check_hold <slug> <labels> [pr] — the dispatcher's hold skip for one row. Sets RC and OUT.
check_hold() {
  RSI_CTRL="$T/ctrl" bash "$MERGE" --ceo-hold-check "$1" "${2:-}" "${3:-352}" > "$T/out" 2>&1
  RC=$?; OUT="$(cat "$T/out")"
}
expect_skip() { # <case>
  [ "$RC" -eq 1 ] || fail "$1: rc=$RC, want 1 ($OUT)"
  case "$OUT" in SKIP*) ;; *) fail "$1: output is '$OUT', want a SKIP line" ;; esac
}
expect_allow() { # <case>
  [ "$RC" -eq 0 ] || fail "$1: rc=$RC, want 0 ($OUT)"
  [ "$OUT" = ALLOW ] || fail "$1: output is '$OUT', want ALLOW"
}

# A .blocked hold older than the marker no longer skips a slug the marker approves.
release_clears_blocked_hold() {
  : > "$SM/a.blocked"; rm -f "$SM/a.ceo-ok"; touch -t 202601010000 "$SM/a.blocked"
  check_hold a ""; expect_skip release-clears-blocked-hold
  printf '%s\n' "$GOOD" > "$SM/a.ceo-ok"
  check_hold a ""; expect_allow release-clears-blocked-hold
  rm -f "$SM/a.blocked" "$SM/a.ceo-ok"
}

# A block written after the approval is a new hold (a re-block, or a hold for another reason) and
# outranks the marker: releasing it every dispatch would run a full gate + review per cycle on a PR
# the loop has already decided to hold, and each block trips notify/consec_blocked again.
reblock_after_marker_keeps_hold() {
  printf '%s\n' "$GOOD" > "$SM/d.ceo-ok"; touch -t 202601010000 "$SM/d.ceo-ok"
  : > "$SM/d.blocked"
  check_hold d ""; expect_skip reblock-after-marker-keeps-hold
  rm -f "$SM/d.blocked" "$SM/d.ceo-ok"
}

# An empty marker is not an approval: the hold stays exactly as it was.
empty_marker_keeps_blocked_hold() {
  : > "$SM/b.blocked"; : > "$SM/b.ceo-ok"
  check_hold b ""; expect_skip empty-marker-keeps-blocked-hold
  rm -f "$SM/b.blocked" "$SM/b.ceo-ok"
}

# The needs-ceo and hold labels are the same CEO hold, released by the same marker.
release_clears_label_hold() {
  rm -f "$SM/c.ceo-ok"
  check_hold c "needs-ceo"; expect_skip release-clears-label-hold
  check_hold c "ui,hold"; expect_skip release-clears-label-hold
  printf '%s\n' "$GOOD" > "$SM/c.ceo-ok"
  check_hold c "needs-ceo"; expect_allow release-clears-label-hold
  check_hold c "ui,hold"; expect_allow release-clears-label-hold
  rm -f "$SM/c.ceo-ok"
}

# The marker is bound to its PR, and the verifier does not re-validate it for a red-line PR with no
# deps/migrations/auth path: without this check a stale marker on a reused slug releases the label
# and gate+review alone decide. A marker naming this PR still releases it.
wrong_pr_marker_keeps_label_hold() {
  printf '%s\n' 'source=thread thread-9 · quote "ship it" · 2026-11-19T09:00+08:00 · pr 111' > "$SM/e.ceo-ok"
  check_hold e "needs-ceo" 352; expect_skip wrong-pr-marker-keeps-label-hold
  check_hold e "hold" 352; expect_skip wrong-pr-marker-keeps-label-hold
  check_hold e "needs-ceo" 111; expect_allow wrong-pr-marker-keeps-label-hold
  rm -f "$SM/e.ceo-ok"
}

# The row filter hands a labelled PR to the loop with its labels instead of dropping it (the old
# filter did), so the exemption above is reachable at all.
labelled_row_reaches_the_loop() {
  local out
  out="$(printf '%s' '[
    {"number":7,"headRefName":"rsi/held-pr","isDraft":false,"labels":[{"name":"needs-ceo"}],"title":"t","body":"","files":[]},
    {"number":8,"headRefName":"rsi/draft-pr","isDraft":true,"labels":[],"title":"t","body":""},
    {"number":9,"headRefName":"feat/x","isDraft":false,"labels":[],"title":"t","body":""}
  ]' | RSI_CTRL="$T/ctrl" bash "$MERGE" --dispatch-rows-check 2>&1)" \
    || fail "labelled-row-reaches-the-loop: row filter failed: $out"
  printf '%s\n' "$out" | grep -q $'^7\theld-pr\t.*\tneeds-ceo$' \
    || fail "labelled-row-reaches-the-loop: no needs-ceo row: $out"
  if printf '%s\n' "$out" | grep -qE 'draft-pr|feat/x'; then fail "labelled-row-reaches-the-loop: a dropped head survived: $out"; fi
  return 0
}

run() { # <case name> <function>
  if [ -n "$ONLY" ] && [ "$1" != "$ONLY" ]; then return 0; fi
  "$2" || exit 1
  pass "$1"
}

run accept-valid-migration-marker accept_valid_migration_marker
run accept-valid-auth-marker accept_valid_auth_marker
run refuse-missing-marker refuse_missing_marker
run refuse-empty-marker refuse_empty_marker
run refuse-marker-without-quote refuse_marker_without_quote
run refuse-marker-without-source refuse_marker_without_source
run refuse-marker-without-time refuse_marker_without_time
run refuse-marker-for-another-pr refuse_marker_for_another_pr
run refuse-placeholder-source refuse_placeholder_source
run no-hold-unrelated-paths no_hold_unrelated_paths
run hold-cors-origin-list hold_cors_origin_list
run hold-secure-middleware hold_secure_middleware
run hold-cors-marker-clears hold_cors_marker_clears
run hold-cors-stale-marker-keeps hold_cors_stale_marker_keeps
run no-hold-api-router no_hold_api_router
run no-hold-cors-test-only no_hold_cors_test_only
run hold-go-mod-still hold_go_mod_still
run no-hold-docs no_hold_docs
run f2-package-only-exempt f2_package_only_exempt
run f2-package-with-cors-stays-held f2_package_with_cors_stays_held
run release-clears-blocked-hold release_clears_blocked_hold
run reblock-after-marker-keeps-hold reblock_after_marker_keeps_hold
run empty-marker-keeps-blocked-hold empty_marker_keeps_blocked_hold
run release-clears-label-hold release_clears_label_hold
run wrong-pr-marker-keeps-label-hold wrong_pr_marker_keeps_label_hold
run labelled-row-reaches-the-loop labelled_row_reaches_the_loop
echo ALL-PASS
