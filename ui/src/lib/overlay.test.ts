import { describe, expect, it } from "vitest";
import { toggleOverlay } from "./overlay";

describe("toggleOverlay", () => {
  it("opens the panel that was asked for", () => {
    expect(toggleOverlay(null, "pr")).toBe("pr");
    expect(toggleOverlay(null, "files")).toBe("files");
  });

  it("closes it when it is already open", () => {
    expect(toggleOverlay("pr", "pr")).toBeNull();
    expect(toggleOverlay("files", "files")).toBeNull();
  });

  // The two panels are the same overlay shape at the same z-index, so asking
  // for one while the other is open replaces it rather than stacking.
  it("replaces the other panel rather than stacking", () => {
    expect(toggleOverlay("files", "pr")).toBe("pr");
    expect(toggleOverlay("pr", "files")).toBe("files");
  });
});
