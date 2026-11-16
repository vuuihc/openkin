import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Button as AstryxButton } from "@astryxdesign/core";

export type ButtonVariant = "default" | "secondary" | "quiet";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /**
   * The console's three action weights, all built on the existing `.kin-btn-*`
   * vocabulary:
   *  - `default` is the one filled action on a surface (send, publish);
   *  - `secondary` is a bordered peer (cancel, stop);
   *  - `quiet` is an icon-or-text affordance that sits inside a row or field
   *    (attach, filter) and takes a fill only on hover.
   */
  variant?: ButtonVariant;
  /**
   * Astryx's busy state: the control keeps its accessible name, exposes
   * `aria-busy`, and the implementation owns the visible progress affordance.
   * Kin does not draw its own spinner on top of it.
   */
  isLoading?: boolean;
};

const VARIANT: Record<ButtonVariant, string> = {
  default: "kin-btn-primary",
  secondary: "kin-btn-secondary",
  quiet: "bg-transparent text-kin-text hover:bg-[var(--kin-fill)]",
};

/**
 * The console's action button, as a facade over Astryx's `Button`.
 *
 * The stylesheet's `.kin-btn-*` classes still own the shape and the touch floor
 * (44px under the `.touch-lg` breakpoint), and the focus token is drawn outside
 * the fill so a primary button's ring is not invisible against its own blue.
 * Astryx supplies the behaviour behind that surface — the accessible name, the
 * loading state, press handling — while the Kin classes stay on the element and
 * win the cascade, because `components`/`utilities` are declared after
 * `astryx-base`/`astryx-theme` in `index.css`.
 *
 * The React contract Q3a established is unchanged: a forwarded ref for the
 * popover anchor, `type="button"` by default so a control inside a form does
 * not submit it by accident, and one variant prop instead of each call site
 * assembling the class string again.
 *
 * Astryx needs a string accessible name even when the caller names the button
 * with visible text; derive it from `aria-label` first, then from string
 * children, and keep passing `children` so existing call sites render exactly
 * what they did before. `isDisabled` alone only sets `aria-disabled`, so the
 * native `disabled` attribute travels with it: the platform's own disabled
 * state is what the existing contract and native form semantics require.
 */
const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "default",
    className,
    type = "button",
    children,
    disabled,
    isLoading,
    "aria-label": ariaLabel,
    ...rest
  },
  ref,
) {
  const label =
    typeof ariaLabel === "string" ? ariaLabel : typeof children === "string" ? children : "";

  return (
    <AstryxButton
      ref={ref}
      type={type}
      label={label}
      aria-label={ariaLabel}
      isDisabled={disabled}
      isLoading={isLoading}
      disabled={disabled}
      aria-busy={isLoading ? true : undefined}
      className={[
        "kin-btn",
        // The floor the stylesheet already draws; stated here too so the touch
        // target travels with the component rather than only with the
        // stylesheet a caller might replace.
        "min-h-11 sm:min-h-0",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
        "focus-visible:outline-kin-focus-ring",
        "disabled:cursor-not-allowed disabled:opacity-60",
        VARIANT[variant],
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      {children}
    </AstryxButton>
  );
});

export default Button;
