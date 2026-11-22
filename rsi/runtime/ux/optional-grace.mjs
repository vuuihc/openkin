// optional-grace.mjs — the bounded wait an optional walk step owes the page
// before it records "the control is not here".
//
// `?` steps are optional by design: a control that is genuinely absent on this
// surface is a recorded skip, not a failure. But a page that has not painted
// yet looks identical to a page that never will — two real rounds recorded a
// skip and moved on (J14/mac and J14/phone: 展开全部 folded away before the
// list rendered; J2 on 2026-11-22 the same). The walk then under-runs while
// staying green, which is a false claim (Watch 62). This helper is the rule:
// give an empty optional locator one small, bounded chance to appear; if it
// does, the caller performs the step normally; if it does not, the caller
// records the skip with the state and the cost.
//
// The wait is deliberately small and separate from the walk's global WAIT_MS:
// it buys one paint, not a whole reply. Every probe is `.catch`-guarded, so a
// detached frame or a torn-down context is "not yet", never an exception or a
// fabricated verdict (AGENTS §13).
export const OPTIONAL_GRACE_MS = 1500;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// → { state: 'visible' | 'hidden' | 'absent', waitedMs }
//   visible — some match is painted; the caller should run the step
//   hidden  — a match exists but never painted; the control is deliberately off
//   absent  — no match ever appeared
// Never waits longer than graceMs (+ one poll): the sleep is clamped to the
// remaining budget, and the state is decided before any further sleep.
export async function awaitOptionalVisible(loc, {
  graceMs = OPTIONAL_GRACE_MS,
  pollMs = 100,
  now = () => Date.now(),
  sleep = defaultSleep,
} = {}) {
  const started = now();
  const budget = Number.isFinite(graceMs) && graceMs > 0 ? graceMs : 0;
  const step = Number.isFinite(pollMs) && pollMs > 0 ? pollMs : 100;
  const deadline = started + budget;
  const countNow = async () => { try { return await loc.count(); } catch (_) { return 0; } };
  const paintedNow = async () => { try { return await loc.first().isVisible(); } catch (_) { return false; } };
  for (;;) {
    const count = await countNow();
    if (count > 0 && await paintedNow()) {
      return { state: 'visible', waitedMs: Math.max(0, now() - started) };
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      return { state: count > 0 ? 'hidden' : 'absent', waitedMs: Math.max(0, now() - started) };
    }
    await sleep(Math.min(step, remaining));
  }
}
