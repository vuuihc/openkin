import type { ReactNode } from "react";

/**
 * The one full-bleed session surface.
 *
 * Every panel used to carry its own copy of this markup — the same
 * `absolute inset-0 z-40`, the same background, the same `safe-pad` — which is
 * how five surfaces ended up at one z-index with no single answer to "which one
 * is on top". The skin lives here now; a panel renders its content and nothing
 * about where that content sits.
 *
 * `className` is for the panel's own layout (the panels are flex columns and say
 * so); it is not for position, which is the point of the container.
 */
export default function PanelSurface({
  label,
  className,
  hidden = false,
  children,
}: {
  /** Accessible name — the panel's own title, already translated. */
  label: string;
  className?: string;
  /**
   * Mounted, but not shown.
   *
   * The terminal needs this and the others do not: it holds a live PTY, so it
   * stays mounted once opened and is hidden rather than unmounted when it
   * closes. `display: none` already takes it out of the accessibility tree, and
   * the attribute says so out loud rather than leaving it to a class name.
   */
  hidden?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={[
        "absolute inset-0 z-40 bg-[var(--kin-inspector)] safe-pad",
        hidden ? "hidden" : "",
        className ?? "",
      ]
        .join(" ")
        .trim()}
      role="complementary"
      aria-label={label}
      aria-hidden={hidden ? true : undefined}
    >
      {children}
    </div>
  );
}
