import {
  forwardRef,
  useId,
  type ChangeEvent,
  type ComponentProps,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type Ref,
} from "react";
import { TextInput as AstryxTextInput } from "@astryxdesign/core";
import { isImeKeyEvent } from "../../lib/ime";

/**
 * Everything a native input accepts, except the props this facade owns or
 * narrows. `size` is left out deliberately: control sizing belongs to Astryx's
 * theme, and the native numeric `size` is not part of this API.
 */
type NativeInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange" | "type" | "id" | "className" | "size" | "children"
>;

export type TextInputProps = NativeInputProps & {
  /** The visible label, and the control's accessible name. */
  label: string;
  /** Always-visible guidance; part of the control's description. */
  hint?: string;
  /** When set, marks the control invalid and becomes part of the description. */
  error?: string;
  value: string;
  onChange: (value: string, event: ChangeEvent<HTMLInputElement>) => void;
  /** Fires on Enter, except while an IME composition owns the key. */
  onEnter?: () => void;
  type?: "text" | "password" | "email" | "search" | "tel" | "url";
  id?: string;
  className?: string;
  ref?: Ref<HTMLInputElement>;
};

/**
 * The console's single-line field, behind the Kin API.
 *
 * Astryx renders the input, its label and its default surface; Kin owns the
 * description contract. The hint and the error are rendered here, with ids the
 * control points at through `aria-describedby`, so there is exactly one
 * description layer and it survives whatever Astryx does with its own
 * `description` slot. An error also sets `aria-invalid`, which is the part a
 * screen reader needs and a red border alone does not provide.
 *
 * `onEnter` is a convenience for the call sites that treat Enter as "go" (a
 * search box, an inline rename). It uses the console's shared
 * `isImeKeyEvent`, which reads both `isComposing` and the 229 sentinel; reading
 * either alone would fire on the last keystroke of a Chinese word.
 */
const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  {
    label,
    hint,
    error,
    value,
    onChange,
    onEnter,
    type = "text",
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
  const inputId = id ?? generatedId;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [ariaDescribedBy, hintId, errorId].filter(Boolean).join(" ") || undefined;

  function handleChange(next: string, event: ChangeEvent<HTMLInputElement>) {
    onChange(next, event);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    onKeyDown?.(event);
    if (event.key !== "Enter") return;
    if (isImeKeyEvent(event.nativeEvent)) return;
    onEnter?.();
  }

  return (
    <>
      <AstryxTextInput
        ref={ref}
        id={inputId}
        label={label}
        value={value}
        onChange={handleChange}
        type={type}
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
        // The facade advertises the native input attributes; Astryx decides
        // which of them its input renders. The cast is the external boundary,
        // not a way to smuggle a prop the facade promises.
        {...(rest as ComponentProps<typeof AstryxTextInput>)}
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

export default TextInput;
