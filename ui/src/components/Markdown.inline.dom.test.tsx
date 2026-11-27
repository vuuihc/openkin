// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import Markdown from "./Markdown";

/**
 * KIN-MOBILE-002 R4b — the web surface's inline contract: the tokenizer now
 * lives in `ui/src/lib/markdownInline.ts`, so this case pins the four element
 * shapes and classes the console always drew.
 */

const PARAGRAPH = "一段 **粗体** 与 *斜体* 与 `npm test` 与 [文档](https://kin.test/doc)。";

describe("KIN-MOBILE-002 R4b web inline rendering", () => {
  it("KIN-MOBILE-002 R4b: strong, em, code and link render the elements and classes the console always drew", () => {
    const { container } = render(<Markdown text={PARAGRAPH} />);
    const p = container.querySelector("p");
    expect(p).not.toBeNull();

    const strong = p!.querySelector("strong");
    expect(strong?.textContent).toBe("粗体");
    expect(strong?.className).toBe("font-semibold text-kin-text");

    const em = p!.querySelector("em");
    expect(em?.textContent).toBe("斜体");
    expect(em?.className).toBe("italic text-kin-secondary");

    const code = p!.querySelector("code");
    expect(code?.textContent).toBe("npm test");
    expect(code?.className).toBe(
      "rounded bg-[var(--kin-fill-strong)] px-1 py-0.5 text-body font-mono text-kin-blue-ink",
    );

    const link = p!.querySelector("a");
    expect(link?.textContent).toBe("文档");
    expect(link?.getAttribute("href")).toBe("https://kin.test/doc");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noreferrer noopener");
    expect(link?.className).toBe(
      "text-kin-blue-ink underline decoration-kin-blue/40 underline-offset-2 hover:decoration-kin-blue",
    );

    // The reader never sees the markers, and an unsafe href keeps its label
    // in the span it always had.
    expect(p!.textContent).not.toContain("**");
    expect(p!.textContent).not.toContain("`");
    const unsafe = render(<Markdown text={"见 [点我](javascript:alert)。"} />);
    expect(unsafe.container.querySelector("a")).toBeNull();
    expect(unsafe.container.querySelector("span")?.textContent).toBe("点我");
    expect(unsafe.container.textContent).toBe("见 点我。");
  });
});
