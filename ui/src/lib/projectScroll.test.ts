// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readProjectScroll, writeProjectScroll } from "./projectScroll";

/**
 * Where the reader was is a per-tab convenience; a browser that refuses
 * storage must not take the cover with it. The guards are the only thing
 * between a private window and a crash, so they get a test of their own.
 */
describe("the project cover's scroll memory (KIN-PROJECT-001)", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("round-trips one project's position without touching another", () => {
    writeProjectScroll("p1", 480);
    expect(readProjectScroll("p1")).toBe(480);
    expect(readProjectScroll("p2")).toBe(0);
  });

  it("stores a whole, non-negative pixel offset", () => {
    writeProjectScroll("p1", 12.6);
    expect(readProjectScroll("p1")).toBe(13);
    writeProjectScroll("p1", -5);
    expect(readProjectScroll("p1")).toBe(0);
    writeProjectScroll("p1", Number.NaN);
    expect(readProjectScroll("p1")).toBe(0);
  });

  it("treats garbage as no position", () => {
    sessionStorage.setItem("kin_project_scroll:p1", "not a number");
    expect(readProjectScroll("p1")).toBe(0);
    expect(readProjectScroll("")).toBe(0);
  });

  it("survives a storage that throws", () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });

    expect(() => writeProjectScroll("p1", 480)).not.toThrow();
    expect(readProjectScroll("p1")).toBe(0);
    get.mockRestore();
    set.mockRestore();
  });
});
