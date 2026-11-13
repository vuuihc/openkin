import { useEffect, useRef } from "react";
import { setLeaveGuard } from "../lib/leaveGuard";

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
  // Update after the commit, not during render; the guard is only asked on a
  // user action, which is always after this effect has run.
  useEffect(() => {
    ref.current = canLeave;
  });
  useEffect(() => setLeaveGuard(() => ref.current(), dirty), [dirty]);
}
