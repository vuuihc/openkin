import { AccessibilityInfo, findNodeHandle } from "react-native";

/**
 * KIN-MOBILE-001 R5 — the one seam that moves the phone's screen reader.
 *
 * `findNodeHandle` turns a mounted component into the native tag that
 * `setAccessibilityFocus` takes. A ref with nothing behind it — the node has
 * not committed yet, or it already unmounted — moves nothing and reports
 * `false` (AGENTS.md §13: no focus on a node that is not there).
 */
export function focusNode(
  ref: { current: unknown } | null | undefined,
): boolean {
  if (!ref || ref.current == null) return false;
  const tag = findNodeHandle(
    ref.current as Parameters<typeof findNodeHandle>[0],
  );
  if (tag == null) return false;
  AccessibilityInfo.setAccessibilityFocus(tag);
  return true;
}
