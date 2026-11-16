import { describe, expect, it } from "vitest";
import { findMatches, stepMatch } from "./findInTranscript";

const items = [
  { key: "a", text: "The parser rejects empty input" },
  { key: "b", text: "Unrelated message" },
  { key: "c", text: "Fix the PARSER tests" },
];

describe("findMatches", () => {
  it("returns every matching message in transcript order", () => {
    expect(findMatches(items, "parser")).toEqual(["a", "c"]);
  });

  it("is case-insensitive", () => {
    expect(findMatches(items, "PARSER")).toEqual(["a", "c"]);
  });

  it("returns nothing for a blank query", () => {
    expect(findMatches(items, "")).toEqual([]);
    expect(findMatches(items, "   ")).toEqual([]);
  });

  it("returns nothing when the text is absent", () => {
    expect(findMatches(items, "zzz")).toEqual([]);
  });

  it("treats regex metacharacters literally", () => {
    const withParens = [{ key: "a", text: "call f(x) now" }];
    expect(findMatches(withParens, "f(x)")).toEqual(["a"]);
    expect(findMatches(withParens, "f.")).toEqual([]);
  });
});

describe("stepMatch", () => {
  it("wraps forward and backward", () => {
    expect(stepMatch(0, 1, 3)).toBe(1);
    expect(stepMatch(2, 1, 3)).toBe(0);
    expect(stepMatch(0, -1, 3)).toBe(2);
  });

  it("reports nothing to step through for an empty result set", () => {
    expect(stepMatch(0, 1, 0)).toBe(-1);
    expect(stepMatch(-1, 1, 0)).toBe(-1);
  });

  it("normalises an out-of-range index", () => {
    expect(stepMatch(-1, 1, 3)).toBe(0);
    expect(stepMatch(9, 0, 3)).toBe(0);
  });
});
