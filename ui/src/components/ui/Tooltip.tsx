import type { ReactElement, ReactNode } from "react";
import { Tooltip as AstryxTooltip } from "@astryxdesign/core";

export type TooltipProps = {
  /** What the tooltip says. It is the trigger's description, not its name. */
  content: ReactNode;
  /** The trigger. It must accept a ref so the tooltip can anchor and describe it. */
  children: ReactElement;
  placement?: "above" | "below";
  /** Milliseconds the pointer or focus must rest before the tooltip opens. */
  delay?: number;
  /** When true nothing renders and nothing is announced. */
  disabled?: boolean;
};

/**
 * Astryx's surface, narrowed to the props the console promises. The cast is
 * the external boundary: a caller reads this facade's type, not Astryx's.
 */
type AstryxTooltipProps = {
  content: ReactNode;
  children: ReactElement;
  placement?: "above" | "below";
  delay?: number;
  isEnabled?: boolean;
  /** Which focus opens it; `auto` accepts any focusable trigger. */
  focusTrigger?: "auto" | "always" | "never";
  /** What a tap does on a coarse pointer; `tap` opens it on any trigger. */
  touchTrigger?: "auto" | "tap" | "none";
};

const TooltipSurface = AstryxTooltip as unknown as (props: AstryxTooltipProps) => ReactElement;

/** Rest long enough that a mouse crossing the surface does not flash it. */
const DEFAULT_DELAY_MS = 400;

/**
 * The console's one tooltip, over Astryx `Tooltip`. It describes its trigger:
 * opens on hover and keyboard focus, closes on leave/blur/Escape, and the
 * trigger points at the content with `aria-describedby`. Astryx owns those
 * semantics and the portal; the facade owns the two placements, the delay and
 * the meaning of `disabled` — render nothing, not an empty bubble and not a
 * dangling description.
 *
 * It is not a dialog, menu or popover: no focus, no pointer events, no keyboard
 * ownership (TASTE 16). Interactive content belongs in `Popover` or `Menu`.
 */
export default function Tooltip({
  content,
  children,
  placement = "above",
  delay = DEFAULT_DELAY_MS,
  disabled = false,
}: TooltipProps) {
  if (disabled) return children;

  return (
    <TooltipSurface
      content={content}
      placement={placement}
      delay={delay}
      isEnabled
      focusTrigger="auto"
      touchTrigger="tap"
    >
      {children}
    </TooltipSurface>
  );
}
