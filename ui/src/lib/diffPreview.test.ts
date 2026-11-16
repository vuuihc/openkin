import { describe, expect, it } from "vitest";
import { previewFromTexts, type PreviewLine } from "./diffPreview";

const shape = (lines: PreviewLine[]) => lines.map((line) => `${line.type}:${line.text}`);

describe("previewFromTexts", () => {
  it("has nothing to show when the payload changed nothing", () => {
    expect(previewFromTexts("", "")).toBeNull();
    expect(previewFromTexts("same\nlines\n", "same\nlines\n")).toBeNull();
    // Same text, different trailing newline: still no line the reader can see.
    expect(previewFromTexts("same\nlines", "same\nlines\n")).toBeNull();
  });

  it("reads a replacement as the removed lines then the added ones", () => {
    const preview = previewFromTexts("const a = 1;\nconst b = 2;", "const a = 1;\nconst b = 3;");
    expect(preview).not.toBeNull();
    // Two identical leading lines: the first is shared context, the changed one
    // is a pair because the lines around it are not equal.
    expect(shape(preview!.lines)).toEqual([
      "ctx:const a = 1;",
      "del:const b = 2;",
      "add:const b = 3;",
    ]);
    expect(preview!.hidden).toBe(0);
  });

  it("keeps only the surroundings of the change, not the whole file", () => {
    const before = ["1", "2", "3", "4", "5", "6", "7", "8", "9"].join("\n");
    const after = ["1", "2", "3", "4", "5", "6", "7", "8", "nine"].join("\n");
    const preview = previewFromTexts(before, after, { context: 2 });
    expect(shape(preview!.lines)).toEqual(["ctx:7", "ctx:8", "del:9", "add:nine"]);
  });

  it("keeps lines the two sides share inside the change", () => {
    const preview = previewFromTexts("start\nkeep me\nold\ndone", "start\nkeep me\nnew\ndone", {
      context: 0,
    });
    expect(shape(preview!.lines)).toEqual(["del:old", "add:new"]);
    // `b` is on both sides and inside the change, so it stays as context instead
    // of being read as a removal and an addition.
    const withInterior = previewFromTexts("a\nx\nb", "a\ny\nb\nc", { context: 0 });
    expect(shape(withInterior!.lines)).toEqual(["del:x", "add:y", "ctx:b", "add:c"]);
    // ...and the shared `a` at the head is context the caller asked for, or it is
    // trimmed away with the rest of the unchanged ends.
    const withHead = previewFromTexts("a\nx\nb", "a\ny\nb\nc", { context: 1 });
    expect(shape(withHead!.lines)).toEqual(["ctx:a", "del:x", "add:y", "ctx:b", "add:c"]);
  });

  it("reads a whole-file write as additions only", () => {
    const preview = previewFromTexts("", "# Title\n\nbody\n");
    expect(shape(preview!.lines)).toEqual(["add:# Title", "add:", "add:body"]);
  });

  it("bounds a payload bigger than the preview and says how much it hid", () => {
    const before = Array.from({ length: 60 }, (_, i) => `old ${i}`).join("\n");
    const after = Array.from({ length: 60 }, (_, i) => `new ${i}`).join("\n");
    const preview = previewFromTexts(before, after, { maxLines: 10 });
    expect(preview!.lines).toHaveLength(10);
    // Every line of both sides was a change, so the rest is what was hidden.
    expect(preview!.hidden).toBe(120 - 10);
  });

  it("does not silently drop a change that fits", () => {
    const preview = previewFromTexts("only line", "other line", { maxLines: 2 });
    expect(shape(preview!.lines)).toEqual(["del:only line", "add:other line"]);
    expect(preview!.hidden).toBe(0);
  });

  it("keeps a blank line inside the change distinct from no change", () => {
    const preview = previewFromTexts("a\n\nb", "a\n\nb\nc");
    expect(shape(preview!.lines)).toEqual(["ctx:a", "ctx:", "ctx:b", "add:c"]);
  });
});
