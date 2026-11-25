import { describe, expect, it } from "@jest/globals";
import {
  SHEET_DISMISS_DISTANCE,
  dragOffset,
  shouldDismiss,
} from "./sheetDrag";

/**
 * KIN-MOBILE-001 R6 — the pull-down math for the provider/usage sheet.
 *
 * Pure numbers only: a downward drag follows the finger, an upward drag
 * clamps to zero (it must never lift the sheet), and a release past the
 * threshold dismisses. `ProviderUsageSheet.dismiss.test.tsx` proves the sheet
 * wires these to the responder props.
 */

describe("KIN-MOBILE-001 R6 sheet drag math", () => {
  it("KIN-MOBILE-001 R6: an upward or motionless drag never moves the sheet", () => {
    expect(dragOffset(300, 300)).toBe(0);
    expect(dragOffset(300, 180)).toBe(0);
    // Even a long upward pull stays clamped at the resting position.
    expect(dragOffset(500, 0)).toBe(0);
  });

  it("KIN-MOBILE-001 R6: a downward drag follows the finger", () => {
    expect(dragOffset(300, 301)).toBe(1);
    expect(dragOffset(300, 348)).toBe(48);
    expect(dragOffset(0, 240)).toBe(240);
  });

  it("KIN-MOBILE-001 R6: a drag past 96 points dismisses and one below it does not", () => {
    // Both sides of the boundary: exactly 96 is still a spring-back, 97 closes.
    expect(shouldDismiss(SHEET_DISMISS_DISTANCE - 1)).toBe(false);
    expect(shouldDismiss(SHEET_DISMISS_DISTANCE)).toBe(false);
    expect(shouldDismiss(SHEET_DISMISS_DISTANCE + 1)).toBe(true);
  });
});
