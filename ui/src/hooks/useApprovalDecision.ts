import { useCallback, useRef, useState } from "react";
import { decideApproval } from "../api/client";
import { liveResources } from "../api/liveResources";
import { useT } from "../i18n/react";
import { useAppStore } from "../store/appStore";

export type PendingDecision = "approved" | "denied";

/**
 * Answering an approval, once, for every surface that can do it.
 *
 * The inbox and the floating card used to need the same four steps — mark the
 * row busy, call the daemon, push the answer into the shared resource so the
 * row leaves every list at once, and say what went wrong if it did not — and a
 * second copy is how the two would come to disagree about what a failed
 * decision looks like.
 *
 * The answer is applied through `liveResources.applyMessage` rather than by
 * refetching: the same `approval_update` arrives over the websocket a moment
 * later, and a refetch per decision would make a queue of five into five round
 * trips to learn what the response already said. When the call fails there is
 * nothing to apply and the list may have moved on without us, so that path does
 * refetch.
 */
export function useApprovalDecision(fallbackKey = "inbox.decisionFailed") {
  const tr = useT();
  const pushToast = useAppStore((s) => s.pushToast);
  const [busy, setBusy] = useState<Record<string, PendingDecision>>({});
  // A second answer for the same approval must not reach the daemon: the
  // inbox's keyboard model does not consult `busy`, so a held key would post
  // twice and the second — a 409, because the first decided it — would toast
  // a failure for something that worked.
  const inFlight = useRef<Set<string>>(new Set());

  const decide = useCallback(
    async (id: string, decision: PendingDecision) => {
      if (inFlight.current.has(id)) return;
      inFlight.current.add(id);
      setBusy((b) => ({ ...b, [id]: decision }));
      try {
        const updated = await decideApproval(id, decision);
        liveResources.applyMessage({ kind: "approval_update", data: updated });
      } catch (e) {
        pushToast(e instanceof Error ? e.message : tr(fallbackKey), "error");
        void liveResources.refreshPending();
      } finally {
        inFlight.current.delete(id);
        setBusy((b) => {
          const next = { ...b };
          delete next[id];
          return next;
        });
      }
    },
    [fallbackKey, pushToast, tr],
  );

  return { busy, decide };
}
