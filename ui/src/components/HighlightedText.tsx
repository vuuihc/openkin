import { splitMatches } from "../lib/highlightMatch";

/**
 * `text` with every case-insensitive occurrence of `query` marked.
 *
 * `<mark>` rather than a styled span: it is the element the browser already
 * gives a highlight colour and the semantics of "this is why the row is here",
 * and a screen reader announces it as marked text. Styling it with the
 * console's own tint keeps one visual language — the default yellow would be
 * the only yellow in the product.
 *
 * Returned as a fragment of inline nodes so a parent's `truncate` still cuts
 * the title to one line.
 */
export default function HighlightedText({ text, query }: { text: string; query: string }) {
  const parts = splitMatches(text, query);
  if (parts.length === 1 && !parts[0].match) return <>{text}</>;
  return (
    <>
      {parts.map((part, index) =>
        part.match ? (
          <mark
            key={index}
            className="rounded-sm bg-kin-blue/25 px-0 text-inherit"
          >
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}
