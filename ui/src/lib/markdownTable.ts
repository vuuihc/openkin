/**
 * The markdown table seam both surfaces run.
 *
 * ADR 0036 §5: a second copy of a parser is the defect. The phone mirrored the
 * console's predicates and row walk by copying them, and the copies drifted —
 * the phone drew a fenced code sample as a table. Both surfaces now call this
 * one DOM-free implementation, which React Native imports by relative path.
 */

export type ParsedTable = {
  header: string[];
  rows: string[][];
  /** The index one past the last body row; the caller resumes here. */
  next: number;
};

export function isTableRow(line: string): boolean {
  const t = line.trim();
  return t.includes("|") && !isTableDivider(t);
}

export function isTableDivider(line: string): boolean {
  // e.g. | --- | :---: | ---: |
  const t = line.trim();
  if (!t.includes("-")) return false;
  // Must look like a GFM separator row.
  return /^\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?$/.test(t);
}

export function splitTableRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|").map((c) => c.trim());
}

/**
 * Parse a table whose header row is `lines[i]`, or null when that line does not
 * start one. A table is a pipe row with a GFM divider directly under it; the
 * divider is consumed and never becomes a body row, and body rows pad with `""`
 * or trim to the header's width so the columns stay stable.
 */
export function parseTable(lines: string[], i: number): ParsedTable | null {
  if (i < 0 || i >= lines.length) return null;
  if (!isTableRow(lines[i]) || i + 1 >= lines.length || !isTableDivider(lines[i + 1])) {
    return null;
  }
  const header = splitTableRow(lines[i]);
  let j = i + 2;
  const rows: string[][] = [];
  while (j < lines.length && isTableRow(lines[j])) {
    const cells = splitTableRow(lines[j]);
    while (cells.length < header.length) cells.push("");
    rows.push(cells.slice(0, header.length));
    j++;
  }
  return { header, rows, next: j };
}

/**
 * One flag per line: true for a ``` fence line, every line inside it and its
 * closing fence. An unterminated fence marks every remaining line, which is
 * what the console's block walk does.
 */
export function fenceLines(lines: string[]): boolean[] {
  const fenced = lines.map(() => false);
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith("```")) {
      i++;
      continue;
    }
    fenced[i] = true;
    i++;
    while (i < lines.length && !lines[i].startsWith("```")) {
      fenced[i] = true;
      i++;
    }
    if (i < lines.length) {
      fenced[i] = true;
      i++; // the closing fence
    }
  }
  return fenced;
}
