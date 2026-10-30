/**
 * One Back, one layer.
 *
 * A sheet pushes a single history entry. A layer opened on top of it — the run
 * settings' option list — registers a dismisser instead of pushing its own
 * entry: Back asks the newest dismisser first, and only a Back with nothing on
 * top closes the sheet. That way Back unwinds exactly the way the screen reads,
 * and the browser's history stays one entry deep no matter how many layers the
 * sheet grows.
 *
 * The same registry tells the sheet how many layers it currently has, so it can
 * keep Tab inside them and stop claiming `aria-modal` over a subtree that is
 * portaled somewhere else.
 */
type Dismisser = () => void;

const dismissers: Dismisser[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Watch the number of registered layers (for `useSyncExternalStore`). */
export function subscribeLayers(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function layerCount(): number {
  return dismissers.length;
}

/** Register the top layer's close function; returns the unregister. */
export function pushLayerDismiss(dismiss: Dismisser): () => void {
  dismissers.push(dismiss);
  emit();
  return () => {
    const at = dismissers.lastIndexOf(dismiss);
    if (at < 0) return;
    dismissers.splice(at, 1);
    emit();
  };
}

/** Close the topmost layer, if any. Returns whether one was closed. */
export function dismissTopLayer(): boolean {
  const top = dismissers[dismissers.length - 1];
  if (!top) return false;
  top();
  return true;
}

/** Test hook: drop any dismissers a failed test left behind. */
export function resetLayerDismissers(): void {
  dismissers.length = 0;
  emit();
}
