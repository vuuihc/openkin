import { forwardRef, type ButtonHTMLAttributes } from "react";

export type ButtonVariant = "default" | "secondary" | "quiet";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /**
   * The console's three action weights, all built on the existing `.kin-btn`
   * vocabulary:
   *  - `default` is the one filled action on a surface (send, publish);
   *  - `secondary` is a bordered peer (cancel, stop);
   *  - `quiet` is an icon-or-text affordance that sits inside a row or field
   *    (attach, filter) and takes a fill only on hover.
   */
  variant?: ButtonVariant;
};

const VARIANT: Record<ButtonVariant, string> = {
  default: "kin-btn-primary",
  secondary: "kin-btn-secondary",
  quiet: "bg-transparent text-kin-text hover:bg-[var(--kin-fill)]",
};

/**
 * The console's action button, as a native `<button>`.
 *
 * `.kin-btn` already owns the shape and the touch floor (44px under the
 * `.touch-lg` breakpoint), and the focus token is drawn outside the fill so a
 * primary button's ring is not invisible against its own blue. What this
 * component adds is the React contract the next Composer migration needs: a
 * forwarded ref for the popover anchor, `type="button"` by default so a
 * control inside a form does not submit it by accident, and one variant prop
 * instead of each call site assembling the class string again.
 *
 * Deliberately not owned: loading/disabled labels, icon slots, sizes beyond
 * the existing floor, confirmation flows. A caller passes those through the
 * native props or composes the content itself.
 */
const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "default", className, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={[
        "kin-btn",
        // The floor `.kin-btn` already draws; stated here too so the touch
        // target travels with the component rather than only with the
        // stylesheet a caller might replace.
        "min-h-11 sm:min-h-0",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
        "focus-visible:outline-[var(--kin-focus-ring)]",
        "disabled:cursor-not-allowed disabled:opacity-60",
        VARIANT[variant],
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    />
  );
});

export default Button;
