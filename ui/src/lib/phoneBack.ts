import type { NavigateFunction } from "react-router-dom";
import { coldStartPhoneParent, resolveAreaRoute, type LocationLike } from "./areaNavigation";
import { canLeaveScreen } from "./leaveGuard";
import { overlayOwnsKeyboard } from "./overlayOwnsKeyboard";
import { currentPhoneLocation } from "./phoneNavigation";

/**
 * The one back action for a phone screen, and the order its layers run in.
 *
 * The signed story map (rule 5, `docs/product/stories/ux-unification-story-map.md`)
 * is explicit: a floating layer goes back first, then the page is asked (the
 * dirty guard), and only then does the stack move. The last layer is the area
 * root: a true root — or a cold entry with no Kin parent behind it — is the
 * bottom of its area's stack, so the in-app back declines and system Back
 * leaves Kin. That is what stops a synthesized "previous page" from plugging
 * the exit.
 *
 * Stack pop is the honest way back when a real entry is behind this one: it
 * restores the area root's scroll, filters and selection and keeps the browser
 * stack truthful. A cold deep link has nothing behind it, and `navigate(-1)`
 * there is a no-op that strands the reader — so the resolver falls to the area
 * layer, which uses the signed cold-start parent (`areaNavigation.ts`) rather
 * than an invented page. `main.tsx` also synthesizes that parent before the
 * router mounts (`lib/phoneDeepLinkParent.ts`); this is the in-app twin of the
 * same rule.
 */
export type PhoneBackStep = "overlay" | "guard" | "pop" | "root" | "leave";

export type PhoneBackDecision = {
  step: PhoneBackStep;
  /** The URL to replace the current entry with, for the `root` step. */
  target?: string;
};

export type PhoneBackProbe = {
  /** A floating layer is open and owns the back gesture. */
  overlayOpen: () => boolean;
  /** The page in front agrees to be left. */
  canLeave: () => boolean;
  /** The route in front, if one is known. */
  location: () => LocationLike | null;
  /** The browser history index of the entry in front. */
  depth: () => number;
};

/** The conversations root, and the safe destination for an unknown route
 *  (the story map: an invalid path resolves to the conversations root behind
 *  the auth gate). */
const SAFE_ROOT = "/sessions";

function defaultProbe(): PhoneBackProbe {
  return {
    overlayOpen: () => overlayOwnsKeyboard(),
    canLeave: () => canLeaveScreen(),
    location: () => {
      const tracked = currentPhoneLocation();
      if (tracked) return { pathname: tracked.pathname, search: tracked.search };
      if (typeof window === "undefined") return null;
      return { pathname: window.location.pathname, search: window.location.search };
    },
    depth: () => {
      if (typeof window === "undefined") return 0;
      const idx = (window.history.state as { idx?: unknown } | null)?.idx;
      return typeof idx === "number" ? idx : 0;
    },
  };
}

/**
 * Decide the next back step without navigating.
 *
 * The first matching layer wins and the later probes are not consulted: an
 * overlay hides the page's own stack, a dirty page has not agreed to leave,
 * and only then is the history or the area root considered.
 */
export function resolvePhoneBack(probe: PhoneBackProbe = defaultProbe()): PhoneBackDecision {
  if (probe.overlayOpen()) return { step: "overlay" };
  if (!probe.canLeave()) return { step: "guard" };
  const here = probe.location();
  const route = here ? resolveAreaRoute(here) : null;
  // A true area root is the bottom of its own stack: header and edge back do
  // not add one, so system Back leaves Kin.
  if (route?.root) return { step: "leave" };
  if (probe.depth() > 0) return { step: "pop" };
  const target = here ? coldStartPhoneParent(here) : null;
  return { step: "root", target: target ?? SAFE_ROOT };
}

/**
 * The phone's back action. Kept under this name (and signature) because the
 * detail pages call it directly; the area-aware decision lives in
 * `resolvePhoneBack`.
 *
 * The shell asks the page before it calls this (`runGuardedNavigation` in
 * `AppShell`), and a direct caller is the page's own control, so the guard is
 * marked as already answered here. Asking again would re-open the same
 * confirm dialog for an editor that has just agreed to leave.
 */
export function goBackToList(navigate: NavigateFunction): void {
  const decision = resolvePhoneBack({ ...defaultProbe(), canLeave: () => true });
  if (decision.step === "pop") {
    navigate(-1);
    return;
  }
  if (decision.step === "root" && decision.target) {
    navigate(decision.target, { replace: true });
  }
  // overlay / guard / leave: no navigation. The overlay closes itself, the
  // page refused, or system Back leaves the app.
}
