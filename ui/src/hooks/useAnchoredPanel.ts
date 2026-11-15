import { useLayoutEffect, useState, type RefObject } from "react";

/** Viewport coordinates for a panel that floats above the page. */
export type PanelAnchor = {
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
};

type Options = {
  /** Which side of the anchor the panel prefers. Flipped when that side has
   *  less room than the other. */
  placement?: "above" | "below";
  /** Which edge of the anchor the panel lines up with. */
  align?: "left" | "right";
  /** Fixed width; defaults to the anchor's own width. */
  width?: number;
  /** Never wider than this, whatever the anchor measures. */
  maxWidth?: number;
  /** Never taller than this, whatever the viewport leaves. */
  maxHeight?: number;
  gap?: number;
  edge?: number;
};

const FLIP_BELOW = 120;

/**
 * Where to put a panel, in viewport coordinates, measured from its trigger.
 *
 * A control that opens a panel often sits inside an `overflow-*` strip or a
 * scrollport — the composer's control row is one, and the phone's run sheet is
 * another. CSS makes `overflow-x: auto` compute `overflow-y: auto` too, so an
 * absolutely positioned panel is clipped by the strip it lives in; a panel
 * opening upward lands in the unscrollable top overflow and paints nowhere.
 * Measured from the viewport instead, the panel escapes that box.
 *
 * A layout effect, so the first painted frame is already in place instead of
 * one frame at 0,0. Re-measured on resize and on scroll in the capture phase,
 * because the strip or sheet the trigger sits in scrolls independently of the
 * window. The visual viewport is watched too: a phone keyboard opening moves
 * the trigger without firing a window resize, and the observer on the trigger
 * catches the layout shifts (a font arriving, a row wrapping) that move it
 * without any scroll at all.
 */
export function useAnchoredPanel(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null> | null,
  {
    placement = "below",
    align = "left",
    width,
    maxWidth,
    maxHeight = 360,
    gap = 6,
    edge = 8,
  }: Options = {},
): PanelAnchor | null {
  const [anchor, setAnchor] = useState<PanelAnchor | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setAnchor(null);
      return;
    }
    const place = () => {
      const element = anchorRef?.current;
      if (!element) return;
      const rect = element.getBoundingClientRect();
      const vw = window.innerWidth;
      const panelWidth = Math.min(
        width ?? rect.width,
        maxWidth ?? Number.POSITIVE_INFINITY,
        Math.max(0, vw - edge * 2),
      );
      const left = Math.min(
        Math.max(edge, align === "right" ? rect.right - panelWidth : rect.left),
        Math.max(edge, vw - panelWidth - edge),
      );
      const above = rect.top - edge - gap;
      const below = window.innerHeight - rect.bottom - edge - gap;
      const preferAbove = placement === "above";
      const preferred = preferAbove ? above : below;
      const other = preferAbove ? below : above;
      // A side with no room is not a side: opening upward from a trigger 100px
      // below the top edge would paint the panel off the top of the screen.
      const openUp = preferred < FLIP_BELOW && other > preferred ? !preferAbove : preferAbove;
      const next: PanelAnchor = {
        left,
        width: panelWidth,
        maxHeight: Math.max(0, Math.min(maxHeight, openUp ? above : below)),
        ...(openUp ? { bottom: window.innerHeight - rect.top + gap } : { top: rect.bottom + gap }),
      };
      // `scroll` fires per frame while a finger is moving; returning the same
      // object lets React skip the re-render when the anchor has not moved.
      setAnchor((prev) =>
        prev &&
        prev.left === next.left &&
        prev.width === next.width &&
        prev.maxHeight === next.maxHeight &&
        prev.top === next.top &&
        prev.bottom === next.bottom
          ? prev
          : next,
      );
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    const viewport = typeof window.visualViewport !== "undefined" ? window.visualViewport : null;
    viewport?.addEventListener("resize", place);
    viewport?.addEventListener("scroll", place);
    const observer =
      typeof ResizeObserver !== "undefined" && anchorRef?.current
        ? new ResizeObserver(place)
        : null;
    if (anchorRef?.current) observer?.observe(anchorRef.current);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      viewport?.removeEventListener("resize", place);
      viewport?.removeEventListener("scroll", place);
      observer?.disconnect();
    };
  }, [open, anchorRef, placement, align, width, maxWidth, maxHeight, gap, edge]);

  return anchor;
}
