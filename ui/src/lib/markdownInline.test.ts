import { describe, expect, it } from "vitest";
import { inlineTokens, isSafeHref } from "./markdownInline";

/**
 * KIN-MOBILE-002 R4b — the inline markdown seam both surfaces run.
 *
 * These cases pin the token list and the one judgement call the seam owns:
 * which hrefs are safe. `Markdown.tsx` used to tokenise these runs itself;
 * the tokenizer moved here so the phone draws the same runs (ADR 0036 §5).
 */

describe("KIN-MOBILE-002 R4b inline parse", () => {
  it("KIN-MOBILE-002 R4b: inline runs come back as tokens in source order, with their markers dropped", () => {
    expect(inlineTokens("先 **粗** 再 *斜* 用 `码` 看 [文档](https://kin.test/doc)。")).toEqual([
      { kind: "text", value: "先 " },
      { kind: "strong", value: "粗" },
      { kind: "text", value: " 再 " },
      { kind: "em", value: "斜" },
      { kind: "text", value: " 用 " },
      { kind: "code", value: "码" },
      { kind: "text", value: " 看 " },
      { kind: "link", value: "文档", href: "https://kin.test/doc" },
      { kind: "text", value: "。" },
    ]);
    expect(inlineTokens("__也粗__ _也斜_")).toEqual([
      { kind: "strong", value: "也粗" },
      { kind: "text", value: " " },
      { kind: "em", value: "也斜" },
    ]);
  });

  it("KIN-MOBILE-002 R4b: a link keeps its label and href", () => {
    expect(inlineTokens("[打开文档](https://kin.test/docs)")).toEqual([
      { kind: "link", value: "打开文档", href: "https://kin.test/docs" },
    ]);
    expect(inlineTokens("[上一节](../guide.md)")).toEqual([
      { kind: "link", value: "上一节", href: "../guide.md" },
    ]);
  });

  it("KIN-MOBILE-002 R4b: an unsafe href degrades to its label and drops the href", () => {
    expect(inlineTokens("[点我](javascript:alert)")).toEqual([{ kind: "link", value: "点我" }]);
    expect(isSafeHref("javascript:alert")).toBe(false);
    expect(isSafeHref("data:text/html,hi")).toBe(false);
    expect(isSafeHref("https://kin.test")).toBe(true);
    expect(isSafeHref("mailto:owner@example.com")).toBe(true);
    expect(isSafeHref("/tasks/1")).toBe(true);
    expect(isSafeHref("#reading")).toBe(true);
    expect(isSafeHref("./sibling.md")).toBe(true);
  });

  it("KIN-MOBILE-002 R4b: an unmatched marker stays visible as text", () => {
    expect(inlineTokens("未闭合 **粗体")).toEqual([{ kind: "text", value: "未闭合 **粗体" }]);
    expect(inlineTokens("孤立 `反引号")).toEqual([{ kind: "text", value: "孤立 `反引号" }]);
    expect(inlineTokens("半截 [标签](https://kin.test")).toEqual([
      { kind: "text", value: "半截 [标签](https://kin.test" },
    ]);
  });
});
