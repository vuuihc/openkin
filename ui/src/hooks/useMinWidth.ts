import { useCallback, useSyncExternalStore } from "react";

/**
 * Whether the viewport is at least `px` wide, as a render-time fact.
 *
 * The console is one tree with two shapes, and the breakpoint has to be known
 * in JS — not only in CSS — wherever the two shapes are different *components*
 * rather than two class lists. `/sessions` is the case that forced it: on a
 * phone the page is the conversation list, on a Mac the list is the sidebar and
 * the page is the draft. Drawing both and hiding one leaves a second list (and
 * a second search field) in the document, which is exactly what the shell must
 * not have.
 *
 * The fallback is `true` on purpose. The shipped console is a desktop app and
 * the tests render without a browser; assuming the wide shape when the platform
 * cannot answer keeps the first paint from flashing the phone layout on a Mac.
 * A phone browser always answers `matchMedia`, so the fallback is only ever the
 * no-DOM case.
 */
export function useMinWidth(px: number, fallback = true): boolean {
  const query = `(min-width: ${px}px)`;
  // Stable per query: a fresh `subscribe` on every render makes React drop and
  // re-add the media listener each time — every keystroke in a search field
  // would resubscribe a viewport query.
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
