/**
 * The cover's one-line summary, read from and written back to ONE_PAGER.md.
 *
 * The project cover shows one sentence — what this project is doing now — and
 * that sentence is the One-Pager's `Current Focus` section. `North Star` is the
 * user's reason for building the project and is never rewritten by a cover
 * refresh or a recipe, so the one-line editor must not borrow it. Writing the
 * section in place keeps every other section, including the managed
 * `kin:auto` block, byte for byte.
 *
 * The section headings are the two spellings the parser and the default
 * template already use (`Current Focus` / `当前焦点`); anything else is a
 * different section and is left alone.
 */

const FOCUS_HEADING = /^##\s+(Current Focus|当前焦点)\s*$/;
const HEADING = /^##\s+/;
const AUTO_START = "<!-- kin:auto:start -->";

/** The focus section's text, whitespace collapsed to one line. */
export function onePagerFocus(markdown: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => FOCUS_HEADING.test(line));
  if (start < 0) return "";
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (HEADING.test(lines[i]) || lines[i].startsWith(AUTO_START)) break;
    body.push(lines[i]);
  }
  return body.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * The markdown with the focus section replaced by `focus`.
 *
 * An empty focus empties the section rather than deleting its heading, so a
 * later edit has the same shape to write into. A document without the section
 * gets one inserted before the managed block (or at the end), because a cover
 * that has never been edited has no focus line to replace.
 */
export function setOnePagerFocus(markdown: string, focus: string): string {
  const next = focus.replace(/\s+/g, " ").trim();
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => FOCUS_HEADING.test(line));

  if (start >= 0) {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (HEADING.test(lines[i]) || lines[i].startsWith(AUTO_START)) {
        end = i;
        break;
      }
    }
    const head = lines.slice(0, start + 1);
    const tail = lines.slice(end);
    // An empty body is one blank line, not two: the heading and the next one
    // should still read as adjacent sections.
    return [...head, ...(next ? [next, ""] : [""]), ...tail].join("\n");
  }

  if (!next) return markdown;

  const auto = lines.findIndex((line) => line.startsWith(AUTO_START));
  if (auto >= 0) {
    const before = lines.slice(0, auto);
    while (before.length > 0 && before[before.length - 1].trim() === "") before.pop();
    return [...before, "", "## Current Focus", next, "", ...lines.slice(auto)].join("\n");
  }

  return `${markdown.replace(/\s+$/, "")}\n\n## Current Focus\n${next}\n`;
}
