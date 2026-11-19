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
# Exercises merge.sh --ceo-ok-check, which runs the same ceo_ok_verdict() the hold block calls.
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
echo ALL-PASS
