import { useSyncExternalStore } from "react";
import { sheetCount, subscribeSheets } from "../components/mobile/Sheet";

/** A portaled sheet owns the visible root's background gestures, not just its
 * own targets. Its existing stack is the durable source of the open state. */
export function useOverlayOwnsTouch(): boolean {
  return useSyncExternalStore(subscribeSheets, sheetCount, () => 0) > 0;
}
