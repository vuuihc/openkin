import { useCallback, useSyncExternalStore } from "react";

/**
 * Whether a media query currently matches, as a render-time fact.
 *
 * This is the one subscription shape behind the console's viewport hooks: one
 * stable listener per query (a fresh `subscribe` on every render would make
 * React drop and re-add the media listener, so every keystroke in a search
 * field would resubscribe a viewport query) and a snapshot read straight from
 * `matchMedia`.
 *
 * `fallback` is what a platform that cannot answer — no DOM, or a test that did
 * not stub `matchMedia` — gets. Each caller picks the value that keeps the
 * shipped desktop shape instead of flashing the phone layout.
 */
export function useMediaQuery(query: string, fallback: boolean): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
        return () => {};
      }
      const media = window.matchMedia(query);
      if (media.addEventListener) media.addEventListener("change", onChange);
      else media.addListener?.(onChange);
      return () => {
        if (media.removeEventListener) media.removeEventListener("change", onChange);
        else media.removeListener?.(onChange);
      };
    },
    [query],
  );
  const getSnapshot = useCallback(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return fallback;
    }
    return window.matchMedia(query).matches;
  }, [query, fallback]);
  return useSyncExternalStore(subscribe, getSnapshot, () => fallback);
}

/**
 * Whether the primary pointer is a finger.
 *
 * This is deliberately not a width query. An iPad gets the desktop layout at
 * ≥768px, but its pointer is still coarse, and iOS spends the first tap on a
 * hover-styled element applying the hover state — so a row that changes on
 * hover, or a control only revealed by hover, needs a second tap. Callers use
 * this to keep the hover shape off touch at every width: remove hover-only
 * styling and render the touch home (the π-shaped action sheet, a permanent
 * button) instead of a hover-revealed one.
 *
 * The fallback is `false`: a platform that cannot answer is assumed to have a
 * mouse, which is the shipped desktop console and every DOM test that does not
 * stub `matchMedia`.
 */
export function useCoarsePointer(): boolean {
  return useMediaQuery("(pointer: coarse)", false);
}
