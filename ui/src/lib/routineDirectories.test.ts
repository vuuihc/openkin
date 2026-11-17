import { describe, expect, it } from "vitest";
import { directoryLabel, directoryOptions } from "./routineDirectories";

describe("routineDirectories", () => {
  it("labels a directory by its last segment", () => {
    expect(directoryLabel("/work/alpha")).toBe("alpha");
    expect(directoryLabel("/work/alpha/")).toBe("alpha");
    expect(directoryLabel("/")).toBe("/");
    expect(directoryLabel("   ")).toBe("");
  });

  it("offers one option per non-empty directory, sorted", () => {
    expect(directoryOptions(["/work/beta", " /work/alpha ", "/work/alpha", ""])).toEqual([
      { id: "/work/alpha", label: "alpha" },
      { id: "/work/beta", label: "beta" },
    ]);
  });

  it("disambiguates directories that share their last segment", () => {
    expect(directoryOptions(["alpha/one", "beta/one"])).toEqual([
      { id: "alpha/one", label: "alpha/one" },
      { id: "beta/one", label: "beta/one" },
    ]);
  });

  it("grows the suffix only as far as the collision needs", () => {
    // Both end in `x/one`; only the third segment tells them apart.
    expect(directoryOptions(["/a/x/one", "/b/x/one", "/c/two"])).toEqual([
      { id: "/a/x/one", label: "a/x/one" },
      { id: "/b/x/one", label: "b/x/one" },
      { id: "/c/two", label: "two" },
    ]);
  });

  it("sorts by label and keeps the path distinct", () => {
    expect(directoryOptions(["/z/alpha", "/a/beta"]).map((option) => option.label)).toEqual([
      "alpha",
      "beta",
    ]);
  });
});
