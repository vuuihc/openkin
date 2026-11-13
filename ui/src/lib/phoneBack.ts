import type { NavigateFunction } from "react-router-dom";

/**
 * The one back action for a phone screen.
 *
 * Every destination and every conversation has the list page as its parent
 * (KIN-CONTINUE-002). History is the honest way back when the list is behind
 * this entry: it restores the list's scroll position and the browser's own
 * stack. A cold deep link has nothing behind it, and `navigate(-1)` there is a
 * no-op that strands the reader on the destination — `idx > 0` is the test,
 * not `location.key`, because a `<Navigate replace>` mints a fresh key on a
 * cold launch. The browser's own Back is handled a layer lower: `main.tsx`
 * synthesizes a `/sessions` entry behind a cold deep link before the router
 * mounts (`lib/phoneDeepLinkParent.ts`).
 */
export function goBackToList(navigate: NavigateFunction): void {
  if ((window.history.state?.idx ?? 0) > 0) navigate(-1);
  else navigate("/sessions", { replace: true });
}
