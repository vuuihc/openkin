import { describe, expect, it } from "@jest/globals";
import {
  composerBottomInset,
  HEADER_ROW_HEIGHT,
  headerTopInset,
  headerTotalHeight,
} from "./insets";

/**
 * KIN-MOBILE-001 R4 — the phone's safe-area arithmetic, without React.
 *
 * The view reads the device's insets and these two functions turn them into
 * the only paddings the conversation draws. Keeping them pure means the
 * formulas are pinned here; `Conversation.safearea.test.tsx` proves the view
 * actually applies them.
 */

describe("KIN-MOBILE-001 R4 safe-area arithmetic", () => {
  it("KIN-MOBILE-001 R4: insets: the header clears the notch and keeps a floor without one", () => {
    // A notched iPhone reports top 59; the header draws below it with 8pt of air.
    expect(headerTopInset(59)).toBe(67);
    // A device that reports no inset keeps a compact header instead of
    // reserving a notch it does not have.
    expect(headerTopInset(0)).toBe(12);
  });

  it("KIN-MOBILE-001 R4: insets: the composer clears the home indicator and stays at 24 without one", () => {
    // The home indicator is 34pt tall; 8pt above it keeps Send off the bar.
    expect(composerBottomInset(34)).toBe(42);
    // No inset: the composer keeps the 24pt it has always had.
    expect(composerBottomInset(0)).toBe(24);
  });
});

describe("KIN-MOBILE-001 R7 header height", () => {
  it("KIN-MOBILE-001 R7: the header's total height adds the status-bar air to its row", () => {
    // A notched iPhone: the 56pt row plus the 67pt the header already pads
    // above it. The list's spacer is this number, so no turn starts under the
    // glass.
    expect(headerTotalHeight(59)).toBe(HEADER_ROW_HEIGHT + 67);
    // No inset: the compact 12pt padding is still air above the same row.
    expect(headerTotalHeight(0)).toBe(HEADER_ROW_HEIGHT + 12);
  });

  it("KIN-MOBILE-001 R7: the header row is one constant", () => {
    // The stylesheet's minHeight and the list's spacer both read this one
    // number, so they cannot drift apart.
    expect(HEADER_ROW_HEIGHT).toBe(56);
    expect(headerTotalHeight(59)).toBe(HEADER_ROW_HEIGHT + headerTopInset(59));
    expect(headerTotalHeight(0)).toBe(HEADER_ROW_HEIGHT + headerTopInset(0));
  });
});
