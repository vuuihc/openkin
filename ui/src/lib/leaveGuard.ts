/**
 * A page's last word before the shell leaves it, for every way out.
 *
 * The shell used to ask the page only from its own controls — the phone
 * header's back button, the left-edge swipe, the palette's replace. The
 * browser's Back and the Mac sidebar's rows/links went around the question
 * entirely, so an edited One-Pager or an unsaved routine could be lost by a
 * gesture the page never saw (KIN-CONTINUE-002 review).
 *
 * Two mechanisms, one rule:
 *
 * - Every navigation the console starts goes through `runGuardedNavigation`,
 *   which asks the registered page first. Its callers are the shell's real
 *   destinations (header back, edge swipe, sidebar links and rows, the palette,
 *   the floating approval, page-internal links), so no entry point is special.
 * - While the page is dirty, a same-URL history entry is armed. A system Back
 *   pops that entry first, which keeps the current screen mounted while the
 *   page is asked; refusing re-arms it, allowing goes back once more for real.
 *   Without the entry React Router would have changed the route before a
 *   question could be asked, unmounting the form whose text is the subject.
 *
 * A platform boundary is deliberate: the first entry of a fresh tab has
 * nothing behind it, so a system Back there leaves the document and no script
 * can ask. The page's `beforeunload` (where it has one) is the browser's own
 * prompt for that case; OS-level back gestures on a phone belong to the
 * platform. Nothing here claims to intercept those.
 *
 * One guard at a time is enough because only one page is on screen:
 * registering a new guard replaces the old one, and unregistering only clears
 * it if it is still the registered one (a fast page swap must not unmount the
 * new page's guard).
 */
type Guard = { canLeave: () => boolean; dirty: () => boolean };

let current: Guard | null = null;
let armed = false;
let sentinel: string | null = null;
let listening = false;
let pendingAction: (() => void) | null = null;
let allowing = false;
let reconcileTimer: number | null = null;

function historyState(): Record<string, unknown> | null {
  if (typeof window === "undefined") return null;
  const state = window.history.state;
  return state && typeof state === "object" ? (state as Record<string, unknown>) : null;
}

/** React Router's browser history stamps `idx`; a MemoryRouter never does, so
 *  that is also the test for "there is a real stack to protect". */
function hasBrowserStack(): boolean {
  const state = historyState();
  return Boolean(state) && typeof state!.idx === "number";
}

function sentinelIsTop(): boolean {
  return armed && historyState()?.kinLeaveGuard === sentinel;
}

function armHistory(): void {
  if (armed || typeof window === "undefined" || !hasBrowserStack()) return;
  const state = historyState()!;
  const token = `kin-leave-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  window.history.pushState({ ...state, kinLeaveGuard: token }, "", window.location.href);
  sentinel = token;
  armed = true;
  if (!listening) {
    window.addEventListener("popstate", onPopState);
    listening = true;
  }
}

function releaseSentinel(): void {
  if (!armed) return;
  if (!sentinelIsTop()) {
    armed = false;
    sentinel = null;
    return;
  }
  // The pop is asynchronous; onPopState treats an empty pending action as a
  // silent release (the guard may already be gone by then).
  armed = false;
  sentinel = null;
  window.history.back();
}

function reconcile(): void {
  const want = Boolean(current?.dirty());
  if (want) armHistory();
  else releaseSentinel();
}

function scheduleReconcile(): void {
  if (typeof window === "undefined") return;
  if (reconcileTimer !== null) window.clearTimeout(reconcileTimer);
  // Deferred so StrictMode's mount → cleanup → mount and a dirty flag flipping
  // in one commit settle on the final state before touching history.
  reconcileTimer = window.setTimeout(() => {
    reconcileTimer = null;
    reconcile();
  }, 0);
}

function onPopState(event: PopStateEvent): void {
  if (pendingAction) {
    const action = pendingAction;
    pendingAction = null;
    armed = false;
    sentinel = null;
    action();
    return;
  }
  if (allowing) {
    allowing = false;
    return;
  }
  if (!armed) return;
  const state = (event.state ?? null) as Record<string, unknown> | null;
  if (state && typeof state.kinLeaveGuard === "string") {
    // A forward move landed on a sentinel; it is still the page's own entry.
    return;
  }
  // The sentinel was popped. The URL is unchanged (it copied the page's own),
  // so the page is still mounted and can be asked.
  armed = false;
  sentinel = null;
  if (!current) return;
  if (current.canLeave()) {
    allowing = true;
    window.history.back();
  } else {
    armHistory();
  }
}

/** Register the screen's leave guard; returns the unregister. */
export function setLeaveGuard(canLeave: () => boolean, dirty = false): () => void {
  const guard: Guard = { canLeave, dirty: () => dirty };
  current = guard;
  scheduleReconcile();
  return () => {
    if (current !== guard) return;
    current = null;
    scheduleReconcile();
  };
}

/** Whether the current screen may be left. No guard means yes: a screen with
 *  nothing to lose never has to opt in. */
export function canLeaveScreen(): boolean {
  return current ? current.canLeave() : true;
}

/**
 * Ask the page, then navigate.
 *
 * `approved` is for a caller that already asked (the palette asks before it
 * closes so one departure is one question); it still releases the armed entry,
 * because a confirmed departure must not leave a duplicate history entry
 * behind.
 */
export function runGuardedNavigation(action: () => void, approved = false): boolean {
  if (!approved && !canLeaveScreen()) return false;
  if (sentinelIsTop()) {
    pendingAction = action;
    armed = false;
    sentinel = null;
    window.history.back();
    return true;
  }
  action();
  return true;
}

/** Whether a dirty page is currently holding a duplicate entry for Back. */
export function isLeaveGuardArmed(): boolean {
  return sentinelIsTop();
}

/** Test hook: drop a guard a failed test left behind. */
export function resetLeaveGuard(): void {
  if (typeof window !== "undefined" && reconcileTimer !== null) {
    window.clearTimeout(reconcileTimer);
  }
  reconcileTimer = null;
  if (typeof window !== "undefined" && listening) {
    window.removeEventListener("popstate", onPopState);
  }
  listening = false;
  current = null;
  armed = false;
  sentinel = null;
  pendingAction = null;
  allowing = false;
}
