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
 * `className` is for the panel's own layout (the three panels are flex columns
 * and say so); it is not for position, which is the point of the container.
 */
export default function PanelSurface({
  label,
  className,
  children,
}: {
  /** Accessible name — the panel's own title, already translated. */
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={["absolute inset-0 z-40 bg-[var(--kin-inspector)] safe-pad", className ?? ""]
        .join(" ")
        .trim()}
      role="complementary"
      aria-label={label}
    >
      {children}
    </div>
  );
}
