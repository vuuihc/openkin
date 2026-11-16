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
/** The sentinel an in-flight departure is unwinding from. */
let pendingToken: string | null = null;
/** A `history.back()` this module started is still travelling. One departure
 *  at a time: a second navigation in that window is refused rather than run
 *  beside the pop (which would leave its action to fire on a later Back). */
let releasing = false;
let allowing = false;
/** The pathname the page was on when it agreed to leave, so a pop that lands
 *  on another entry of the same screen (different query) is recognised as
 *  "still here" rather than "left". */
let allowFromPath: string | null = null;
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

/** A sheet may sit above the page's sentinel while the page is still dirty.
 *  That is not a rewritten entry: the departure walk pops the sheet and then
 *  the sentinel, so the pair must not be abandoned as stale. */
function sheetIsTop(): boolean {
  const state = historyState();
  return state !== null && typeof state.kinSheet === "string";
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
  if (want) {
    // A same-pathname SPA navigation can rewrite the sentinel entry (replace
    // drops its marker) or bury it (push puts a real entry on top). The screen
    // and its draft are still mounted either way, so the old token no longer
    // describes the top of the stack: arm again over the entry that is.
    if (armed && !sentinelIsTop() && !sheetIsTop()) {
      armed = false;
      sentinel = null;
    }
    armHistory();
  } else releaseSentinel();
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

/** Re-arm the page's entry after the route changed under it. A page calls this
 *  from its location subscription: only then can a same-URL navigation that
 *  is not the page's own (a query cleanup, a search-param replace) be seen. */
export function scheduleLeaveGuardReconcile(): void {
  scheduleReconcile();
}

function onPopState(event: PopStateEvent): void {
  if (pendingAction) {
    const state = (event.state ?? null) as Record<string, unknown> | null;
    // A departure may have to walk back through entries the page does not own:
    // a sheet pushed its own entry over the sentinel, and a raw push copies the
    // state it found. Keep popping while the entry we landed on is one of those,
    // then run the navigation once, from the page's real entry — anything left
    // behind would make Back revisit a screen the reader already left.
    if (
      (pendingToken !== null && state?.kinLeaveGuard === pendingToken) ||
      (state !== null && typeof state.kinSheet === "string")
    ) {
      window.history.back();
      return;
    }
    const action = pendingAction;
    // Consume the one request this pop belongs to before the action can
    // register another page. A later Back must not find this action still
    // waiting and run it against a screen that never asked for it.
    pendingAction = null;
    pendingToken = null;
    releasing = false;
    armed = false;
    sentinel = null;
    const beforePathname = window.location.pathname;
    action();
    // A same-pathname navigation keeps the page mounted and still dirty.
    // Without a fresh entry the next system Back would leave the form without
    // asking. The query may have changed (a tab URL, a cleaned callback
    // parameter); only the pathname says whether this screen is still here.
    if (window.location.pathname === beforePathname) scheduleReconcile();
    return;
  }
  if (allowing) {
    allowing = false;
    releasing = false;
    const stayed = allowFromPath !== null && window.location.pathname === allowFromPath;
    allowFromPath = null;
    // The agreed pop landed on another copy of this screen, so the page (and
    // its draft) is still mounted: arm again, or the next Back is unguarded.
    if (stayed) scheduleReconcile();
    return;
  }
  if (!armed) return;
  const state = (event.state ?? null) as Record<string, unknown> | null;
  if (state && typeof state.kinLeaveGuard === "string") {
    // A forward move landed on a sentinel; it is still the page's own entry.
    return;
  }
  // The sentinel was popped. The screen is still mounted and can be asked.
  armed = false;
  sentinel = null;
  if (!current) return;
  if (current.canLeave()) {
    allowing = true;
    releasing = true;
    allowFromPath = window.location.pathname;
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
 *
 * When the sentinel is current this pops it first; when another surface (a
 * sheet) left its entry above the sentinel, the same walk removes that too, so
 * a confirmed departure cannot strand either behind the destination.
 */
export function runGuardedNavigation(action: () => void, approved = false): boolean {
  // One departure at a time. While a pop this module started is still
  // travelling, a second action would either overwrite the first (losing it)
  // or run beside it and leave nothing for the pop to run; either way a later
  // Back could replay an action against a screen that never approved it.
  if (releasing || pendingAction !== null) return false;
  if (!approved && !canLeaveScreen()) return false;
  if (sentinelIsTop() || (armed && sheetIsTop())) {
    pendingAction = action;
    pendingToken = sentinel;
    releasing = true;
    armed = false;
    sentinel = null;
    window.history.back();
    return true;
  }
  // The marker is no longer on the top entry (a same-pathname replace or push
  // rewrote or buried it). There is nothing to pop; the navigation itself is
  // the departure.
  armed = false;
  sentinel = null;
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
  pendingToken = null;
  releasing = false;
  allowing = false;
  allowFromPath = null;
}
