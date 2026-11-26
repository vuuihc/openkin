/**
 * KIN-MOBILE-001 R6 — the provider/usage sheet's pull-down math.
 *
 * No React and no react-native import: the grabber strip's responder handlers
 * call these two functions, and `ProviderUsageSheet.dismiss.test.tsx` proves
 * the wiring. Keeping the numbers pure lets the threshold be asserted on both
 * sides, and the clamp be asserted against a long upward pull, without a
 * renderer.
 */

/** Points the card must travel down before a release dismisses it. */
export const SHEET_DISMISS_DISTANCE = 96;

/**
 * Points the card has moved down for a finger that started at `startPageY`
 * and is now at `pageY`. Upward travel clamps to zero: an upward drag inside
 * a sheet must never lift or close it.
 */
export function dragOffset(startPageY: number, pageY: number): number {
  return Math.max(0, pageY - startPageY);
}

/** True when the sheet should close on release. Exactly 96 springs back. */
export function shouldDismiss(offset: number): boolean {
  return offset > SHEET_DISMISS_DISTANCE;
}
