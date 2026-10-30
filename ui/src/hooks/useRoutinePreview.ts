import { useEffect, useState } from "react";
import { previewRoutine } from "../api/client";

/** How long the form waits after an edit before asking the daemon. */
export const ROUTINE_PREVIEW_DELAY_MS = 250;

/**
 * The next run the daemon computes for a serialized rule, or null.
 *
 * The rule string is the identity: it changes when the rule or its zone does,
 * and a change while a request is in flight makes that answer stale — an old
 * reply landing after a new one would show a time the form no longer means.
 * The shown instant is cleared the moment the payload changes, so the line
 * never carries the previous rule's time through the debounce or a slow
 * request. An empty payload means there is nothing to preview (an interval
 * routine, a one-off whose instant is already in the field, or no rule at all)
 * and clears the line.
 *
 * The delay is what keeps a half-typed time or day out of the request; the
 * controls fire as they are edited, and the daemon should only be asked about
 * values the reader has settled on.
 */
export function useRoutinePreview(
  payload: string,
  fetchPreview: (recurrence: string) => Promise<{ next_due_at: number }> = previewRoutine,
  delayMs: number = ROUTINE_PREVIEW_DELAY_MS,
): number | null {
  const [nextDueAt, setNextDueAt] = useState<number | null>(null);

  useEffect(() => {
    if (!payload) {
      setNextDueAt(null);
      return;
    }
    // A different rule means the instant on screen belongs to the old one.
    // Holding it through the debounce and the round trip would name a time
    // this rule never fires at, which is the one thing the line exists to
    // prevent.
    setNextDueAt(null);
    let live = true;
    const timer = setTimeout(() => {
      fetchPreview(payload)
        .then((p) => {
          if (live) setNextDueAt(p.next_due_at);
        })
        .catch(() => {
          // The form's own controls only build rules the daemon accepts, so a
          // failure is a transport problem: say nothing rather than guess.
          if (live) setNextDueAt(null);
        });
    }, delayMs);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [payload, fetchPreview, delayMs]);

  return nextDueAt;
}
