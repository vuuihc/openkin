#!/usr/bin/env node
// optional-grace.test.mjs — the rule an optional walk step obeys before it says "n".
//
// A `?` step is skipped when the control is not on the page. But "not on the
// page yet" and "not on this page" are different states, and the walk used to
// treat the first paint as the answer: J14's 展开全部 fold was logged `skipped`
// because `count()===0` before the list rendered, and the next step then waited
// 15 s for a row that did render. A green walk that never walked is a false
// claim (Watch 62), so an empty optional locator gets a bounded grace first.
//
// Hermetic: stub locators and an injected clock; no browser, no timers, no
// network. Run with `node rsi/runtime/ux/optional-grace.test.mjs`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OPTIONAL_GRACE_MS, awaitOptionalVisible, pressLeftControl } from './optional-grace.mjs';

// A clock the stubs advance themselves, so every case finishes in milliseconds
// and `waitedMs` is deterministic rather than wall-clock dependent.
function fakeClock(start = 1000) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms) => { t += Math.max(0, Number(ms) || 0); },
  };
}

// A Playwright-shaped locator stub. `count` and `visible` are called per poll;
// a function form lets one case change its answer between polls.
function stubLocator({ count, visible = () => false, firstThrows = false }) {
  const calls = { count: 0, visible: 0 };
  return {
    calls,
    count: async () => { calls.count += 1; return typeof count === 'function' ? count(calls.count) : count; },
    first() {
      if (firstThrows) throw new Error('locator is detached');
      return { isVisible: async () => { calls.visible += 1; return typeof visible === 'function' ? visible(calls.visible) : visible; } };
    },
  };
}

test('test_optional_grace_returns_visible_when_the_control_appears_inside_the_grace', async () => {
  const clock = fakeClock();
  // Absent for two polls, present and painted on the third.
  const loc = stubLocator({ count: (n) => (n >= 3 ? 1 : 0), visible: (n) => n >= 1 });
  const grace = await awaitOptionalVisible(loc, { now: clock.now, sleep: clock.sleep });
  assert.equal(grace.state, 'visible');
  assert.ok(loc.calls.count >= 3, `expected the third poll to see the control, saw ${loc.calls.count} count() call(s)`);
  assert.ok(grace.waitedMs < OPTIONAL_GRACE_MS, `waitedMs ${grace.waitedMs} must be inside the ${OPTIONAL_GRACE_MS}ms default grace`);
});

test('test_optional_grace_returns_absent_after_the_full_grace_and_never_waits_longer', async () => {
  const clock = fakeClock();
  const graceMs = 300;
  const pollMs = 50;
  const loc = stubLocator({ count: 0 });
  const grace = await awaitOptionalVisible(loc, { graceMs, pollMs, now: clock.now, sleep: clock.sleep });
  assert.equal(grace.state, 'absent');
  assert.ok(grace.waitedMs >= graceMs, `waitedMs ${grace.waitedMs} must reach the ${graceMs}ms budget before saying absent`);
  assert.ok(grace.waitedMs <= graceMs + 2 * pollMs, `waitedMs ${grace.waitedMs} must stay within ${graceMs}ms + two ${pollMs}ms polls`);
});

test('test_optional_grace_reports_hidden_when_the_match_never_becomes_visible', async () => {
  const clock = fakeClock();
  const loc = stubLocator({ count: 2, visible: false });
  const grace = await awaitOptionalVisible(loc, { graceMs: 200, pollMs: 25, now: clock.now, sleep: clock.sleep });
  assert.equal(grace.state, 'hidden', 'a matched-but-invisible control is on the page and deliberately hidden, not unknown');
  assert.ok(grace.waitedMs >= 200);
});

test('test_optional_grace_polls_instead_of_sleeping_once', async () => {
  const clock = fakeClock();
  const loc = stubLocator({ count: 0 });
  await awaitOptionalVisible(loc, { graceMs: 300, pollMs: 50, now: clock.now, sleep: clock.sleep });
  assert.ok(loc.calls.count >= 3, `a 300ms grace in 50ms polls must probe at least 3 times, probed ${loc.calls.count}`);
});

test('test_optional_grace_survives_a_locator_that_throws', async () => {
  const clock = fakeClock();
  // A detached frame makes count() reject: that is "not yet", not a crash out
  // of the helper and not a fabricated verdict (AGENTS §13).
  const unreadable = {
    count: async () => { throw new Error('Execution context was destroyed'); },
    first: () => ({ isVisible: async () => false }),
  };
  const absent = await awaitOptionalVisible(unreadable, { graceMs: 100, pollMs: 10, now: clock.now, sleep: clock.sleep });
  assert.equal(absent.state, 'absent');

  // The match exists but its visibility cannot be read: still `hidden` at the
  // deadline, and still no exception.
  const blind = stubLocator({ count: 1, visible: () => { throw new Error('element is not attached'); } });
  const hidden = await awaitOptionalVisible(blind, { graceMs: 100, pollMs: 10, now: clock.now, sleep: clock.sleep });
  assert.equal(hidden.state, 'hidden');

  // `first()` itself throwing synchronously is the same story.
  const detached = stubLocator({ count: 1, firstThrows: true });
  const detachedGrace = await awaitOptionalVisible(detached, { graceMs: 100, pollMs: 10, now: clock.now, sleep: clock.sleep });
  assert.equal(detachedGrace.state, 'hidden');
});

test('test_optional_grace_default_is_at_most_1500ms', () => {
  assert.ok(Number.isFinite(OPTIONAL_GRACE_MS), 'OPTIONAL_GRACE_MS must be a number');
  assert.ok(OPTIONAL_GRACE_MS >= 800, `OPTIONAL_GRACE_MS ${OPTIONAL_GRACE_MS} is below the measured need (a list can paint in ~1 s)`);
  assert.ok(OPTIONAL_GRACE_MS <= 1500, `OPTIONAL_GRACE_MS ${OPTIONAL_GRACE_MS} exceeds the row's 1.5 s budget`);
});

// The other end of a press: the click entry asks `pressLeftControl` whether
// the control left the page as it acted, which is the J7/phone fold button
// re-labelling 展开项目 → 收起项目 mid-click. A control gone after the press is
// the page having acted (the next mandatory step proves it); one still on
// screen is a press that never landed; an unreadable locator is "cannot tell"
// (AGENTS §13), so neither of those is excused.
test('test_press_left_control_only_when_the_control_is_gone', async () => {
  const gone = stubLocator({ count: 0 });
  assert.equal(await pressLeftControl(gone), true, 'a control gone after the press is the page having acted on it');
  const still = stubLocator({ count: 1 });
  assert.equal(await pressLeftControl(still), false, 'a control still on screen is a press that did not land');
  const two = stubLocator({ count: 2 });
  assert.equal(await pressLeftControl(two), false, 'a strict-mode-like pair is not evidence the press acted');
});

test('test_press_left_control_does_not_guess_when_the_locator_cannot_be_counted', async () => {
  const unreadable = { count: async () => { throw new Error('Execution context was destroyed'); } };
  assert.equal(await pressLeftControl(unreadable), false, 'cannot tell is never a skip (AGENTS §13)');
});
