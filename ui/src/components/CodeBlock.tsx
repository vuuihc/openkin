import { useEffect, useMemo, useState } from "react";

type Highlighter = typeof import("./codeHighlight");

let highlighter: Promise<Highlighter> | null = null;

/**
 * The page's one grammar set, fetched the first time a fence asks for it.
 *
 * The same shape as `MermaidBlock`'s loader and for the same reason: the module
 * is a chunk of its own, so a session whose messages are prose never downloads
 * a tokenizer. See `codeHighlight.ts` for why a fence with a label we do not
 * know still loads it.
 */
function loadHighlighter(): Promise<Highlighter> {
  if (!highlighter) highlighter = import("./codeHighlight");
  return highlighter;
}

/**
 * A fenced code block: the label, the code, and the colours when there are any.
 *
 * Three states, and the markup is the same in all three — `pre` → `code` — so
 * the block does not reflow when the tokenizer arrives a frame later:
 *
 * - no label: plain, which is what an unlabelled fence has always been;
 * - a label, before the chunk lands: plain, briefly;
 * - a label with a grammar: tokenized, into `highlight`'s HTML.
 *
 * The plain path is React's own escaping of a text child, and the tokenized path
 * is a string this module has already held to one shape — see `highlight` on the
 * escaping contract.
 */
export default function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [loaded, setLoaded] = useState<Highlighter | null>(null);

  useEffect(() => {
    // Nothing to fetch for an unlabelled fence, and nothing to wait for once the
    // chunk has landed — the guard is also what keeps this from looping.
    if (!lang || loaded) return;
    let live = true;
    void loadHighlighter().then((module) => {
      if (live) setLoaded(module);
    });
    return () => {
      live = false;
    };
  }, [lang, loaded]);

  // Keyed on the code as well as the language because a streamed block is
  // re-rendered on every event: the transcript re-renders as a whole, and
  // re-tokenizing every fence in it per token of new output is the one way this
  // could be felt. React keeps this component mounted across those renders, so
  // the memo holds.
  const html = useMemo(() => (loaded ? loaded.highlight(code, lang) : null), [loaded, code, lang]);

  return (
    <pre className="kin-code overflow-x-auto rounded-lg bg-[var(--kin-fill)] border border-[var(--kin-hairline)] p-3 text-body font-mono text-kin-secondary">
      {lang ? (
        <div className="mb-1.5 text-micro font-semibold uppercase tracking-label text-kin-muted">
          {lang}
        </div>
      ) : null}
      {html ? (
        <code className="whitespace-pre" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <code className="whitespace-pre">{code}</code>
      )}
    </pre>
  );
}
