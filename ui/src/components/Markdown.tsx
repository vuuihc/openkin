import { memo, type ReactNode } from "react";
import { splitBlocks } from "../lib/markdownBlocks";
import CodeBlock from "./CodeBlock";
import MermaidBlock from "./MermaidBlock";

/**
 * Lightweight markdown renderer (no extra deps beyond optional Mermaid, and the
 * code highlighter behind `CodeBlock`'s own lazy chunk).
 * Supports: headings, fenced code, mermaid diagrams, paragraphs, lists,
 * blockquotes, hr, GFM tables, links, bold, italic, inline code.
 */
function MarkdownImpl({ text, className = "" }: { text: string; className?: string }) {
  if (!text) return null;
  const blocks = splitBlocks(text);
  return (
    <div
      className={[
        "kin-md space-y-2.5 text-strong sm:text-subtitle text-kin-text leading-prose break-words",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {blocks.map((b, i) => {
        if (b.type === "code") {
          if (isMermaidLang(b.lang)) {
            return <MermaidBlock key={i} code={b.value} />;
          }
          return <CodeBlock key={i} code={b.value} lang={b.lang} />;
        }
        if (b.type === "h1" || b.type === "h2" || b.type === "h3") {
          const Tag = b.type;
          const size =
            b.type === "h1"
              ? "text-subtitle sm:text-title font-semibold mt-1"
              : b.type === "h2"
                ? "text-subtitle font-semibold mt-0.5"
                : "text-strong sm:text-subtitle font-semibold";
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
          return <hr key={i} className="border-0 border-t border-[var(--kin-hairline)] my-1" />;
        }
        if (b.type === "table") {
          return (
            <div key={i} className="overflow-x-auto rounded-lg border border-[var(--kin-hairline)]">
              {/* Natural width, not `w-full`: the wrapper scrolls, and a table
                  squeezed to the prose measure wrapped its first column one
                  character per line. */}
              <table className="min-w-max border-collapse text-left text-strong">
                <thead className="bg-[var(--kin-fill)]">
                  <tr>
                    {b.header.map((cell, j) => (
                      <th
                        key={j}
                        data-kin-reading=""
                        className="border-b border-[var(--kin-hairline)] px-3 py-2 font-semibold text-kin-text align-top"
                      >
                        {inline(cell)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {b.rows.map((row, ri) => (
                    <tr key={ri} className="odd:bg-transparent even:bg-[var(--kin-fill)]">
                      {row.map((cell, ci) => (
                        <td
                          key={ci}
                          data-kin-reading=""
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

function isMermaidLang(lang?: string): boolean {
  if (!lang) return false;
  const l = lang.trim().toLowerCase();
  // Common aliases used by docs / GitHub / Obsidian.
  return l === "mermaid" || l === "mmd" || l.startsWith("mermaid ") || l.startsWith("mermaid{");
}

const INLINE_RE = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*]+\*|_[^_]+_|\[[^\]]+\]\([^)]+\))/g;

function inline(s: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  const re = new RegExp(INLINE_RE.source, "g");
  while ((m = re.exec(s))) {
    if (m.index > last) parts.push(s.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("[") && tok.includes("](")) {
      const lm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
      if (lm) {
        const href = lm[2];
        const safe =
          /^(https?:|mailto:|\/|#)/i.test(href) || href.startsWith("./") || href.startsWith("../");
        if (safe) {
          parts.push(
            <a
              key={key++}
              href={href}
              target={href.startsWith("http") ? "_blank" : undefined}
              rel={href.startsWith("http") ? "noreferrer noopener" : undefined}
              className="text-kin-blue-ink underline decoration-kin-blue/40 underline-offset-2 hover:decoration-kin-blue"
            >
              {lm[1]}
            </a>,
          );
        } else {
          parts.push(<span key={key++}>{lm[1]}</span>);
        }
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
          className="rounded bg-[var(--kin-fill-strong)] px-1 py-0.5 text-body font-mono text-kin-blue-ink"
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

export default memo(MarkdownImpl);
