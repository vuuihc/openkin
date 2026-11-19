/** Helpers for chat attachment display / prompt scrubbing. */

/**
 * Composer injects a trailing block like:
 *
 *   Attached image:
 *   - shot.png: /Users/me/.kin/uploads/abc.png
 *
 * The absolute path is for the agent (and vision embedder), not for the UI.
 * These helpers strip or rewrite that block so the chat timeline never shows
 * local filesystem paths, and turn image lines back into drawable previews.
 */

const ATTACHED_BLOCK_RE = /(?:^|\n)Attached (?:image|file|files):\n((?:[ \t]*-[ \t].+\n?)*)/i;

/**
 * One `- name: path` line. The path may contain spaces (a directory or a
 * filename can), so it is "everything after the colon", not one whitespace-free
 * token — the old shape dropped such a line's filename entirely.
 */
const ATTACHED_LINE_RE = /^[ \t]*-[ \t]+(.+?):[ \t]+(.+?)\s*$/;

/** Types the bubble can draw. SVG deliberately stays a filename chip. */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "heic"]);

/** An attachment the bubble can draw, named the way the prompt named it. */
export type UserImage = {
  /** The filename the prompt showed, used as the alt text and chip label. */
  name: string;
  /** Same-origin preview URL under `/api/uploads/`; never an absolute path. */
  src: string;
};

export type ParsedUserPrompt = {
  /** Exactly what `displayUserPrompt` returns: no paths, summary kept. */
  text: string;
  /** Attachments with a drawable image extension, in prompt order. */
  images: UserImage[];
  /** Non-image attachment names, in prompt order. */
  files: string[];
};

/** The last path segment; accepts POSIX and Windows separators. */
function basename(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut >= 0 ? path.slice(cut + 1) : path;
}

function extensionOf(path: string): string {
  const base = basename(path).toLowerCase();
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1) : "";
}

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
 * Split a prompt into the text the reader sees and the attachments it carried.
 *
 * The text is the human-facing label shape (filename summary, no directory);
 * `images` and `files` are what a bubble can draw. The preview URL is derived
 * from the stored basename under `/api/uploads/` — the absolute path stays in
 * the prompt only, where the agent can read it.
 */
export function parseUserPrompt(text: string): ParsedUserPrompt {
  if (!text) return { text, images: [], files: [] };
  const m = text.match(ATTACHED_BLOCK_RE);
  if (!m) return { text, images: [], files: [] };

  const block = m[0];
  const names: string[] = [];
  const images: UserImage[] = [];
  const files: string[] = [];
  for (const line of (m[1] || "").split("\n")) {
    const lm = line.match(ATTACHED_LINE_RE);
    if (!lm) continue;
    const name = lm[1].trim();
    const path = lm[2].trim();
    names.push(name);
    const base = basename(path);
    if (base && IMAGE_EXTENSIONS.has(extensionOf(path))) {
      images.push({ name, src: `/api/uploads/${encodeURIComponent(base)}` });
    } else {
      files.push(name);
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
  return { text: without ? `${without}\n\n${summary}` : summary, images, files };
}

/**
 * Human-facing label for a prompt that may include attachments.
 * Keeps the user text; replaces the path list with a short chip-like summary
 * (filename only, no directory).
 */
export function displayUserPrompt(text: string): string {
  return parseUserPrompt(text).text;
}
