import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { scheduleLeaveGuardReconcile, setLeaveGuard } from "../lib/leaveGuard";

/**
 * Let the shell ask this screen before it navigates away.
 *
 * The predicate is kept in a ref so a re-render with new `dirty` state updates
 * the answer without re-registering (and without a stale closure). `dirty` is
 * the pure half of the same fact: it decides whether a same-URL history entry
 * is armed, so a system Back can ask before React Router unmounts the form.
 * It must not prompt — only `canLeave` may.
 */
export function useLeaveGuard(canLeave: () => boolean, dirty = false): void {
  const ref = useRef(canLeave);
  const location = useLocation();
  // Update after the commit, not during render; the guard is only asked on a
  // user action, which is always after this effect has run.
  useEffect(() => {
    ref.current = canLeave;
  });
  useEffect(() => setLeaveGuard(() => ref.current(), dirty), [dirty]);
  // A same-pathname navigation (a query rewrite, a search-param replace) does
  // not unmount this page and does not change `dirty`, but it can rewrite the
  // history entry that was protecting the draft, or bury it under a real one.
  // The page is still on screen with its text, so the entry must follow it.
  useEffect(() => {
    scheduleLeaveGuardReconcile();
  }, [location.key, location.pathname, location.search]);
}
