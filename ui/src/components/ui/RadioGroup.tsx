import { useRef, type KeyboardEvent } from "react";

export type RadioOption<T extends string | number> = {
  value: T;
  label: string;
  disabled?: boolean;
};

export type RadioGroupProps<T extends string | number> = {
  value: T;
  onChange: (next: T) => void;
  options: readonly RadioOption<T>[];
  /** The group's accessible name; callers pass a translated string. */
  ariaLabel: string;
  className?: string;
};

const GROUP_CLASS = "flex min-h-11 items-stretch rounded-xl bg-kin-elevated p-1";

const OPTION_CLASS =
  "min-h-11 rounded-lg px-3 text-body focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kin-focus-ring disabled:cursor-not-allowed disabled:opacity-60";

/**
 * A segmented single choice: three to five mutually exclusive options in one
 * row (TASTE 5), with radio semantics and one tab stop.
 *
 * Kin owns the contract — controlled `value`, arrow keys that move the
 * selection *and* the focus with wrap-around, Home/End, disabled options
 * skipped, one Tab stop — and the caller owns the words and the layout. This
 * is not a tab strip: `role="radio"` / `aria-checked` are the point, which is
 * exactly what `Tabs` cannot carry, and it is not an overlay (TASTE 16).
 */
export default function RadioGroup<T extends string | number>({
  value,
  onChange,
  options,
  ariaLabel,
  className,
}: RadioGroupProps<T>) {
  const buttons = useRef(new Map<T, HTMLButtonElement | null>());

  // The checked option is the tab stop; an unknown or disabled `value` hands
  // the single stop to the first enabled option instead.
  const checked = options.find((option) => option.value === value && !option.disabled);
  const stop = checked ?? options.find((option) => !option.disabled);

  const focusOption = (next: T) => {
    window.requestAnimationFrame(() => buttons.current.get(next)?.focus());
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const key = event.key;
    const isArrow =
      key === "ArrowRight" || key === "ArrowDown" || key === "ArrowLeft" || key === "ArrowUp";
    const isEdge = key === "Home" || key === "End";
    if (!isArrow && !isEdge) return;

    // The focused button is where the reader is; fall back to the checked one
    // if the event came from anywhere else (there is no other focusable node).
    const target = event.target instanceof HTMLElement ? event.target : null;
    let currentIndex = options.findIndex((option) => buttons.current.get(option.value) === target);
    if (currentIndex === -1) {
      currentIndex = options.findIndex((option) => option.value === value);
    }

    let nextIndex: number | null = null;
    if (isEdge) {
      const enabled = options
        .map((option, index) => ({ option, index }))
        .filter(({ option }) => !option.disabled);
      const found = key === "Home" ? enabled[0] : enabled[enabled.length - 1];
      nextIndex = found ? found.index : null;
    } else {
      const direction = key === "ArrowRight" || key === "ArrowDown" ? 1 : -1;
      const from = currentIndex >= 0 ? currentIndex : 0;
      for (let step = 1; step <= options.length; step += 1) {
        const index =
          (((from + direction * step) % options.length) + options.length) % options.length;
        if (!options[index]?.disabled) {
          nextIndex = index;
          break;
        }
      }
    }

    const next = nextIndex === null ? undefined : options[nextIndex];
    if (!next) return;
    if (next.value !== value) onChange(next.value);
    focusOption(next.value);
    event.preventDefault();
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={[GROUP_CLASS, className].filter(Boolean).join(" ")}
      onKeyDown={handleKeyDown}
    >
      {options.map((option) => {
        const isChecked = option.value === value && !option.disabled;
        return (
          <button
            key={String(option.value)}
            ref={(node) => {
              buttons.current.set(option.value, node);
            }}
            type="button"
            role="radio"
            aria-checked={isChecked}
            aria-disabled={option.disabled ? "true" : undefined}
            disabled={option.disabled}
            tabIndex={stop !== undefined && option.value === stop.value ? 0 : -1}
            onClick={() => {
              if (!option.disabled) onChange(option.value);
            }}
            className={[
              OPTION_CLASS,
              isChecked
                ? "bg-kin-elevated font-semibold text-kin-text shadow-e1"
                : option.disabled
                  ? "text-kin-muted"
                  : "text-kin-muted hover:text-kin-text",
            ].join(" ")}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
