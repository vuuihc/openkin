import { useLayoutEffect, useRef, useState, type RefObject } from "react";

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
  /**
   * The panel this anchor positions. Once it is mounted its own content height
   * decides which side can show it: a trigger near the bottom edge leaves a
   * short column below, and a menu that is clamped to it looks like it simply
   * lacks its last rows (the panel's scrollbar is invisible). Omit it and the
   * anchor falls back to the coarse room test.
   */
  panelRef?: RefObject<HTMLElement | null> | null;
};

const FLIP_BELOW = 120;

/**
 * Which side the panel opens on.
 *
 * The caller's preferred side only holds while it can show the panel's content
 * (the measured content height, already clamped by `maxHeight`). Otherwise the
 * side with more room wins, so a menu is never cut on the side that shows less
 * when the other side shows more. A tie keeps the preferred side. Before the
 * panel is mounted there is nothing to measure, so the coarse 120px rule keeps
 * the first painted frame on the side a person expects; the panel's own commit
 * re-places it with the measurement before anything is painted.
 */
function opensUp(
  preferAbove: boolean,
  preferredRoom: number,
  otherRoom: number,
  contentHeight: number | null,
): boolean {
  if (contentHeight != null) {
    if (preferredRoom >= contentHeight) return preferAbove;
    if (otherRoom >= contentHeight) return !preferAbove;
    return otherRoom > preferredRoom ? !preferAbove : preferAbove;
  }
  return preferredRoom < FLIP_BELOW && otherRoom > preferredRoom ? !preferAbove : preferAbove;
}

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
    panelRef = null,
  }: Options = {},
): PanelAnchor | null {
  const [anchor, setAnchor] = useState<PanelAnchor | null>(null);
  // The latest placement pass, so the panel-mount effect can re-run it without
  // re-registering the window listeners on every render.
  const placeRef = useRef<(() => void) | null>(null);
  const panelObserver = useRef<ResizeObserver | null>(null);
  const observedPanel = useRef<HTMLElement | null>(null);

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
      // What the panel needs. `scrollHeight` is the whole content even while a
      // clamped panel scrolls, so a side is judged by what it would show, not
      // by the box the last pass happened to leave. A panel that has not been
      // laid out (or jsdom, which has no layout) reports 0: that is "unknown",
      // not "needs nothing", and falls back to the coarse room test.
      const measured = panelRef?.current?.scrollHeight ?? 0;
      const contentHeight = measured > 0 ? Math.min(maxHeight, measured) : null;
      // A side with no room is not a side: opening upward from a trigger 100px
      // below the top edge would paint the panel off the top of the screen.
      const openUp = opensUp(preferAbove, preferred, other, contentHeight);
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
    placeRef.current = place;
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
  }, [open, anchorRef, placement, align, width, maxWidth, maxHeight, gap, edge, panelRef]);

  // The panel is portaled a render after the anchor exists, so the pass above
  // ran before there was content to measure. Once the panel is in the DOM,
  // place again in the same commit — before paint — with its real height, and
  // keep watching it: filtering a list or wrapping a reason line changes what
  // the chosen side has to show. A layout effect without dependencies is
  // deliberate: the render that mounts the portal changes no option, so there
  // is no dependency to hang this on.
  useLayoutEffect(() => {
    if (!open) return;
    const panel = panelRef?.current ?? null;
    if (panel !== observedPanel.current) {
      panelObserver.current?.disconnect();
      panelObserver.current = null;
      observedPanel.current = panel;
      if (panel && typeof ResizeObserver !== "undefined") {
        const observer = new ResizeObserver(() => placeRef.current?.());
        observer.observe(panel);
        panelObserver.current = observer;
      }
    }
    placeRef.current?.();
  });

  // The panel observer outlives the placement effect's cleanup because the
  // panel mounts after it; it must still not outlive the hook.
  useLayoutEffect(
    () => () => {
      panelObserver.current?.disconnect();
      panelObserver.current = null;
    },
    [],
  );

  return anchor;
}
