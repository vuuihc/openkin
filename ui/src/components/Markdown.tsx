import type { ReactNode } from "react";

/**
 * Minimal markdown renderer (no extra deps). Handles paragraphs, fenced code,
 * inline code, bold, and headings.
 */
export default function Markdown({ text }: { text: string }) {
  if (!text) return null;
  const blocks = splitBlocks(text);
  return (
    <div className="space-y-2 text-sm text-zinc-200 leading-relaxed">
      {blocks.map((b, i) => {
        if (b.type === "code") {
          return (
            <pre
              key={i}
              className="overflow-x-auto rounded-lg bg-black/40 border border-surface-border p-3 text-xs font-mono text-zinc-300"
            >
              <code>{b.value}</code>
            </pre>
          );
        }
        if (b.type === "h1" || b.type === "h2" || b.type === "h3") {
          const Tag = b.type;
          const size =
            b.type === "h1" ? "text-base font-semibold" : "text-sm font-semibold";
          return (
            <Tag key={i} className={`${size} text-zinc-100`}>
              {inline(b.value)}
            </Tag>
          );
        }
        return (
          <p key={i} className="whitespace-pre-wrap">
            {inline(b.value)}
          </p>
        );
      })}
    </div>
  );
}

type Block =
  | { type: "p" | "h1" | "h2" | "h3"; value: string }
  | { type: "code"; value: string };

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
      i++;
      const code: string[] = [];
      while (i < lines.length && !lines[i].startsWith("```")) {
        code.push(lines[i]);
        i++;
      }
      out.push({ type: "code", value: code.join("\n") });
      i++; // closing fence
      continue;
    }
    if (line.startsWith("### ")) {
      flush();
      out.push({ type: "h3", value: line.slice(4) });
      i++;
      continue;
    }
    if (line.startsWith("## ")) {
      flush();
      out.push({ type: "h2", value: line.slice(3) });
      i++;
      continue;
    }
    if (line.startsWith("# ")) {
      flush();
      out.push({ type: "h1", value: line.slice(2) });
      i++;
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

function inline(s: string): ReactNode[] {
  // bold **x** and `code`
  const parts: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) parts.push(s.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) {
      parts.push(
        <strong key={key++} className="font-semibold text-zinc-50">
          {tok.slice(2, -2)}
        </strong>,
      );
    } else {
      parts.push(
        <code
          key={key++}
          className="rounded bg-black/40 px-1 py-0.5 text-xs font-mono text-accent"
        >
          {tok.slice(1, -1)}
        </code>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < s.length) parts.push(s.slice(last));
  return parts;
}
