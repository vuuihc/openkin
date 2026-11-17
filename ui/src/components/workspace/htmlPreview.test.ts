// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  PREVIEW_CSP,
  buildPreviewDocument,
  isHtmlPath,
  previewDocumentIsEmpty,
} from "./htmlPreview";

function parse(doc: string): Document {
  return new DOMParser().parseFromString(doc, "text/html");
}

describe("isHtmlPath", () => {
  it("KIN-RESULT-002: only .html and .htm take the preview path", () => {
    expect(isHtmlPath("index.html")).toBe(true);
    expect(isHtmlPath("/repo/design/DESIGN.HTM")).toBe(true);
    expect(isHtmlPath("notes.html.txt")).toBe(false);
    expect(isHtmlPath("html")).toBe(false);
    expect(isHtmlPath("index.htmx")).toBe(false);
  });
});

describe("buildPreviewDocument", () => {
  it("KIN-RESULT-002: an inline style and a data image survive", () => {
    const doc = buildPreviewDocument(`
      <style>p { padding: 6px; }</style>
      <p class="lead" style="margin: 0">Hello</p>
      <img src="data:image/png;base64,iVBORw0KGgo=" alt="dot" width="12" height="12">
    `);

    expect(doc).toContain("p { padding: 6px; }");
    const parsed = parse(doc);
    const paragraph = parsed.body.querySelector("p");
    expect(paragraph?.textContent).toBe("Hello");
    expect(paragraph?.getAttribute("class")).toBe("lead");
    expect(paragraph?.getAttribute("style")).toBe("margin: 0");
    const image = parsed.body.querySelector("img");
    expect(image?.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(image?.getAttribute("alt")).toBe("dot");
    expect(image?.getAttribute("width")).toBe("12");
    expect(image?.getAttribute("height")).toBe("12");
  });

  it("KIN-RESULT-002: scripts, links, forms and frames are gone", () => {
    const parsed = parse(
      buildPreviewDocument(`
        <script>alert(1)</script>
        <a href="https://example.com">go</a>
        <form action="https://example.com"><input name="q"></form>
        <iframe src="https://example.com"></iframe>
        <object data="x"></object>
        <embed src="x">
        <link rel="stylesheet" href="https://example.com/x.css">
        <base href="https://example.com/">
        <p onclick="alert(1)" onmouseover="alert(2)">ok</p>
      `),
    );

    for (const selector of [
      "script",
      "a",
      "form",
      "input",
      "iframe",
      "object",
      "embed",
      "link",
      "base",
    ]) {
      expect([selector, parsed.querySelector(selector)]).toEqual([selector, null]);
    }
    const paragraph = parsed.querySelector("p");
    expect(paragraph?.textContent).toBe("ok");
    expect(paragraph?.getAttributeNames().filter((name) => name.startsWith("on"))).toEqual([]);
  });

  it("KIN-RESULT-002: a refresh or external URL never reaches the document", () => {
    const doc = buildPreviewDocument(`
      <meta http-equiv="refresh" content="0; url=https://example.com">
      <meta http-equiv="Content-Security-Policy" content="default-src *">
      <base href="https://example.com/">
      <img src="https://example.com/x.png">
      <img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">
      <img srcset="https://example.com/a.png 1x, data:image/png;base64,iVBORw0KGgo= 2x">
      <a href="https://example.com">out</a>
    `);

    expect(doc.toLowerCase()).not.toContain('http-equiv="refresh"');
    expect(doc).not.toContain("https://example.com");
    expect(doc).not.toContain("data:image/svg");
    expect(doc).not.toContain("srcset");
    const parsed = parse(doc);
    const csp = parsed.head.querySelectorAll('meta[http-equiv="Content-Security-Policy"]');
    // The source's own policy is not an explicitly harmless http-equiv; only
    // the one this module prepends remains.
    expect(csp).toHaveLength(1);
    expect(csp[0].getAttribute("content")).toBe(PREVIEW_CSP);
    expect(parsed.body.querySelectorAll("img")).toHaveLength(0);
  });

  it("KIN-RESULT-002: CSS that can fetch (import, url) is dropped whole", () => {
    const parsed = parse(
      buildPreviewDocument(`
        <style>@import url(https://example.com/x.css); p { color: red; }</style>
        <style>p { background: url(https://example.com/x.png); color: blue; }</style>
        <style>p { color: green; }</style>
        <p style="background: url(https://example.com/x.png); color: pink">x</p>
      `),
    );

    const styles = Array.from(parsed.querySelectorAll("style")).map(
      (style) => style.textContent ?? "",
    );
    expect(styles.some((css) => css.includes("color: red"))).toBe(false);
    expect(styles.some((css) => css.includes("color: blue"))).toBe(false);
    expect(styles.some((css) => css.includes("color: green"))).toBe(true);
    const paragraph = parsed.body.querySelector("p");
    expect(paragraph?.hasAttribute("style")).toBe(false);
    expect(paragraph?.textContent).toBe("x");
  });

  it("KIN-RESULT-002: the document opens with a strict CSP", () => {
    const parsed = parse(buildPreviewDocument("<p>hi</p>"));

    expect(PREVIEW_CSP).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    const first = parsed.head.firstElementChild;
    expect(first?.tagName).toBe("META");
    expect(first?.getAttribute("http-equiv")).toBe("Content-Security-Policy");
    expect(first?.getAttribute("content")).toBe(PREVIEW_CSP);
  });

  it("KIN-RESULT-002: an empty document is reported, not drawn", () => {
    expect(previewDocumentIsEmpty(buildPreviewDocument(""))).toBe(true);
    expect(previewDocumentIsEmpty(buildPreviewDocument("   \n<div></div>"))).toBe(true);
    expect(previewDocumentIsEmpty(buildPreviewDocument("<style>p{color:red}</style>"))).toBe(true);
    expect(previewDocumentIsEmpty(buildPreviewDocument("<p>hi</p>"))).toBe(false);
    expect(
      previewDocumentIsEmpty(
        buildPreviewDocument('<img src="data:image/png;base64,iVBORw0KGgo=">'),
      ),
    ).toBe(false);
  });
});
