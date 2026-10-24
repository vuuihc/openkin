import { describe, expect, it } from "vitest";
import { EXPORT_STYLESHEET } from "../../design/exportDocument";
import { formatSharedHTML, formatSharedText } from "./shareExport";

const labels = { title: "Shared conversation", user: "User", assistant: "Assistant" };

describe("share export", () => {
  const messages = [
    { role: "user" as const, text: "Hello" },
    { role: "assistant" as const, text: "Use <script>alert('x')</script>" },
  ];

  it("keeps conversation order and identifies each speaker in plain text", () => {
    expect(formatSharedText(messages, labels)).toBe(
      "User\nHello\n\nAssistant\nUse <script>alert('x')</script>",
    );
  });

  it("creates a static document and escapes untrusted message content", () => {
    const html = formatSharedHTML(messages, labels);

    expect(html).toContain("<!doctype html>");
    expect(html).toContain('<div class="role">Assistant</div>');
    expect(html).toContain("Use &lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert");
  });

  it("carries its own stylesheet, since the reader has none of ours", () => {
    // The stylesheet lives in `design/exportDocument.ts` — it is a colour
    // literal, and only `design/` may spell one — so this holds the join across
    // that module boundary. Comparing against the constant rather than a colour
    // out of it keeps the assertion exact and keeps this file free of the
    // literal the lint forbids: a `<style>` that arrived empty would still be a
    // valid document, and that is the failure being ruled out.
    const html = formatSharedHTML(messages, labels);
    expect(EXPORT_STYLESHEET.trim().length).toBeGreaterThan(0);
    expect(html).toContain(`<style>${EXPORT_STYLESHEET}</style>`);
    expect(html.indexOf("</style>")).toBeLessThan(html.indexOf("<body>"));
  });
});
