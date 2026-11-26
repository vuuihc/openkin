import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { AccessibilityInfo, findNodeHandle } from "react-native";
import { focusNode } from "./focus";

/**
 * KIN-MOBILE-001 R5 — the reader-focus seam.
 *
 * The seam exists so the screen's tests can mock one function instead of
 * React Native's module getters; here the seam itself is proven against a
 * mocked platform: a handle is what `setAccessibilityFocus` takes, and a ref
 * with nothing behind it must move nothing (AGENTS.md §13).
 */

jest.mock("react-native", () => ({
  AccessibilityInfo: { setAccessibilityFocus: jest.fn() },
  findNodeHandle: jest.fn(),
}));

const findHandle = jest.mocked(findNodeHandle);
const setFocus = jest.mocked(AccessibilityInfo.setAccessibilityFocus);

describe("KIN-MOBILE-001 R5 reader focus seam", () => {
  beforeEach(() => {
    findHandle.mockReset();
    setFocus.mockReset();
  });

  it("KIN-MOBILE-001 R5: a null ref and a node without a handle focus nothing and report false", () => {
    findHandle.mockReturnValue(undefined);

    expect(focusNode(null)).toBe(false);
    expect(focusNode(undefined)).toBe(false);
    expect(focusNode({ current: null })).toBe(false);
    // A node React knows about but the native side has no handle for yet.
    expect(focusNode({ current: { props: {} } })).toBe(false);

    // Only the one mounted-but-handleless node reached the platform.
    expect(findHandle).toHaveBeenCalledTimes(1);
    expect(setFocus).not.toHaveBeenCalled();
  });

  it("KIN-MOBILE-001 R5: a mounted node is focused through its handle", () => {
    findHandle.mockReturnValue(42);
    const ref = { current: { props: { testID: "result:approval:a1" } } };

    expect(focusNode(ref)).toBe(true);

    expect(findHandle).toHaveBeenCalledWith(ref.current);
    expect(setFocus).toHaveBeenCalledWith(42);
  });
});
