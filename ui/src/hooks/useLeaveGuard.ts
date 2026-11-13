import { useEffect, useRef } from "react";
import { setLeaveGuard } from "../lib/leaveGuard";

/**
 * Let the shell ask this screen before it navigates away.
 *
 * The predicate is kept in a ref so a re-render with new `dirty` state updates
 * the answer without re-registering (and without a stale closure).
 */
export function useLeaveGuard(canLeave: () => boolean): void {
  const ref = useRef(canLeave);
  // Update after the commit, not during render; the guard is only asked on a
  // user action, which is always after this effect has run.
  useEffect(() => {
    ref.current = canLeave;
  });
  useEffect(() => setLeaveGuard(() => ref.current()), []);
}
