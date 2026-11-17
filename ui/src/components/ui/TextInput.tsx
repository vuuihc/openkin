import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from "react";

/**
 * A text field's status message: one sentence and the weight it carries.
 * `error` is invalid input and sets `aria-invalid`; `warning` is a caution the
 * value may still be submitted with.
 */
export type TextInputStatus = {
  type: "error" | "warning";
  message: string;
};

export type TextInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "className"> & {
  /** The visible label, and the control's accessible name. Required. */
  label: string;
  /** Keep the accessible name but hide the label visually (a row that names itself elsewhere). */
  isLabelHidden?: boolean;
  /**
   * One sentence under the input that explains the value. Rendered as the
   * input's `aria-describedby`, so a screen reader reads it as part of the
   * field instead of as an unrelated sibling.
   *
   * A node rather than a string because the provider base-URL hint keeps the
   * `/v1` fragment in `<code>`; strings are the common case.
   */
  hint?: ReactNode;
  /** Visible status message, also part of the input's description. */
  status?: TextInputStatus;
  /** Merged onto the native input after the shared input class and the 44px floor, never instead of them. */
  className?: string;
};

/**
 * The console's text field, and the one place a label, a hint and a status
 * message are wired to the input.
 *
 * Route: Kin's own markup, not a facade over Astryx's `TextInput`. Astryx's
 * field-composed inputs forbid a root `className`/`xstyle` at the type level
 * (`FieldInputForbiddenStyleProp`) and their `controlClassName` targets the
 * visual control box, "never the native input" — so the stylesheet's input
 * class cannot land on the element the ratchet counts. `Field` is no
 * better here: its label and description carry Astryx's typography, and its
 * status message is rendered by `FieldStatus`, not by the class contract this
 * console pins. The behaviour Astryx would have supplied — the label/input
 * association, the description wiring, the error state — is four lines of
 * native semantics below, so the facade composes them directly and leaves the
 * visual contract on the input where it has always been.
 *
 * `min-h-11` is stated here rather than in the stylesheet's base class because
 * compact rows still own their height (TASTE 11 sets the phone floor, not one
 * height for every row). Class-attribute order does not decide Tailwind's
 * cascade — `.min-h-11` is emitted after `.min-h-10`, so concatenating the
 * caller's class would silently lose. Instead the default floor is omitted when
 * the caller sets a height (`min-h-*`, `h-*`, `[min-height:…]`); a responsive
 * override such as `sm:min-h-0` keeps the phone floor and only changes the
 * desktop one.
 */
const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  {
    label,
    isLabelHidden = false,
    hint,
    status,
    className,
    id,
    type = "text",
    "aria-describedby": ariaDescribedBy,
    "aria-invalid": ariaInvalid,
    ...rest
  },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? `kin-text-input-${generatedId}`;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const statusId = status?.message ? `${inputId}-status` : undefined;
  const describedBy =
    [ariaDescribedBy, hintId, statusId].filter(Boolean).join(" ") || undefined;
  // An unqualified height utility replaces the default floor; a responsive one
  // does not, because the phone floor is the part that must not be forgotten.
  const callerOwnsHeight = className ? /(?:^|\s)(?:min-h-|h-|\[min-height:)/.test(className) : false;

  return (
    <div className={isLabelHidden ? undefined : "space-y-1"}>
      <label
        htmlFor={inputId}
        className={
          isLabelHidden ? "sr-only" : "block text-body leading-4 font-medium text-kin-secondary"
        }
      >
        {label}
      </label>
      <input
        {...rest}
        ref={ref}
        id={inputId}
        type={type}
        className={["kin-input", callerOwnsHeight ? undefined : "min-h-11", className]
          .filter(Boolean)
          .join(" ")}
        aria-describedby={describedBy}
        aria-invalid={status?.type === "error" ? true : ariaInvalid}
      />
      {hint ? (
        <span id={hintId} className="block text-caption text-kin-muted">
          {hint}
        </span>
      ) : null}
      {status?.message ? (
        <span
          id={statusId}
          className={
            status.type === "error"
              ? "block text-caption text-kin-red-ink"
              : "block text-caption text-kin-orange-ink"
          }
        >
          {status.message}
        </span>
      ) : null}
    </div>
  );
});

export default TextInput;
