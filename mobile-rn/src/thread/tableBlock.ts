/**
 * KIN-MOBILE-001 R4 — the markdown tables an agent answer may contain.
 *
 * Parity, not an improvement: the four predicates and the block walk mirror
 * `ui/src/components/Markdown.tsx:198-270`, so a message reads the same on the
 * phone as in the web console. That file is not imported directly because the
 * console's parser also emits JSX and a code-span/emphasis tree the phone does
 * not draw; only the table seam is shared by copying it. A follow-up row
 * (`R-shared-markdown-table`) can lift the predicates into `ui/src/lib` once
 * that file is free.
 *
 * Anything the web parser does not recognise stays text — including a code
 * sample that happens to contain pipes. Text blocks keep their original
 * newlines, and a message with no table comes back as one block whose text is
 * the input unchanged, so today's rendering is byte-identical.
 */

export type Block =
  | { kind: "text"; text: string }
  | { kind: "table"; header: string[]; rows: string[][] };

function isTableDivider(line: string): boolean {
  // e.g. | --- | :---: | ---: |
  const t = line.trim();
  if (!t.includes("-")) return false;
  // Must look like a GFM separator row.
  return /^\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?$/.test(t);
}

function isTableRow(line: string): boolean {
  const t = line.trim();
  return t.includes("|") && !isTableDivider(t);
}

function splitTableRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|").map((c) => c.trim());
}

/** True when `line` starts a table: a pipe row with a divider directly under it. */
function startsTable(lines: string[], i: number): boolean {
  return (
    isTableRow(lines[i]) &&
    i + 1 < lines.length &&
    isTableDivider(lines[i + 1])
  );
}

export function splitTableBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let pending: string[] = [];

  /** Emit the buffered lines; at a table edge the blank separators go. */
  const flushText = (atTable: boolean) => {
    let kept = pending;
    if (atTable) {
      while (kept.length && kept[0].trim() === "") kept = kept.slice(1);
      while (kept.length && kept[kept.length - 1].trim() === "") {
        kept = kept.slice(0, -1);
      }
    }
    if (kept.length) {
      const joined = kept.join("\n");
      if (joined.trim() !== "") blocks.push({ kind: "text", text: joined });
    }
    pending = [];
  };

  let i = 0;
  while (i < lines.length) {
    if (!startsTable(lines, i)) {
      pending.push(lines[i]);
      i++;
      continue;
    }

    flushText(true);
    const header = splitTableRow(lines[i]);
    i += 2; // the header row and the divider are one table head
    const rows: string[][] = [];
    while (i < lines.length && isTableRow(lines[i])) {
      const cells = splitTableRow(lines[i]);
      // Pad / trim to header width for stable columns, as the web does.
      while (cells.length < header.length) cells.push("");
      rows.push(cells.slice(0, header.length));
      i++;
    }
    blocks.push({ kind: "table", header, rows });
  }
  flushText(false);

  // The common case: no table at all, and the input is handed back verbatim.
  return blocks.length ? blocks : [{ kind: "text", text }];
}
