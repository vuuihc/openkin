/**
 * A page's last word before the shell leaves it.
 *
 * The shell owns three ways out of a phone screen — the header's back button,
 * the left-edge swipe and the palette's replace — and a page can own unsaved
 * text (a project summary, a routine form). Without a shared registry the shell
 * navigates blind and the page's own confirm never runs, which is exactly how
 * the first delivery lost edits (KIN-CONTINUE-002 review).
 *
 * The page registers a predicate; the shell asks it before leaving. One guard
 * at a time is enough because only one page is on screen: registering a new
 * guard replaces the old one, and unregistering only clears it if it is still
 * the registered one (a fast page swap must not unmount the new page's guard).
 */
type Guard = () => boolean;

let current: Guard | null = null;

/** Register the screen's leave guard; returns the unregister. */
export function setLeaveGuard(guard: Guard): () => void {
  current = guard;
  return () => {
    if (current === guard) current = null;
  };
}

/**
 * Whether the current screen may be left. No guard means yes: a screen with
 * nothing to lose never has to opt in.
 */
export function canLeaveScreen(): boolean {
  return current ? current() : true;
}

/** Test hook: drop a guard a failed test left behind. */
export function resetLeaveGuard(): void {
  current = null;
}
