/**
 * KIN-MOBILE-001 R4 — the markdown tables an agent answer may contain.
 *
 * The four predicates and the row walk are not re-derived here: they are the
 * console's own, in `ui/src/lib/markdownTable.ts`, imported by relative path so
 * a message reads the same on the phone as in the web console. A fenced code
 * sample is skipped before any table test, so its pipes stay code on both
 * surfaces.
 *
 * Anything the shared parser does not recognise stays text. Text blocks keep
 * their original newlines, and a message with no table comes back as one block
 * whose text is the input unchanged, so today's rendering is byte-identical.
 */

import { fenceLines, parseTable } from "../../../ui/src/lib/markdownTable";

export type Block =
  | { kind: "text"; text: string }
  | { kind: "table"; header: string[]; rows: string[][] };

export function splitTableBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const fenced = fenceLines(lines);
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
    // A fence line and everything it encloses is text, never a table.
    if (fenced[i]) {
      pending.push(lines[i]);
      i++;
      continue;
    }
    const table = parseTable(lines, i);
    if (!table) {
      pending.push(lines[i]);
      i++;
      continue;
    }

    flushText(true);
    blocks.push({ kind: "table", header: table.header, rows: table.rows });
    i = table.next;
  }
  flushText(false);

  // The common case: no table at all, and the input is handed back verbatim.
  return blocks.length ? blocks : [{ kind: "text", text }];
}
