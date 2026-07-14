import { useState } from "react";

/**
 * Truncate long one-line text; full value via title tooltip, optional expand.
 */
export default function Truncated({
  text,
  className = "",
  expand = false,
}: {
  text: string;
  className?: string;
  /** When true, tap toggles full wrap instead of only relying on title. */
  expand?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!text) return null;

  if (expand) {
    return (
      <button
        type="button"
        title={text}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={[
          "text-left max-w-full",
          open ? "whitespace-pre-wrap break-all" : "truncate",
          className,
        ].join(" ")}
      >
        {text}
      </button>
    );
  }

  return (
    <span title={text} className={`truncate max-w-full ${className}`}>
      {text}
    </span>
  );
}
