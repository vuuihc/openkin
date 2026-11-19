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
let open = 0;
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

/** A visible panel took the screen. Every call needs its `removePanel`. */
export function addPanel(): void {
  open += 1;
  publish();
}

/** That panel is gone — unmounted, or hidden. */
export function removePanel(): void {
  open -= 1;
  publish();
}

/** Whether a visible panel owns the screen, so the approval keeps its strip. */
export function usePanelOpen(): boolean {
  return useSyncExternalStore(subscribePanels, panelOpenCount, () => 0) > 0;
}
