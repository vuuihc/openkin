import { describe, expect, it } from "vitest";
import { splitMatches } from "./highlightMatch";

/** Join the parts back: the split must lose nothing, ever. */
const text = (parts: ReturnType<typeof splitMatches>) => parts.map((p) => p.text).join("");

describe("splitMatches", () => {
  it("marks one occurrence inside a longer string", () => {
    expect(splitMatches("fix the parser", "parser")).toEqual([
      { text: "fix the ", match: false },
      { text: "parser", match: true },
    ]);
  });

  it("marks every occurrence, not just the first", () => {
    const parts = splitMatches("note the note in the notebook", "note");
    expect(parts.filter((p) => p.match).map((p) => p.text)).toEqual(["note", "note", "note"]);
    expect(text(parts)).toBe("note the note in the notebook");
  });

  it("ignores case on both sides and keeps the original casing", () => {
    expect(splitMatches("Fix The Parser", "the parser")).toEqual([
      { text: "Fix ", match: false },
      { text: "The Parser", match: true },
    ]);
  });

  it("returns the text untouched for an empty or blank query", () => {
    expect(splitMatches("anything", "")).toEqual([{ text: "anything", match: false }]);
    expect(splitMatches("anything", "   ")).toEqual([{ text: "anything", match: false }]);
  });

  it("returns the text untouched when nothing matches", () => {
    expect(splitMatches("anything", "zzz")).toEqual([{ text: "anything", match: false }]);
  });

  it("treats regex metacharacters as literal text", () => {
    // A RegExp built from the query would throw on `(` and match everything on
    // `.` — both are things a person types into a search box.
    expect(splitMatches("call f(x) now", "f(x)")).toEqual([
      { text: "call ", match: false },
      { text: "f(x)", match: true },
      { text: " now", match: false },
    ]);
    expect(splitMatches("a.b", ".")).toEqual([
      { text: "a", match: false },
      { text: ".", match: true },
      { text: "b", match: false },
    ]);
  });

  it("handles a query at the very start and the very end", () => {
    expect(splitMatches("parser fix", "parser")).toEqual([
      { text: "parser", match: true },
      { text: " fix", match: false },
    ]);
    expect(splitMatches("fix parser", "parser")).toEqual([
      { text: "fix ", match: false },
      { text: "parser", match: true },
    ]);
  });

  it("trims the query before matching", () => {
    expect(splitMatches("fix parser", "  parser  ")).toEqual([
      { text: "fix ", match: false },
      { text: "parser", match: true },
    ]);
  });

  it("declines to mark when case folding changes the string's length", () => {
    // `İ`.toLowerCase() is two code points, so every index after it shifts and
    // a marked run would cover the wrong characters. No mark is honest.
    expect(splitMatches("İstanbul", "stan")).toEqual([{ text: "İstanbul", match: false }]);
    expect(splitMatches("İabc", "bc")).toEqual([{ text: "İabc", match: false }]);
  });

  it("never invents or drops characters", () => {
    for (const [haystack, needle] of [
      ["abcabc", "abc"],
      ["aaa", "aa"],
      ["", "x"],
      ["x", ""],
      ["Ünïcode text", "ünï"],
    ] as const) {
      expect(text(splitMatches(haystack, needle))).toBe(haystack);
    }
  });
});
