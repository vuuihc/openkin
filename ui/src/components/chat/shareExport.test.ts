import { describe, expect, it } from "vitest";
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
    expect(html).toContain("<div class=\"role\">Assistant</div>");
    expect(html).toContain("Use &lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert");
  });
});
