/**
 * A compact preview of what one tool call changed in one file.
 *
 * The before/after pair this draws from is reconstructed from the tool payload
 * (see `extractFileDiff` in `changedFiles.ts`), so it is not a diff of the file
 * on disk and must not read like one: a `write` says nothing about what it
 * replaced, a `str_replace` only knows the block it was handed. The workspace
 * and PR panels are where the authoritative diff lives; this is here so a phone
 * looking at the conversation does not have to go looking for it.
 *
 * The other reason this is line-based rather than an editor: Monaco's DiffEditor
 * would give the payload the same weight as a real diff, and a best-effort
 * reconstruction presented side-by-side in a real editable-looking surface is
 * exactly the impression the paragraph above is trying to avoid.
 */

export type PreviewLineType = "add" | "del" | "ctx";

export type PreviewLine = {
  type: PreviewLineType;
  text: string;
};

export type PreviewOptions = {
  /** Lines of unchanged context kept around each change, at the two ends. */
  context?: number;
  /** Total lines the preview may hold before the rest is counted as hidden. */
  maxLines?: number;
};

export type DiffPreview = {
  lines: PreviewLine[];
  /** Lines the payload had that did not fit; the card says so rather than cutting silently. */
  hidden: number;
};

/** Lines of a payload as a diff sees them: a trailing newline ends the last line, it does not start an empty one. */
function splitPayloadLines(text: string): string[] {
  if (text === "") return [];
  const parts = text.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/**
 * The middle of a change: the lines the two sides do not share, with the ones
 * they share kept in place.
 *
 * The quadratic walk is bounded rather than trusted: a payload can be a whole
 * file, and asking for an LCS over two large blocks costs more than the preview
 * is worth. Past the bound the block form is used — every removed line, then
 * every added one — which is less readable and never wrong.
 */
function middleDiff(original: string[], modified: string[]): PreviewLine[] {
  const lines: PreviewLine[] = [];
  if (original.length * modified.length > 20_000) {
    for (const text of original) lines.push({ type: "del", text });
    for (const text of modified) lines.push({ type: "add", text });
    return lines;
  }

  // table[i][j] = length of the longest common subsequence of the suffixes
  // starting at i and j.
  const table: number[][] = Array.from({ length: original.length + 1 }, () =>
    new Array<number>(modified.length + 1).fill(0),
  );
  for (let i = original.length - 1; i >= 0; i -= 1) {
    for (let j = modified.length - 1; j >= 0; j -= 1) {
      table[i][j] =
        original[i] === modified[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  let i = 0;
  let j = 0;
  while (i < original.length && j < modified.length) {
    if (original[i] === modified[j]) {
      lines.push({ type: "ctx", text: original[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      lines.push({ type: "del", text: original[i] });
      i += 1;
    } else {
      lines.push({ type: "add", text: modified[j] });
      j += 1;
    }
  }
  for (; i < original.length; i += 1) lines.push({ type: "del", text: original[i] });
  for (; j < modified.length; j += 1) lines.push({ type: "add", text: modified[j] });
  return lines;
}

/**
 * The preview for one before/after pair, or null when there is nothing to show.
 *
 * Null rather than an empty preview, so the caller has one question to ask
 * ("is there a preview?") instead of two, and a card never renders a box with
 * nothing in it. Identical text is the case this answers: a payload that
 * replaces a block with itself changed nothing.
 */
export function previewFromTexts(
  original: string,
  modified: string,
  options: PreviewOptions = {},
): DiffPreview | null {
  if (original === modified) return null;
  const context = options.context ?? 3;
  const maxLines = options.maxLines ?? 40;

  const before = splitPayloadLines(original);
  const after = splitPayloadLines(modified);

  // Trim the ends both sides share: a whole-file payload and a patch that
  // carries its own context would otherwise spend the preview on lines that did
  // not change. Whatever is left is the change with `context` lines of its
  // surroundings.
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) {
    start += 1;
  }
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1;
    endAfter -= 1;
  }

  const body = middleDiff(before.slice(start, endBefore), after.slice(start, endAfter));
  if (!body.some((line) => line.type !== "ctx")) return null;

  const lines: PreviewLine[] = [
    ...before
      .slice(Math.max(0, start - context), start)
      .map((text) => ({ type: "ctx" as const, text })),
    ...body,
    ...before
      .slice(endBefore, Math.min(before.length, endBefore + context))
      .map((text) => ({ type: "ctx" as const, text })),
  ];

  const hidden = Math.max(0, lines.length - maxLines);
  return { lines: hidden > 0 ? lines.slice(0, maxLines) : lines, hidden };
}
