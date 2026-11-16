/**
 * Whether a key event belongs to an IME composition that is still running.
 *
 * Two signals, not one. `isComposing` is the standard answer, but some IMEs and
 * older Safari deliver the composing keydown before the flag flips — they only
 * report `keyCode` 229, the sentinel for "an IME is processing this key".
 * Reading one without the other turns Enter into a submit, or Escape into a
 * dismissal, for exactly the people this guard exists for. Astryx reached the
 * same conclusion after auditing seven call sites (`IME_GUARD_DESIGN.md`); the
 * fallback stays until a browser-matrix audit says otherwise.
 *
 * Pass the native event. React's synthetic wrapper normalizes `keyCode` away,
 * and `keyCode` is the fallback signal — so `event.nativeEvent` for a React
 * handler, the DOM event itself for a window listener.
 *
 * `isComposing` is required, not optional, so the compiler rejects a synthetic
 * event: React 18's type declares `keyCode` but not `isComposing`, and an
 * optional field would let that wrapper through to silently degrade to the
 * 229 fallback alone — the exact signal 229 exists to back up.
 */
export function isImeKeyEvent(
  event: { isComposing: boolean; keyCode?: number } | null | undefined,
): boolean {
  if (!event) return false;
  return event.isComposing || event.keyCode === 229;
}
