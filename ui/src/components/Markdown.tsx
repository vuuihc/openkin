import type { ReactNode } from "react";

/**
 * Lightweight markdown renderer (no extra deps).
 * Supports: headings, fenced code, paragraphs, lists, blockquotes,
 * hr, GFM tables, links, bold, italic, inline code.
 */
export default function Markdown({
  text,
  className = "",
}: {
  text: string;
  className?: string;
}) {
  if (!text) return null;
  const blocks = splitBlocks(text);
  return (
    <div
      className={[
        "kin-md space-y-2.5 text-[14px] sm:text-[15px] text-kin-text leading-relaxed break-words",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {blocks.map((b, i) => {
        if (b.type === "code") {
          return (
            <pre
              key={i}
              className="overflow-x-auto rounded-lg bg-[var(--kin-fill)] border border-[var(--kin-hairline)] p-3 text-[12px] sm:text-[12.5px] font-mono text-kin-secondary"
            >
              {b.lang ? (
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-kin-muted">
                  {b.lang}
                </div>
              ) : null}
              <code className="whitespace-pre">{b.value}</code>
            </pre>
          );
        }
        if (b.type === "h1" || b.type === "h2" || b.type === "h3") {
          const Tag = b.type;
          const size =
            b.type === "h1"
              ? "text-[16px] sm:text-[17px] font-semibold mt-1"
              : b.type === "h2"
                ? "text-[15px] sm:text-[16px] font-semibold mt-0.5"
                : "text-[14px] sm:text-[15px] font-semibold";
          return (
            <Tag key={i} className={`${size} text-kin-text`}>
              {inline(b.value)}
            </Tag>
          );
        }
        if (b.type === "ul" || b.type === "ol") {
          const Tag = b.type;
          return (
            <Tag
              key={i}
              className={[
                "pl-5 space-y-1 text-kin-text",
                b.type === "ul" ? "list-disc" : "list-decimal",
              ].join(" ")}
            >
              {b.items.map((item, j) => (
                <li key={j} className="pl-0.5">
                  {inline(item)}
                </li>
              ))}
            </Tag>
          );
        }
        if (b.type === "quote") {
          return (
            <blockquote
              key={i}
              className="border-l-2 border-kin-blue/50 pl-3 text-kin-secondary italic"
            >
              {b.lines.map((line, j) => (
                <p key={j} className={j > 0 ? "mt-1" : undefined}>
                  {inline(line)}
                </p>
              ))}
            </blockquote>
          );
        }
        if (b.type === "hr") {
          return (
            <hr
              key={i}
              className="border-0 border-t border-[var(--kin-hairline)] my-1"
            />
          );
        }
        if (b.type === "table") {
          return (
            <div
              key={i}
              className="overflow-x-auto rounded-lg border border-[var(--kin-hairline)]"
            >
              <table className="w-full min-w-[240px] border-collapse text-left text-[13px] sm:text-[13.5px]">
                <thead className="bg-[var(--kin-fill)]">
                  <tr>
                    {b.header.map((cell, j) => (
                      <th
                        key={j}
                        className="border-b border-[var(--kin-hairline)] px-3 py-2 font-semibold text-kin-text align-top"
                      >
                        {inline(cell)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {b.rows.map((row, ri) => (
                    <tr
                      key={ri}
                      className="odd:bg-transparent even:bg-[var(--kin-fill)]/40"
                    >
                      {row.map((cell, ci) => (
                        <td
                          key={ci}
                          className="border-b border-[var(--kin-hairline)] px-3 py-2 text-kin-secondary align-top"
                        >
                          {inline(cell)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        // paragraph
        return (
          <p key={i} className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
            {inline(b.type === "p" ? b.value : "")}
          </p>
        );
      })}
    </div>
  );
}

type Block =
  | { type: "p" | "h1" | "h2" | "h3"; value: string }
  | { type: "code"; value: string; lang?: string }
  | { type: "ul" | "ol"; items: string[] }
  | { type: "quote"; lines: string[] }
  | { type: "table"; header: string[]; rows: string[][] }
  | { type: "hr" };

function splitBlocks(src: string): Block[] {
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
    // GFM table: header | --- | body rows
    if (isTableHeader(line) && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      flush();
      const header = splitTableRow(line);
      i += 2; // skip header + divider
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i])) {
        const cells = splitTableRow(lines[i]);
        // Pad / trim to header width for stable columns.
        while (cells.length < header.length) cells.push("");
        rows.push(cells.slice(0, header.length));
        i++;
      }
      out.push({ type: "table", header, rows });
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

function isTableHeader(line: string): boolean {
  const t = line.trim();
  return t.includes("|") && !isTableDivider(t);
}

function isTableDivider(line: string): boolean {
  const t = line.trim();
  if (!t.includes("|") && !t.includes("-")) return false;
  // | --- | :---: | ---: |
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(t);
}

function isTableRow(line: string): boolean {
  const t = line.trim();
  if (!t || isTableDivider(t)) return false;
  return t.includes("|");
}

function splitTableRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|").map((c) => c.trim());
}

function inline(s: string): ReactNode[] {
  // Links [text](url), bold **x** / __x__, italic *x* / _x_, inline `code`
  const parts: ReactNode[] = [];
  const re =
    /(\[[^\]]+\]\([^)\s]+\)|\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*]+\*|_[^_\s][^_]*_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) parts.push(s.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("[") && tok.includes("](")) {
      const lm = tok.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
      if (lm) {
        const href = lm[2];
        const safe =
          href.startsWith("http://") ||
          href.startsWith("https://") ||
          href.startsWith("mailto:");
        parts.push(
          safe ? (
            <a
              key={key++}
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              className="text-kin-blue underline decoration-kin-blue/40 underline-offset-2 hover:decoration-kin-blue"
            >
              {lm[1]}
            </a>
          ) : (
            <span key={key++}>{lm[1]}</span>
          ),
        );
      } else {
        parts.push(tok);
      }
    } else if (tok.startsWith("**") || tok.startsWith("__")) {
      parts.push(
        <strong key={key++} className="font-semibold text-kin-text">
          {tok.slice(2, -2)}
        </strong>,
      );
    } else if (tok.startsWith("`")) {
      parts.push(
        <code
          key={key++}
          className="rounded bg-[var(--kin-fill-strong)] px-1 py-0.5 text-[12px] sm:text-[12.5px] font-mono text-kin-blue"
        >
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (
      (tok.startsWith("*") && tok.endsWith("*")) ||
      (tok.startsWith("_") && tok.endsWith("_"))
    ) {
      parts.push(
        <em key={key++} className="italic text-kin-secondary">
          {tok.slice(1, -1)}
        </em>,
      );
    } else {
      parts.push(tok);
    }
    last = m.index + tok.length;
  }
  if (last < s.length) parts.push(s.slice(last));
  return parts;
}
