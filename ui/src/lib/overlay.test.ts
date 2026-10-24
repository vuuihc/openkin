import { describe, expect, it } from "vitest";
import { toggleOverlay } from "./overlay";

describe("toggleOverlay", () => {
  it("opens the panel that was asked for", () => {
    expect(toggleOverlay(null, "pr")).toBe("pr");
    expect(toggleOverlay(null, "files")).toBe("files");
    expect(toggleOverlay(null, "publish")).toBe("publish");
  });

  it("closes it when it is already open", () => {
    expect(toggleOverlay("pr", "pr")).toBeNull();
    expect(toggleOverlay("files", "files")).toBeNull();
    expect(toggleOverlay("publish", "publish")).toBeNull();
  });

  // The panels are the same overlay shape at the same z-index, so asking for one
  // while another is open replaces it rather than stacking — including the
  // publish sheet, which is reached from the workspace panel's own header.
  it("replaces the other panel rather than stacking", () => {
    expect(toggleOverlay("files", "pr")).toBe("pr");
    expect(toggleOverlay("pr", "files")).toBe("files");
    expect(toggleOverlay("files", "publish")).toBe("publish");
    expect(toggleOverlay("publish", "pr")).toBe("pr");
  });
});
