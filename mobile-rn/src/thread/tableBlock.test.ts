import { describe, expect, it } from "@jest/globals";
import { splitTableBlocks } from "./tableBlock";

/**
 * KIN-MOBILE-001 R4 — a markdown table in an agent answer.
 *
 * The phone mirrors the web console's table parse
 * (`ui/src/components/Markdown.tsx:198-260`) rather than inventing a richer
 * markdown: a table is a pipe line immediately above a GFM divider row, the
 * divider is consumed, and body rows pad or trim to the header's width. Text
 * the parser does not recognise stays text, byte for byte.
 */

describe("KIN-MOBILE-001 R4 table blocks", () => {
  it("KIN-MOBILE-001 R4: a GFM table between two paragraphs becomes one table block in place", () => {
    const text = [
      "Here is the plan:",
      "| step | state |",
      "| --- | --- |",
      "| open | done |",
      "That is all.",
    ].join("\n");

    expect(splitTableBlocks(text)).toEqual([
      { kind: "text", text: "Here is the plan:" },
      { kind: "table", header: ["step", "state"], rows: [["open", "done"]] },
      { kind: "text", text: "That is all." },
    ]);
  });

  it("KIN-MOBILE-001 R4: the divider row is consumed and never drawn as a body row", () => {
    const text = [
      "| a | b |",
      "| :---: | ---: |",
      "| one | two |",
      "| three | four |",
    ].join("\n");

    const blocks = splitTableBlocks(text);

    expect(blocks).toEqual([
      {
        kind: "table",
        header: ["a", "b"],
        rows: [
          ["one", "two"],
          ["three", "four"],
        ],
      },
    ]);
    // Neither the divider's dashes nor its colons reach a drawn row.
    expect(JSON.stringify(blocks)).not.toContain("---");
    expect(JSON.stringify(blocks)).not.toContain(":---");
  });

  it("KIN-MOBILE-001 R4: short body rows pad to the header width and long rows trim to it", () => {
    const text = [
      "| a | b |",
      "| --- | --- |",
      "| one |",
      "| x | y | z |",
    ].join("\n");

    expect(splitTableBlocks(text)).toEqual([
      {
        kind: "table",
        header: ["a", "b"],
        rows: [
          ["one", ""],
          ["x", "y"],
        ],
      },
    ]);
  });

  it("KIN-MOBILE-001 R4: a prose line that merely contains a pipe stays text", () => {
    const text = "Use the a | b operator when the shell needs both.";

    expect(splitTableBlocks(text)).toEqual([{ kind: "text", text }]);
  });

  it("KIN-MOBILE-001 R4: text with no table returns one text block, byte-identical", () => {
    const text = "first line\n\n  indented | pipe\nlast line\n";

    expect(splitTableBlocks(text)).toEqual([{ kind: "text", text }]);
    expect(splitTableBlocks("")).toEqual([{ kind: "text", text: "" }]);
  });

  it("KIN-MOBILE-001 R4: a header and divider with no body rows still yield a table", () => {
    const text = "| a | b |\n| --- | --- |";

    expect(splitTableBlocks(text)).toEqual([
      { kind: "table", header: ["a", "b"], rows: [] },
    ]);
  });

  it("KIN-MOBILE-001 R4: a pipe line with no divider under it is not a table", () => {
    const text = "| a | b |\nplain text after the pipe line";

    expect(splitTableBlocks(text)).toEqual([{ kind: "text", text }]);
  });
});
