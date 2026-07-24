/** Helpers for chat attachment display / prompt scrubbing. */

/**
 * Composer injects a trailing block like:
 *
 *   Attached image:
 *   - shot.png: /Users/me/.kin/uploads/abc.png
 *
 * The absolute path is for the agent (and vision embedder), not for the UI.
 * These helpers strip or rewrite that block so the chat timeline never shows
 * local filesystem paths.
 */

const ATTACHED_BLOCK_RE =
  /(?:^|\n)Attached (?:image|file|files):\n((?:[ \t]*-[ \t].+\n?)*)/i;

/** Remove the whole "Attached …:" path block from a user prompt. */
export function stripAttachmentBlock(text: string): string {
  if (!text) return text;
  // Drop the whole attachment path block; collapse leftover blank lines.
  return text
    .replace(ATTACHED_BLOCK_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

/**
 * Human-facing label for a prompt that may include attachments.
 * Keeps the user text; replaces the path list with a short chip-like summary
 * (filename only, no directory).
 */
export function displayUserPrompt(text: string): string {
  if (!text) return text;
  const m = text.match(ATTACHED_BLOCK_RE);
  if (!m) return text;
  const block = m[0];
  const lines = (m[1] || "").split("\n");
  const names: string[] = [];
  for (const line of lines) {
    const lm = line.match(/^[ \t]*-[ \t]+(.+?):\s+\S+\s*$/);
    if (lm) {
      names.push(lm[1].trim());
      continue;
    }
  }
  const headerMatch = block.match(/Attached (image|file|files)/i);
  const noun = (headerMatch?.[1] || "file").toLowerCase();
  const summary =
    names.length === 0
      ? `Attached ${noun}`
      : names.length === 1
        ? `Attached ${noun}: ${names[0]}`
        : `Attached ${noun}: ${names.join(", ")}`;

  const without = stripAttachmentBlock(text).trimEnd();
  if (!without) return summary;
  return `${without}\n\n${summary}`;
}
