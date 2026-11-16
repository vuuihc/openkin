import {
  forwardRef,
  useId,
  type ChangeEvent,
  type ComponentProps,
  type KeyboardEvent,
  type KeyboardEventHandler,
  type Ref,
} from "react";
import { TextArea as AstryxTextArea } from "@astryxdesign/core";
import { isImeKeyEvent } from "../../lib/ime";
import type { TextInputProps } from "./TextInput";

export type TextareaProps = Omit<TextInputProps, "type" | "ref" | "onChange" | "onKeyDown"> & {
  onChange: (value: string, event: ChangeEvent<HTMLTextAreaElement>) => void;
  /** The caller's own key handling; the Shift+Enter guard runs after it. */
  onKeyDown?: KeyboardEventHandler<HTMLTextAreaElement>;
  rows?: number;
  /** Fires on Shift+Enter, except while an IME composition owns the key. */
  onEnter?: () => void;
  ref?: Ref<HTMLTextAreaElement>;
};

/**
 * The console's multi-line field, behind the Kin API.
 *
 * Enter is the user's newline here, so the send-style action belongs to
 * Shift+Enter. The handler deliberately does not call `preventDefault`: the
 * browser inserts the newline and the caller gets its action, which is the
 * behaviour a chat composer needs. Like `TextInput`, the hint and the error are
 * rendered once, with ids the control points at, and an error sets
 * `aria-invalid`.
 */
const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  {
    label,
    hint,
    error,
    value,
    onChange,
    onEnter,
    rows,
    id,
    className,
    disabled,
    readOnly,
    required,
    onKeyDown,
    "aria-describedby": ariaDescribedBy,
    "aria-invalid": ariaInvalid,
    ...rest
  },
  ref,
) {
  const generatedId = useId();
  const textareaId = id ?? generatedId;
  const hintId = hint ? `${textareaId}-hint` : undefined;
  const errorId = error ? `${textareaId}-error` : undefined;
  const describedBy = [ariaDescribedBy, hintId, errorId].filter(Boolean).join(" ") || undefined;

  function handleChange(next: string, event: ChangeEvent<HTMLTextAreaElement>) {
    onChange(next, event);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    onKeyDown?.(event);
    if (event.key !== "Enter" || !event.shiftKey) return;
    if (isImeKeyEvent(event.nativeEvent)) return;
    onEnter?.();
  }

  return (
    <>
      <AstryxTextArea
        ref={ref}
        id={textareaId}
        label={label}
        value={value}
        onChange={handleChange}
        rows={rows}
        isRequired={required}
        isDisabled={disabled}
        isReadOnly={readOnly}
        required={required}
        disabled={disabled}
        readOnly={readOnly}
        aria-describedby={describedBy}
        aria-invalid={error ? true : ariaInvalid}
        onKeyDown={handleKeyDown}
        className={className}
        // See `TextInput`: native attributes cross the Astryx boundary here.
        {...(rest as ComponentProps<typeof AstryxTextArea>)}
      />
      {hint ? (
        <p id={hintId} className="text-caption text-kin-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-caption text-kin-red-ink">
          {error}
        </p>
      ) : null}
    </>
  );
});

export default Textarea;
