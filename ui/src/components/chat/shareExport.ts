export type SharedMessage = {
  role: "user" | "assistant";
  text: string;
};

export type ShareLabels = {
  title: string;
  user: string;
  assistant: string;
};

/** Format selected transcript messages for a clipboard-friendly plain-text export. */
export function formatSharedText(
  messages: SharedMessage[],
  labels: ShareLabels,
): string {
  return messages
    .map((message) => `${roleLabel(message.role, labels)}\n${message.text}`)
    .join("\n\n");
}

/** Build a self-contained, readable HTML document without interpreting message text. */
export function formatSharedHTML(
  messages: SharedMessage[],
  labels: ShareLabels,
): string {
  const rows = messages
    .map(
      (message) => `
      <article class="message ${message.role}">
        <div class="role">${escapeHTML(roleLabel(message.role, labels))}</div>
        <div class="content">${escapeHTML(message.text)}</div>
      </article>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHTML(labels.title)}</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f6f7fb; color: #1c1c1e; font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(780px, calc(100% - 32px)); margin: 48px auto; }
    h1 { margin: 0 0 24px; font-size: 26px; letter-spacing: -.02em; }
    .message { margin: 16px 0; padding: 16px 18px; border: 1px solid #e3e4ea; border-radius: 16px; background: #fff; box-shadow: 0 1px 2px rgb(0 0 0 / 3%); }
    .message.user { margin-left: 9%; background: #eef5ff; border-color: #d9e8ff; }
    .role { margin-bottom: 7px; color: #61636b; font-size: 12px; font-weight: 650; }
    .content { white-space: pre-wrap; overflow-wrap: anywhere; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHTML(labels.title)}</h1>${rows}
  </main>
</body>
</html>`;
}

function roleLabel(role: SharedMessage["role"], labels: ShareLabels): string {
  return role === "user" ? labels.user : labels.assistant;
}

function escapeHTML(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}
