import type { ReactNode } from "react";
import { IconChevron } from "../icons";

/**
 * The phone's nav bar.
 *
 * Three columns — 44px of leading control, a title that takes the rest, 44px
 * of trailing control — because that is what keeps a centred title actually
 * centred: a plain flex row shifts it left or right by however much the two
 * control clusters differ in width, which is what every screen with one extra
 * trailing button used to do.
 *
 * The bar is glass and it owns the top safe-area inset. Exactly one element on
 * a phone may own that inset, or the notch is spent twice (a title pushed down
 * the screen) or not at all (a title under the sensor housing). A page that
 * draws its own header therefore renders this component rather than a bare
 * `<header>`; the shell leaves the inset to it.
 */
export type MobileHeaderProps = {
  leading?: ReactNode;
  title?: ReactNode;
  trailing?: ReactNode;
  /** A second, smaller line under the title (a machine name, a status). */
  subtitle?: ReactNode;
  /** The bar's own bottom hairline. Off when it floats over a canvas. */
  bordered?: boolean;
  /**
   * Whether the bar's title is *the* page heading. False on routes whose page
   * already renders its own `<h1>` (a project's name, a session's title) —
   * the bar then shows a plain span, so the screen keeps exactly one heading.
   */
  heading?: boolean;
  className?: string;
};

export default function MobileHeader({
  leading,
  title,
  trailing,
  subtitle,
  bordered = true,
  heading = true,
  className = "",
}: MobileHeaderProps) {
  const titleClass = "truncate text-subtitle font-semibold leading-5";
  return (
    <header
      className={[
        "md:hidden flex-none kin-glass relative z-30 pt-safe kin-zen-hide",
        bordered ? "border-b border-[var(--kin-hairline)]" : "",
        className,
      ].join(" ")}
    >
      <div className="grid min-h-12 grid-cols-[2.75rem_minmax(0,1fr)_auto] items-center gap-1 px-2">
        <div className="flex items-center justify-start">{leading}</div>
        <div className="min-w-0 text-center">
          {typeof title === "string" ? (
            heading ? (
              <h1 className={titleClass}>{title}</h1>
            ) : (
              <span className={titleClass}>{title}</span>
            )
          ) : (
            title
          )}
          {subtitle ? (
            <div className="truncate text-caption leading-4 text-kin-muted">{subtitle}</div>
          ) : null}
        </div>
        <div className="flex items-center justify-end gap-0.5">{trailing}</div>
      </div>
    </header>
  );
}

/**
 * One 44pt square control in a header. `accent` is for the one action that
 * moves the screen forward (back, close, new); `muted` is for the rest.
 *
 * The negative margins are deliberate: the button's hit box is 44px, but the
 * glyph should sit on the bar's own gutter, not 12px inside it.
 */
export function MobileHeaderButton({
  label,
  onClick,
  children,
  tone = "accent",
  className = "",
}: {
  label: string;
  onClick?: () => void;
  children: ReactNode;
  tone?: "accent" | "muted";
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={[
        "inline-flex h-11 w-11 items-center justify-center rounded-full transition-colors active:bg-[var(--kin-fill)]",
        tone === "accent" ? "text-kin-blue-ink" : "text-kin-muted",
        className,
      ].join(" ")}
    >
      {children}
    </button>
  );
}

/** The trailing chevron a drill-in row carries. Exported so rows and headers
 * agree on its size. */
export function MobileChevron() {
  return <IconChevron size={14} className="shrink-0 text-kin-muted" />;
}

/**
 * The phone's identity mark — the one drawer trigger on every screen.
 *
 * The sessions bar leads with it and so does every other bar, because a
 * drawer opened from a K disc and one opened from a hamburger are the same
 * drawer, and two shapes for one destination is how a person stops
 * recognising the entrance. The inverted fill is the mark's own: the disc
 * carries the brand letter, not a copy of the K tile the sidebar uses.
 */
export function IdentityDisc() {
  return (
    <span className="flex h-9 w-9 items-center justify-center rounded-full bg-kin-text text-strong font-bold text-kin-bg">
      K
    </span>
  );
}
