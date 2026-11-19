import { useEffect, type ReactNode } from "react";
import { addPanel, removePanel, type PanelShape } from "../../lib/panelPresence";

/**
 * How a panel takes its space, declared with the presence store that publishes
 * it. See the component below.
 *
 * - `overlay` — full-bleed over the conversation area, for widths where a
 *   column would push the conversation under its floor (below `lg`).
 * - `column` — the review column beside the conversation from `lg` up, and the
 *   overlay below it, because 768px minus the rail, the list and 380px leaves
 *   a conversation narrower than it can read.
 */
export type { PanelShape };

/**
 * The one session surface.
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
  shape = "overlay",
  children,
}: {
  /** Accessible name — the panel's own title, already translated. */
  label: string;
  className?: string;
  /**
   * The width the panel takes, not the panel's own business: a panel that
   * painted itself beside the conversation would be the second skin this
   * container exists to prevent. Defaults to the overlay, so a panel says
   * nothing until it asks.
   */
  shape?: PanelShape;
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
  // A visible panel is the screen's topmost surface, and the floating approval
  // reads this to keep its strip instead of painting its card over the panel
  // body. Keyed on `hidden` so closing a panel releases the screen the same
  // way unmounting it does: the terminal closes by hiding, not by unmounting.
  useEffect(() => {
    if (hidden) return;
    addPanel(shape);
    return () => removePanel(shape);
  }, [hidden, shape]);

  return (
    <div
      className={[
        "absolute inset-0 z-40 bg-[var(--kin-inspector)] safe-pad panel-top-inset kin-zen-hide",
        // `lg:` overrides, not a second base skin: below the breakpoint the
        // panel stays the full-bleed overlay it has always been. `relative` in
        // a flex row is what puts it beside the conversation instead of over
        // it; `inset-auto` and `z-auto` undo the overlay's anchoring and its
        // z-index so it is an ordinary in-flow column.
        shape === "column"
          ? "lg:relative lg:inset-auto lg:z-auto lg:flex-none lg:w-[380px] lg:border-l lg:border-[var(--kin-hairline)]"
          : "",
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
