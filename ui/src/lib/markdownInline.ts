/**
 * The inline markdown seam both surfaces run (KIN-MOBILE-002 R4b).
 *
 * `Markdown.tsx` used to tokenise inline runs inside its own `inline()`; the
 * tokenizer moved here so the phone draws the same runs instead of carrying a
 * second parse (ADR 0036 §5; `markdownBlocks.ts` did the same for blocks).
 * DOM-free, so React Native can import it by relative path. A link whose href
 * is unsafe keeps its label and loses its href: the web still draws its span,
 * and the phone draws a plain label.
 */

export type InlineToken = {
  kind: "text" | "strong" | "em" | "code" | "link";
  /** The run's text, markers removed. A link's value is its label. */
  value: string;
  /** Present only on a link whose href passed `isSafeHref`. */
  href?: string;
};

const INLINE_RE = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*]+\*|_[^_]+_|\[[^\]]+\]\([^)]+\))/g;

/**
 * The href spellings the console will draw as a link. Everything else
 * (`javascript:`, `data:`, a bare scheme) degrades to its label.
 */
export function isSafeHref(href: string): boolean {
  return /^(https?:|mailto:|\/|#)/i.test(href) || href.startsWith("./") || href.startsWith("../");
}

/** One source string as inline tokens, in source order. */
export function inlineTokens(s: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  const re = new RegExp(INLINE_RE.source, "g");
  while ((m = re.exec(s))) {
    if (m.index > last) tokens.push({ kind: "text", value: s.slice(last, m.index) });
    const tok = m[0];
    if (tok.startsWith("[") && tok.includes("](")) {
      const lm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
      if (lm) {
        const href = lm[2]!;
        tokens.push(
          isSafeHref(href)
            ? { kind: "link", value: lm[1]!, href }
            : { kind: "link", value: lm[1]! },
        );
      } else {
        tokens.push({ kind: "text", value: tok });
      }
    } else if (tok.startsWith("**") || tok.startsWith("__")) {
      tokens.push({ kind: "strong", value: tok.slice(2, -2) });
    } else if (tok.startsWith("`")) {
      tokens.push({ kind: "code", value: tok.slice(1, -1) });
    } else if (
      (tok.startsWith("*") && tok.endsWith("*")) ||
      (tok.startsWith("_") && tok.endsWith("_"))
    ) {
      tokens.push({ kind: "em", value: tok.slice(1, -1) });
    } else {
      tokens.push({ kind: "text", value: tok });
    }
    last = m.index + tok.length;
  }
  if (last < s.length) tokens.push({ kind: "text", value: s.slice(last) });
  return tokens;
}
