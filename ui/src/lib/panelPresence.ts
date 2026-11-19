import { useSyncExternalStore } from "react";

/**
 * How many visible panels are open, as one value.
 *
 * A panel is a topmost surface: the reader opened the file viewer or the PR
 * panel to read it. The floating approval subscribes to this so it can keep its
 * one-line strip instead of painting the decision card over the panel body —
 * at 390 the panel is full-bleed, so the card used to cover the file *and* the
 * panel's own approval area.
 *
 * A count, not a boolean: two panels can be open at once, and closing one must
 * not hand the card back over the other. Same shape as `overlayOwnsTouch` and
 * `Sheet` — a module-level store the containers write and the reader
 * subscribes to, with a server snapshot of zero.
 *
 * The panel container (`PanelSurface`) is the only writer. A panel that is
 * mounted but hidden never registers: the terminal holds a live PTY behind
 * `hidden`, and nothing can be covered by a surface that is not painted.
 */

/**
 * The width a visible panel takes, mirrored from `PanelSurface`'s `PanelShape`
 * (declared here so the store does not import the container that writes it).
 *
 * Only a `column` panel leaves the conversation on screen; from `lg` up it is
 * the 380px right-hand column, and below `lg` even a column panel is the
 * full-bleed overlay. The floating approval reads this to keep its strip over
 * the conversation instead of inside the panel's own bottom controls.
 */
export type PanelShape = "overlay" | "column";

let open = 0;
let columns = 0;
const subscribers = new Set<() => void>();

function publish(): void {
  for (const notify of subscribers) notify();
}

export function subscribePanels(notify: () => void): () => void {
  subscribers.add(notify);
  return () => {
    subscribers.delete(notify);
  };
}

/** Visible panels open right now. */
export function panelOpenCount(): number {
  return open;
}

/** Visible panels that take the column beside the conversation. */
export function panelColumnCount(): number {
  return columns;
}

/**
 * A visible panel took the screen. Every call needs its `removePanel` with the
 * same shape — the count and the column count must move together or the
 * approval offsets by a panel that is no longer there.
 */
export function addPanel(shape: PanelShape = "overlay"): void {
  open += 1;
  if (shape === "column") columns += 1;
  publish();
}

/** That panel is gone — unmounted, or hidden. */
export function removePanel(shape: PanelShape = "overlay"): void {
  open -= 1;
  if (shape === "column") columns -= 1;
  publish();
}

/** Whether a visible panel owns the screen, so the approval keeps its strip. */
export function usePanelOpen(): boolean {
  return useSyncExternalStore(subscribePanels, panelOpenCount, () => 0) > 0;
}

/** Whether one of the open panels is the side column. */
export function usePanelColumnOpen(): boolean {
  return useSyncExternalStore(subscribePanels, panelColumnCount, () => 0) > 0;
}
