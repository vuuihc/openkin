import { forwardRef, useId, type ReactNode, type TextareaHTMLAttributes } from "react";

/**
 * A text field's status message: one sentence and the weight it carries.
 * `error` is invalid input and sets `aria-invalid`; `warning` is a caution the
 * value may still be submitted with.
 */
export type TextAreaStatus = {
  type: "error" | "warning";
  message: string;
};

export type TextAreaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "className"> & {
  /** The visible label, and the control's accessible name. Required. */
  label: string;
  /** Keep the accessible name but hide the label visually (a row that names itself elsewhere). */
  isLabelHidden?: boolean;
  /**
   * One sentence under the field that explains the value. Rendered as the
   * textarea's `aria-describedby`, so a screen reader reads it as part of the
   * field instead of as an unrelated sibling.
   */
  hint?: ReactNode;
  /** Visible status message, also part of the textarea's description. */
  status?: TextAreaStatus;
  /** Merged onto the native textarea after the shared input class, never instead of it. */
  className?: string;
};

/**
 * The console's multi-line text field, and the one place a label, a hint and a
 * status message are wired to the textarea.
 *
 * A sibling of `TextInput` rather than a `multiline` prop on it: the two
 * native elements have different attribute sets (no `type`, but `rows` and a
 * resize corner) and different height models. A textarea's height is `rows`
 * plus the caller's class, so this component deliberately adds **no**
 * `min-h-11` floor — that floor is a single-line touch target, and forcing it
 * here would fight every multi-line row that sizes itself. Keeping them apart
 * also keeps `TextInput`'s height heuristic (drop the floor when the caller
 * owns a height) from having to reason about an element it does not render.
 *
 * The name/hint/status contract is the same as `TextInput`'s: `label` is
 * required, `isLabelHidden` only hides it visually, the caller's
 * `aria-describedby` comes first, then the hint and status ids, and an error
 * also sets `aria-invalid`. The stylesheet's input class stays on the native
 * textarea.
 */
const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  {
    label,
    isLabelHidden = false,
    hint,
    status,
    className,
    id,
    "aria-describedby": ariaDescribedBy,
    "aria-invalid": ariaInvalid,
    ...rest
  },
  ref,
) {
  const generatedId = useId();
  const fieldId = id ?? `kin-text-area-${generatedId}`;
  const hintId = hint ? `${fieldId}-hint` : undefined;
  const statusId = status?.message ? `${fieldId}-status` : undefined;
  const describedBy = [ariaDescribedBy, hintId, statusId].filter(Boolean).join(" ") || undefined;

  return (
    <div className={isLabelHidden ? undefined : "space-y-1"}>
      <label
        htmlFor={fieldId}
        className={
          isLabelHidden ? "sr-only" : "block text-body leading-4 font-medium text-kin-secondary"
        }
      >
        {label}
      </label>
      <textarea
        {...rest}
        ref={ref}
        id={fieldId}
        className={["kin-input", className].filter(Boolean).join(" ")}
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

export default TextArea;
