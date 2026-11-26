import { describe, expect, it } from "vitest";
import { fenceLines, isTableDivider, isTableRow, parseTable, splitTableRow } from "./markdownTable";

/**
 * R-shared-markdown-table — the one table seam both surfaces run.
 *
 * The console and the phone used to carry a copy of this walk each, and the
 * copies drifted: the phone drew a fenced code sample as a table. These cases
 * pin the seam's own contract; each surface's rendering is pinned beside that
 * surface (`Markdown.table.dom.test.tsx`, `tableBlock.test.ts`).
 */

describe("R-shared-markdown-table predicates", () => {
  it("R-shared-markdown-table: every GFM alignment marker is a divider", () => {
    for (const line of [
      "| --- | --- |",
      "| :---: | ---: |",
      "|:--|--:|",
      "---|---",
      "| --- | :---: | ---: |",
    ]) {
      expect(isTableDivider(line), line).toBe(true);
    }
    expect(isTableDivider("| a | b |")).toBe(false);
    expect(isTableDivider("plain text")).toBe(false);
  });

  it("R-shared-markdown-table: a pipe row is a row, and the divider is not", () => {
    expect(isTableRow("| a | b |")).toBe(true);
    expect(isTableRow("a | b")).toBe(true);
    expect(isTableRow("| --- | --- |")).toBe(false);
    expect(isTableRow("no pipe here")).toBe(false);
  });

  it("R-shared-markdown-table: outer pipes and cell padding are stripped", () => {
    expect(splitTableRow("| a | b |")).toEqual(["a", "b"]);
    expect(splitTableRow("|a|b|")).toEqual(["a", "b"]);
    expect(splitTableRow("  a | b  ")).toEqual(["a", "b"]);
  });
});

describe("R-shared-markdown-table parseTable", () => {
  it("R-shared-markdown-table: a pipe row with no divider under it is not a table", () => {
    expect(parseTable(["| a | b |", "plain text after the pipe line"], 0)).toBeNull();
    expect(parseTable(["plain text", "| a | b |"], 1)).toBeNull();
  });

  it("R-shared-markdown-table: the divider never appears in rows", () => {
    const table = parseTable(
      ["| a | b |", "| :---: | ---: |", "| one | two |"],
      0,
    );

    expect(table).not.toBeNull();
    expect(table?.header).toEqual(["a", "b"]);
    expect(table?.rows).toEqual([["one", "two"]]);
    expect(JSON.stringify(table)).not.toContain("---");
  });

  it("R-shared-markdown-table: short rows pad to the header width and long rows trim to it", () => {
    const table = parseTable(
      ["| a | b |", "| --- | --- |", "| one |", "| x | y | z |"],
      0,
    );

    expect(table?.rows).toEqual([
      ["one", ""],
      ["x", "y"],
    ]);
  });

  it("R-shared-markdown-table: next is the index after the last body row", () => {
    const lines = [
      "before",
      "| a | b |",
      "| --- | --- |",
      "| one | two |",
      "| three | four |",
      "after",
    ];

    const table = parseTable(lines, 1);

    expect(table?.next).toBe(5);
    expect(lines[table?.next ?? -1]).toBe("after");
  });

  it("R-shared-markdown-table: a header and divider with no body rows still parse", () => {
    const table = parseTable(["| a | b |", "| --- | --- |"], 0);

    expect(table).toEqual({ header: ["a", "b"], rows: [], next: 2 });
  });
});

describe("R-shared-markdown-table fenceLines", () => {
  it("R-shared-markdown-table: an unterminated fence marks every remaining line", () => {
    const lines = ["before", "```", "| a | b |", "| --- | --- |"];
    expect(fenceLines(lines)).toEqual([false, true, true, true]);
  });

  it("R-shared-markdown-table: a closed fence marks only its own region", () => {
    const lines = ["```js", "code", "```", "| a | b |", "| --- | --- |"];
    expect(fenceLines(lines)).toEqual([true, true, true, false, false]);
  });

  it("R-shared-markdown-table: text with no fence marks nothing", () => {
    expect(fenceLines(["a", "", "b"])).toEqual([false, false, false]);
    expect(fenceLines([])).toEqual([]);
  });
});
