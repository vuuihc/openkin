import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { isImeKeyEvent } from "../../lib/ime";
import { IconCheck } from "../icons";
import Popover from "./Popover";

/**
 * One row. `checked` turns the row into a choice (`menuitemradio`): defined
 * means "this row is a radio", so `checked: false` is the unchecked member of
 * a group, not a plain action.
 */
export type MenuItem = {
  id: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  /** Renders role="menuitemradio" with aria-checked when defined. */
  checked?: boolean;
  onSelect: () => void;
};

export type MenuProps = {
  /** Controlled: the caller owns the trigger's click and the open state. */
  open: boolean;
  /** Asked to close by Escape, an outside pointer or a chosen row. */
  onOpenChange: (open: boolean) => void;
  /** The caller's trigger element, borrowed for anchoring and focus return. */
  triggerRef: RefObject<HTMLElement | null>;
  /** Accessible name of the menu. The caller's visible label, not new text. */
  label: string;
  items: MenuItem[];
  /** Preferred side; the underlying layer flips it when that side has no room. */
  placement?: "above" | "below";
  /** Edge of the trigger the panel lines up with. */
  align?: "left" | "right";
};

/** How long a typeahead buffer survives between keystrokes. */
const TYPEAHEAD_MS = 500;

/**
 * A controlled menu: the rows, the keyboard and the selection contract every
 * picker shares, with none of the domain knowledge.
 *
 * The layer behavior is not re-implemented here. It sits on the `Popover`
 * primitive, which already owns the body portal, viewport anchoring, outside
 * pointer dismissal, focus moving in after measurement, focus returning to the
 * trigger, Tab containment, the IME guard, and exactly one layer closing per
 * Escape when popovers nest. That last part is why composing is the only safe
 * shape: a second document listener with its own registry would dismiss both
 * layers on one Escape and call a menu's portaled panel "outside" for the
 * popover that opened it.
 *
 * What this component adds is what a menu is: the menu role, roving focus over
 * enabled rows, arrow keys that move by one and wrap, Home/End, letter
 * typeahead, Enter/Space to choose, `menuitemradio` + `aria-checked` for
 * choices, and rows that are inert while disabled. Escape and Tab stay with
 * the layer below, which is also what makes `overlayOwnsKeyboard` true while
 * the menu is visible (TASTE rule 16).
 *
 * Rows are `role="menuitem"` elements with a roving `tabIndex`, not buttons:
 * the ARIA menu pattern is a listbox-like list of commands, and a menu is one
 * Tab stop, not one per row. Native button semantics would put every row in
 * the tab order and announce "button" for what is a command.
 */
export default function Menu({
  open,
  onOpenChange,
  triggerRef,
  label,
  items,
  placement = "below",
  align = "left",
}: MenuProps) {
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const [activeId, setActiveId] = useState<string | null>(null);
  // `window.setTimeout` rather than the bare global: the DOM one returns a
  // number, so the handle stays a number even in a tree that also loads
  // Node's timer types.
  const typed = useRef({ text: "", timer: undefined as number | undefined });

  const enabled = items.filter((item) => !item.disabled);
  // Roving focus is derived, not stored twice: a caller may add, disable or
  // reorder rows while the menu is open, and a remembered id that no longer
  // resolves falls back to the first row that can take focus.
  const active =
    activeId && enabled.some((item) => item.id === activeId)
      ? activeId
      : (enabled[0]?.id ?? null);

  useEffect(() => {
    if (open) return;
    // A reopened menu starts from the top again instead of resuming wherever
    // the last visit ended.
    setActiveId(null);
    typed.current.text = "";
    if (typed.current.timer) window.clearTimeout(typed.current.timer);
    typed.current.timer = undefined;
  }, [open]);

  useEffect(
    () => () => {
      if (typed.current.timer) window.clearTimeout(typed.current.timer);
    },
    [],
  );

  /** The row the reader is on, read from focus rather than from state. */
  const focusedId = (): string | null => {
    for (const [id, node] of rowRefs.current) {
      if (node === document.activeElement) return id;
    }
    return active;
  };

  const focusItem = (id: string | null | undefined) => {
    if (!id) return;
    setActiveId(id);
    rowRefs.current.get(id)?.focus({ preventScroll: true });
  };

  const move = (delta: 1 | -1) => {
    if (enabled.length === 0) return;
    const at = enabled.findIndex((item) => item.id === focusedId());
    const next =
      at === -1
        ? enabled[delta === 1 ? 0 : enabled.length - 1]
        : enabled[(at + delta + enabled.length) % enabled.length];
    focusItem(next.id);
  };

  /**
   * Letters typed in quick succession name a row. The search starts after the
   * current row and wraps, so repeating a letter steps through the rows that
   * share a prefix instead of sticking on the first one.
   */
  const typeahead = (char: string) => {
    typed.current.text += char.toLowerCase();
    if (typed.current.timer) window.clearTimeout(typed.current.timer);
    typed.current.timer = window.setTimeout(() => {
      typed.current.text = "";
      typed.current.timer = undefined;
    }, TYPEAHEAD_MS);

    const buffer = typed.current.text;
    const at = enabled.findIndex((item) => item.id === focusedId());
    const ordered = [...enabled.slice(at + 1), ...enabled.slice(0, at + 1)];
    const match = ordered.find((item) => item.label.toLowerCase().startsWith(buffer));
    if (match) focusItem(match.id);
  };

  const choose = (item: MenuItem) => {
    if (item.disabled) return;
    item.onSelect();
    onOpenChange(false);
    // The row that had focus is about to unmount; without this the next Tab
    // starts at the top of the page.
    triggerRef.current?.focus({ preventScroll: true });
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (isImeKeyEvent(event.nativeEvent)) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        move(1);
        return;
      case "ArrowUp":
        event.preventDefault();
        move(-1);
        return;
      case "Home":
        event.preventDefault();
        focusItem(enabled[0]?.id);
        return;
      case "End":
        event.preventDefault();
        focusItem(enabled[enabled.length - 1]?.id);
        return;
      case "Enter":
      case " ": {
        event.preventDefault();
        const item = items.find((candidate) => candidate.id === focusedId());
        if (item) choose(item);
        return;
      }
      default:
        break;
    }

    if (event.key.length === 1) {
      event.preventDefault();
      typeahead(event.key);
    }
  };

  const chooseProps = (item: MenuItem) => ({
    role: item.checked === undefined ? ("menuitem" as const) : ("menuitemradio" as const),
    "aria-checked": item.checked,
    "aria-disabled": item.disabled || undefined,
    tabIndex: item.id === active ? 0 : -1,
    onClick: () => choose(item),
  });

  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      triggerRef={triggerRef}
      label={label}
      placement={placement}
      align={align}
      // A menu is a column of labels: narrower than a chip's trigger would
      // truncate every row, and wider than this overhangs the page edge.
      width={240}
      maxHeight={360}
    >
      <div role="menu" aria-label={label} onKeyDown={onKeyDown}>
        {items.map((item) => (
          <div
            key={item.id}
            ref={(node) => {
              if (node) rowRefs.current.set(item.id, node);
              else rowRefs.current.delete(item.id);
            }}
            {...chooseProps(item)}
            // A row with tabindex="-1" still takes focus from a click; an
            // inert row must not, or "disabled" only means "the click did
            // nothing" while the keyboard has already moved onto it.
            onMouseDown={item.disabled ? (event) => event.preventDefault() : undefined}
            className={[
              "flex min-h-9 w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-body transition-colors max-sm:min-h-11",
              item.disabled
                ? "cursor-default text-kin-muted opacity-60"
                : "text-kin-secondary hover:bg-[var(--kin-fill-strong)] focus:bg-[var(--kin-fill-strong)] focus:text-kin-text focus:outline-none focus-visible:ring-1 focus-visible:ring-kin-focus-ring",
            ].join(" ")}
          >
            {item.icon ? (
              <span className="flex-none" aria-hidden="true">
                {item.icon}
              </span>
            ) : null}
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.checked ? (
              <span className="flex-none" aria-hidden="true">
                <IconCheck size={12} />
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </Popover>
  );
}
