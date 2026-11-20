// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { getHiddenRunIds, HIDDEN_RUNS_MAX, hideRunIds, unhideAll } from "./routineHiddenRuns";

const STORAGE_KEY = "kin_routine_hidden_runs";

beforeEach(() => {
  localStorage.clear();
});

describe("routineHiddenRuns", () => {
  it("round-trips hidden ids per machine and reads malformed storage as none", () => {
    expect([...hideRunIds("dev-a", ["r1", "r2"])]).toEqual(["r1", "r2"]);
    expect([...getHiddenRunIds("dev-a")]).toEqual(["r1", "r2"]);
    expect([...getHiddenRunIds("dev-b")]).toEqual([]);

    const malformed: Array<[string, string[]]> = [
      ["{", []],
      ["null", []],
      ["[]", []],
      ['"r1"', []],
      ['{"dev-a":"r1"}', []],
      ['{"dev-a":[1,"r2",null]}', ["r2"]],
    ];
    for (const [stored, expected] of malformed) {
      localStorage.setItem(STORAGE_KEY, stored);
      expect([...getHiddenRunIds("dev-a")]).toEqual(expected);
    }
  });

  it("caps one machine's list at 500, keeping the most recently hidden", () => {
    const first = Array.from({ length: HIDDEN_RUNS_MAX }, (_, i) => `old-${i}`);
    hideRunIds("dev-a", first);
    const ids = hideRunIds("dev-a", ["new-1", "new-2"]);
    expect(ids.size).toBe(HIDDEN_RUNS_MAX);
    expect(ids.has("old-0")).toBe(false);
    expect(ids.has("old-1")).toBe(false);
    expect(ids.has("old-2")).toBe(true);
    expect(ids.has("new-1")).toBe(true);
    expect(ids.has("new-2")).toBe(true);
    expect([...getHiddenRunIds("dev-a")]).toEqual([...ids]);
  });

  it("keeps two machines' hides separate", () => {
    hideRunIds("dev-a", ["a-1", "a-2"]);
    hideRunIds("dev-b", ["b-1"]);
    expect([...getHiddenRunIds("dev-a")]).toEqual(["a-1", "a-2"]);
    expect([...getHiddenRunIds("dev-b")]).toEqual(["b-1"]);

    unhideAll("dev-a");
    expect([...getHiddenRunIds("dev-a")]).toEqual([]);
    expect([...getHiddenRunIds("dev-b")]).toEqual(["b-1"]);
  });
});
