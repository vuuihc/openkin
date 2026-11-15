import { EXPORT_STYLESHEET } from "../../design/exportDocument";

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
export function formatSharedText(messages: SharedMessage[], labels: ShareLabels): string {
  return messages
    .map((message) => `${roleLabel(message.role, labels)}\n${message.text}`)
    .join("\n\n");
}

/** Build a self-contained, readable HTML document without interpreting message text. */
export function formatSharedHTML(messages: SharedMessage[], labels: ShareLabels): string {
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
  <style>${EXPORT_STYLESHEET}</style>
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
