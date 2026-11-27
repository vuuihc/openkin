import { memo, type ReactNode } from "react";
import { splitBlocks } from "../lib/markdownBlocks";
import { inlineTokens } from "../lib/markdownInline";
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

/**
 * A token's element: exactly the JSX this file drew before the tokenizer
 * moved to `lib/markdownInline.ts`. The classes are the console's contract —
 * `Markdown.inline.dom.test.tsx` pins them.
 */
function inline(s: string): ReactNode[] {
  return inlineTokens(s).map((token, i) => {
    switch (token.kind) {
      case "strong":
        return (
          <strong key={i} className="font-semibold text-kin-text">
            {token.value}
          </strong>
        );
      case "em":
        return (
          <em key={i} className="italic text-kin-secondary">
            {token.value}
          </em>
        );
      case "code":
        return (
          <code
            key={i}
            className="rounded bg-[var(--kin-fill-strong)] px-1 py-0.5 text-body font-mono text-kin-blue-ink"
          >
            {token.value}
          </code>
        );
      case "link": {
        const href = token.href;
        if (href === undefined) {
          // An unsafe href degrades to its label, in the span it always had.
          return <span key={i}>{token.value}</span>;
        }
        return (
          <a
            key={i}
            href={href}
            target={href.startsWith("http") ? "_blank" : undefined}
            rel={href.startsWith("http") ? "noreferrer noopener" : undefined}
            className="text-kin-blue-ink underline decoration-kin-blue/40 underline-offset-2 hover:decoration-kin-blue"
          >
            {token.value}
          </a>
        );
      }
      default:
        return token.value;
    }
  });
}

export default memo(MarkdownImpl);
