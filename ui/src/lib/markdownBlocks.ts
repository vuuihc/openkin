/**
 * The block markdown seam both surfaces run (KIN-MOBILE-002 R4a).
 *
 * `splitBlocks` and `Block` moved here verbatim from
 * `ui/src/components/Markdown.tsx` so the phone draws the same blocks the
 * console does instead of carrying a copy. ADR 0036 §5: a second copy of a
 * parser is the defect. The module is DOM-free — its only import is the table
 * parse both surfaces already share — so React Native can import it by
 * relative path.
 */

import { parseTable } from "./markdownTable";

export type Block =
  | { type: "p" | "h1" | "h2" | "h3"; value: string }
  | { type: "code"; value: string; lang?: string }
  | { type: "ul" | "ol"; items: string[] }
  | { type: "quote"; lines: string[] }
  | { type: "table"; header: string[]; rows: string[][] }
  | { type: "hr" };

export function splitBlocks(src: string): Block[] {
  const out: Block[] = [];
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  let para: string[] = [];
  const flush = () => {
    if (para.length) {
      out.push({ type: "p", value: para.join("\n") });
      para = [];
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      flush();
      const lang = line.slice(3).trim() || undefined;
      i++;
      const code: string[] = [];
      while (i < lines.length && !lines[i].startsWith("```")) {
        code.push(lines[i]);
        i++;
      }
      out.push({ type: "code", value: code.join("\n"), lang });
      i++; // closing fence
      continue;
    }
    if (/^#{1,3} /.test(line)) {
      flush();
      if (line.startsWith("### ")) {
        out.push({ type: "h3", value: line.slice(4) });
      } else if (line.startsWith("## ")) {
        out.push({ type: "h2", value: line.slice(3) });
      } else {
        out.push({ type: "h1", value: line.slice(2) });
      }
      i++;
      continue;
    }
    if (/^([-*_])\1{2,}\s*$/.test(line.trim())) {
      flush();
      out.push({ type: "hr" });
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      flush();
      const q: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        q.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      out.push({ type: "quote", lines: q });
      continue;
    }
    // GFM table: header | --- | body rows, parsed by the seam the phone shares.
    const table = parseTable(lines, i);
    if (table) {
      flush();
      out.push({ type: "table", header: table.header, rows: table.rows });
      i = table.next;
      continue;
    }
    // unordered list
    if (/^[-*+] /.test(line)) {
      flush();
      const items: string[] = [];
      while (i < lines.length && /^[-*+] /.test(lines[i])) {
        items.push(lines[i].replace(/^[-*+] /, ""));
        i++;
      }
      out.push({ type: "ul", items });
      continue;
    }
    // ordered list
    if (/^\d+\. /.test(line)) {
      flush();
      const items: string[] = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\. /, ""));
        i++;
      }
      out.push({ type: "ol", items });
      continue;
    }
    if (line.trim() === "") {
      flush();
      i++;
      continue;
    }
    para.push(line);
    i++;
  }
  flush();
  return out;
}
