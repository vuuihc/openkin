#!/bin/bash
# test-optional-grace.sh — an optional walk step must wait out one paint before it says "n".
#
# Two rules are proven here, hermetically (no browser, no npm, no go):
#   1. the helper's own contract — visible inside the grace, absent/hidden at the
#      deadline, bounded, polling, and unbothered by a locator that throws
#      (rsi/runtime/ux/optional-grace.test.mjs, `node:test`, milliseconds);
#   2. both optional entry points still consult it. The click entry has the
#      real-browser proof (optional-grace.fixture.mjs, run by hand — Watch 92:
#      its seconds do not belong in this suite); a source pin keeps the `send`
#      entry from losing the call silently, which no hermetic browser-free test
#      can see (Watch 87).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
UNIX_WALK="$REPO/rsi/runtime/ux/walk.mjs"

node "$REPO/rsi/runtime/ux/optional-grace.test.mjs" || exit 1

# The import plus one call in each entry point. Removing a call is the exact
# regression this row exists to stop, and the helper suite cannot see walk.mjs.
calls="$(grep -c 'awaitOptionalVisible(loc)' "$UNIX_WALK")"
if [ "$calls" -ne 2 ]; then
  echo "FAIL walk.mjs has $calls optional-grace call(s), want 2 (click and send entry points)" >&2
  exit 1
fi
echo "PASS optional grace is wired into both optional entry points ($calls call sites)"

# The other end of a press: the click entry must ask whether the control left
# the page as it acted. The helper suite proves the rule; only this pin proves
# the click entry consults it, because a removed call is invisible to a
# browser-free unit test (same reason as above).
presses="$(grep -c 'pressLeftControl(loc)' "$UNIX_WALK")"
if [ "$presses" -ne 1 ]; then
  echo "FAIL optional-press-pin: walk.mjs has $presses pressLeftControl call(s), want 1 (the click entry)" >&2
  exit 1
fi
echo "PASS a press whose control left the page is not a failure"
