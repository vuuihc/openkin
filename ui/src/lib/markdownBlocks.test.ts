import { describe, expect, it } from "vitest";
import { splitBlocks } from "./markdownBlocks";

/**
 * KIN-MOBILE-002 R4a — the block parse both surfaces run.
 *
 * The console's `splitBlocks` moved out of `ui/src/components/Markdown.tsx`
 * into this DOM-free module so the phone draws the same blocks the console
 * does (ADR 0036 §5: a second copy of a parser is the defect). These cases pin
 * the contract the extraction had to preserve — a heading, a list, a fence, a
 * quote and a rule are each their own block, a table is one block in place,
 * blank lines separate paragraphs, and CRLF parses like LF.
 */

describe("KIN-MOBILE-002 R4a block parse", () => {
  it("KIN-MOBILE-002 R4a: a heading, a bullet list, a fenced code block, a quote and an hr each come back as their own block", () => {
    const text = [
      "## 结论",
      "- 一",
      "- 二",
      "```ts",
      "const a = 1;",
      "```",
      "> 引用",
      "---",
    ].join("\n");

    expect(splitBlocks(text)).toEqual([
      { type: "h2", value: "结论" },
      { type: "ul", items: ["一", "二"] },
      { type: "code", value: "const a = 1;", lang: "ts" },
      { type: "quote", lines: ["引用"] },
      { type: "hr" },
    ]);
  });

  it("KIN-MOBILE-002 R4a: a fenced code sample full of pipes is code and never a table", () => {
    const text = [
      "看这个样例：",
      "```",
      "| step | state |",
      "| --- | --- |",
      "| open | done |",
      "```",
      "看完。",
    ].join("\n");

    const blocks = splitBlocks(text);

    expect(blocks.map((block) => block.type)).toEqual(["p", "code", "p"]);
    const code = blocks[1];
    expect(code.type).toBe("code");
    if (code.type === "code") {
      expect(code.value).toContain("| step | state |");
      expect(code.value).toContain("| --- | --- |");
    }
    expect(blocks.some((block) => block.type === "table")).toBe(false);
  });

  it("KIN-MOBILE-002 R4a: a table between paragraphs is one table block placed between them", () => {
    const text = [
      "前一段。",
      "| 步骤 | 状态 |",
      "| --- | --- |",
      "| 打开 | 完成 |",
      "| x | y | z |",
      "后一段。",
    ].join("\n");

    expect(splitBlocks(text)).toEqual([
      { type: "p", value: "前一段。" },
      {
        type: "table",
        header: ["步骤", "状态"],
        // A long body row trims to the header's width; a short one pads.
        rows: [
          ["打开", "完成"],
          ["x", "y"],
        ],
      },
      { type: "p", value: "后一段。" },
    ]);
  });

  it("KIN-MOBILE-002 R4a: blank lines separate paragraphs and a trailing blank line adds no empty block", () => {
    expect(splitBlocks("第一段。\n\n第二段。\n")).toEqual([
      { type: "p", value: "第一段。" },
      { type: "p", value: "第二段。" },
    ]);
    expect(splitBlocks("第一段。\n\n\n")).toEqual([{ type: "p", value: "第一段。" }]);
    expect(splitBlocks("")).toEqual([]);
  });

  it("KIN-MOBILE-002 R4a: CRLF input parses exactly like LF input", () => {
    const lines = [
      "## 标题",
      "- 一",
      "- 二",
      "```ts",
      "const a = 1;",
      "```",
      "> 引用",
      "---",
      "普通段落。",
    ];

    expect(splitBlocks(lines.join("\r\n"))).toEqual(splitBlocks(lines.join("\n")));
  });
});
