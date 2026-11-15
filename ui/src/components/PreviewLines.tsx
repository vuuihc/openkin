import type { PreviewLine } from "../lib/diffPreview";

/**
 * A before/after pair drawn as lines: removals, additions, and the unchanged
 * lines around them.
 *
 * One renderer for both places a change is shown before it is real — the
 * approval card, where it is still a request, and the round evidence card, where
 * it is something the agent already did. They are the same question asked at
 * different times ("what would this change" / "what did this change"), so they
 * should not be able to drift apart in appearance.
 */
export default function PreviewLines({
  lines,
  className = "",
}: {
  lines: PreviewLine[];
  className?: string;
}) {
  if (lines.length === 0) return null;
  return (
    <div
      className={[
        "rounded-lg overflow-hidden border border-[var(--kin-hairline)] font-mono text-caption leading-prose",
        className,
      ].join(" ")}
    >
      {lines.map((line, index) => (
        <div
          key={index}
          className={
            line.type === "add"
              ? "px-2.5 py-0.5 bg-kin-green/10 text-kin-green-ink"
              : line.type === "del"
                ? "px-2.5 py-0.5 bg-kin-red/10 text-kin-red-ink"
                : "px-2.5 py-0.5 text-kin-secondary"
          }
        >
          {line.type === "add" ? "+ " : line.type === "del" ? "- " : "  "}
          <span className="whitespace-pre-wrap break-all">{line.text}</span>
        </div>
      ))}
    </div>
  );
}
