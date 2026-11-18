/**
 * The cover's "工作方式" section: the exact text a new chat receives.
 *
 * This is the read side of `internal/store/onepager.go`. The section is one of
 * the user-owned sections of ONE_PAGER.md, and the app never writes it back —
 * editing happens in a chat or in the file. The cover therefore mirrors the
 * digest rule: same headings and aliases, same body boundaries (the next `##`
 * heading or the managed `kin:auto` block), same 400-code-point cut. Keeping a
 * build command and a list on their own lines is the point of the section, so
 * the body is not collapsed to one sentence.
 */

const INSTRUCTIONS_HEADING = /^##\s+(工作方式|How to work here|Instructions)\s*$/;
const HEADING = /^##\s+/;
const AUTO_START = "<!-- kin:auto:start -->";

/** The digest's per-section bound, counted in code points like Go runes. */
export const PROJECT_INSTRUCTIONS_MAX = 400;

export type ProjectInstructions = {
  /** The body a new chat receives, or "" when there is nothing to show. */
  text: string;
  /** True when the body was cut at the bound and the cover says so. */
  truncated: boolean;
};

/** The section body a new chat would receive, bounded to 400 code points. */
export function projectInstructions(markdown: string): ProjectInstructions {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => INSTRUCTIONS_HEADING.test(line));
  if (start < 0) return { text: "", truncated: false };

  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (HEADING.test(lines[i]) || lines[i].startsWith(AUTO_START)) break;
    body.push(lines[i]);
  }

  const text = body.join("\n").trim();
  // `-` and `—` are the template's "nothing here yet" marks, not instructions.
  if (!text || text === "-" || text === "—") return { text: "", truncated: false };

  const points = Array.from(text);
  if (points.length <= PROJECT_INSTRUCTIONS_MAX) return { text, truncated: false };
  return {
    text: points.slice(0, PROJECT_INSTRUCTIONS_MAX).join("") + "…",
    truncated: true,
  };
}
