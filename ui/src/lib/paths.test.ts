import { describe, expect, it } from "vitest";
import {
  projectLabel,
  shortPath,
  toAbsoluteWorkspacePath,
  toWorkspaceRelativePath,
} from "./paths";

describe("toAbsoluteWorkspacePath", () => {
  it("joins root and relative path", () => {
    expect(toAbsoluteWorkspacePath("/Users/me/proj", "src/main.ts")).toBe(
      "/Users/me/proj/src/main.ts",
    );
  });

  it("returns root for empty or dot relative", () => {
    expect(toAbsoluteWorkspacePath("/Users/me/proj", ".")).toBe("/Users/me/proj");
    expect(toAbsoluteWorkspacePath("/Users/me/proj", null)).toBe("/Users/me/proj");
  });

  it("rejects parent escapes and absolute inputs", () => {
    expect(toAbsoluteWorkspacePath("/Users/me/proj", "../etc/passwd")).toBeNull();
    expect(toAbsoluteWorkspacePath("/Users/me/proj", "/etc/passwd")).toBeNull();
  });

  it("normalizes slashes on root", () => {
    expect(toAbsoluteWorkspacePath("/Users/me/proj/", "a/b")).toBe(
      "/Users/me/proj/a/b",
    );
  });
});

describe("toWorkspaceRelativePath", () => {
  it("strips cwd prefix", () => {
    expect(
      toWorkspaceRelativePath("/Users/me/proj", "/Users/me/proj/src/a.ts"),
    ).toBe("src/a.ts");
  });
});

describe("projectLabel / shortPath", () => {
  it("labels project", () => {
    expect(projectLabel("/Users/me/my-app")).toBe("my-app");
  });
  it("shortens long paths", () => {
    const s = shortPath("/a/b/c/d/e/f/g", 12);
    expect(s.length).toBeLessThanOrEqual(14);
  });
});
