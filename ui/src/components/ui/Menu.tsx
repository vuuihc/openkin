import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useCoarsePointer } from "../../hooks/useMediaQuery";
import { isImeKeyEvent } from "../../lib/ime";
import { IconCheck, IconSearch, IconX } from "../icons";
import Button from "./Button";
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
  /**
   * A second line inside the same row: the consequence of a choice ("YOLO —
   * trusted / sandboxed envs only"), drawn under the label in the muted
   * caption ink. It stays in the row's text content on purpose — a menu row's
   * accessible name is what a reader hears as they move through it, and
   * `aria-describedby` is not announced consistently in menu navigation.
   */
  description?: string;
  /** Renders role="menuitemradio" with aria-checked when defined. */
  checked?: boolean;
  /**
   * A row that configures the menu's `footer` rather than choosing a value:
   * the menu stays open and focus stays where it is, so the editor the row
   * just revealed is not pulled out from under the reader. The caller closes
   * the menu afterwards (Escape, an outside press, or another row).
   */
  keepOpen?: boolean;
  onSelect: () => void;
};

/**
 * A field the caller owns, pinned above the rows. Menu draws it and owns the
 * keyboard contract between the two; the caller owns the query and the
 * filtering, because what a row matches on is domain knowledge.
 */
export type MenuSearch = {
  value: string;
  onChange: (value: string) => void;
  /** Accessible name of the field. */
  label: string;
  placeholder: string;
  /** Accessible name of the clear control. */
  clearLabel: string;
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
  /**
   * The row that takes focus when the menu opens. Defaults to the first
   * enabled row. A radio menu passes its checked row, so opening starts on
   * the current choice and the next arrow key moves relative to it; an id
   * that is disabled or not offered falls back to the first enabled row.
   */
  initialFocusId?: string;
  /** Preferred side; the underlying layer flips it when that side has no room. */
  placement?: "above" | "below";
  /** Edge of the trigger the panel lines up with. */
  align?: "left" | "right";
  /**
   * Panel width in px. A menu is a column of labels, so 240 is the default;
   * a caller whose rows carry a consequence line asks for the width those
   * lines need instead of re-deriving the panel's shape.
   */
  width?: number;
  /**
   * A field above the rows that narrows them. The caller hands the already
   * filtered `items`; the menu adds focus into the field on open, Down into
   * the rows, Up from the first row back out, Enter taking the first enabled
   * row, and letters staying in the field instead of running the typeahead.
   */
  search?: MenuSearch;
  /**
   * Content inside the panel, below the rows: the editor a `keepOpen` row
   * reveals. It is part of this layer, so the panel's Tab containment and
   * Escape reach it, and it is not a command in the menu role.
   */
  footer?: ReactNode;
  /**
   * Shown under the rows when the caller's filter kept none of them. Menu does
   * not filter, so it cannot write this copy itself.
   */
  emptyLabel?: string;
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
  initialFocusId,
  placement = "below",
  align = "left",
  width = 240,
  search,
  footer,
  emptyLabel,
}: MenuProps) {
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  // The floor follows the pointer, not the viewport: an iPad in portrait is
  // 768px wide and still a thumb, so a width breakpoint stopped applying long
  // before the screen that needed it. A mouse keeps the dense 36px rows.
  const coarse = useCoarsePointer();
  const searchRef = useRef<HTMLInputElement>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  // `window.setTimeout` rather than the bare global: the DOM one returns a
  // number, so the handle stays a number even in a tree that also loads
  // Node's timer types.
  const typed = useRef({ text: "", timer: undefined as number | undefined });

  const enabled = items.filter((item) => !item.disabled);
  // A radio menu opens on the row that is set, not on the top of the list:
  // the next arrow key then moves from where the reader already is. The
  // caller names that row; a plain action menu names none and starts at the
  // top, which is also the fallback when the preferred row cannot take focus.
  const preferred =
    initialFocusId != null && enabled.some((item) => item.id === initialFocusId)
      ? initialFocusId
      : null;
  // Roving focus is derived, not stored twice: a caller may add, disable or
  // reorder rows while the menu is open, and a remembered id that no longer
  // resolves falls back to the first row that can take focus.
  const active =
    activeId !== null && enabled.some((item) => item.id === activeId)
      ? activeId
      : (preferred ?? enabled[0]?.id ?? null);

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
    if (id == null) return;
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
    // A row that configures the footer leaves the layer up: closing here would
    // unmount the editor it just revealed.
    if (item.keepOpen) return;
    onOpenChange(false);
    // The row that had focus is about to unmount; without this the next Tab
    // starts at the top of the page.
    triggerRef.current?.focus({ preventScroll: true });
  };

  /**
   * The search field's keys. Letters are never intercepted: they belong to the
   * field, and stopping here is what keeps them out of the rows' typeahead.
   */
  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (isImeKeyEvent(event.nativeEvent)) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        // Into the list where the reader already is, not at its top.
        focusItem(preferred ?? enabled[0]?.id);
        return;
      case "ArrowUp":
        event.preventDefault();
        // Up from the field wraps to the last row, the mirror of Down.
        focusItem(enabled[enabled.length - 1]?.id);
        return;
      case "Enter": {
        event.preventDefault();
        // The caller filtered the rows to what the query kept; Enter takes the
        // first one it can, so typing a name and pressing Enter is enough.
        const first = enabled[0];
        if (first) choose(first);
        return;
      }
      default:
        return;
    }
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
        // Out of the top of the list and back into the field that sent the
        // reader down, when there is one; otherwise wrap as usual.
        if (search && focusedId() === enabled[0]?.id) {
          searchRef.current?.focus({ preventScroll: true });
          return;
        }
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
      width={width}
      maxHeight={360}
    >
      {search ? (
        // Above the rows and outside the menu role: a text field is not a
        // command, and its keystrokes must not bubble into the rows' typeahead.
        // Pinned, because a long catalog scrolls under the field that filters
        // it. The negative top margin and matching padding put the field flush
        // with the panel's inner edge and keep the band above it covered while
        // it sticks.
        <div data-menu-search className="sticky top-0 z-10 -mx-1.5 -mt-1.5 bg-kin-elevated pt-1.5">
          <div className="flex min-h-11 items-center gap-2 border-b border-[var(--kin-hairline)] px-3 focus-within:bg-[var(--kin-fill)] focus-within:outline focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-kin-focus-ring">
            <IconSearch size={14} className="flex-none text-kin-muted" />
            <input
              ref={searchRef}
              value={search.value}
              onChange={(event) => search.onChange(event.target.value)}
              onKeyDown={onSearchKeyDown}
              placeholder={search.placeholder}
              aria-label={search.label}
              className="min-h-11 min-w-0 flex-1 bg-transparent text-strong text-kin-text outline-none placeholder:text-kin-muted"
            />
            {search.value ? (
              <Button
                variant="quiet"
                onClick={() => search.onChange("")}
                aria-label={search.clearLabel}
                title={search.clearLabel}
                // The icon stays compact, but the tap area follows the
                // pointer: a thumb misses a 28px target beside the search
                // text at any width, while a mouse keeps the compact field.
                className={
                  coarse
                    ? "h-11 w-11 flex-none rounded-full p-0"
                    : "h-7 w-7 flex-none rounded-full p-0"
                }
              >
                <IconX size={13} className="text-kin-muted" />
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
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
              `flex ${coarse ? "min-h-11" : "min-h-9"} w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-body transition-colors`,
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
            <span className="min-w-0 flex-1">
              <span className="block truncate">{item.label}</span>
              {item.description ? (
                <span className="block text-caption text-kin-muted">{item.description}</span>
              ) : null}
            </span>
            {item.checked ? (
              <span className="flex-none" aria-hidden="true">
                <IconCheck size={12} />
              </span>
            ) : null}
          </div>
        ))}
      </div>
      {items.length === 0 && emptyLabel ? (
        // Outside the menu role: a menu holds commands, and a sentence is not
        // one. It still sits where the rows would have been, under the field
        // whose query emptied them.
        <p className="px-2 py-2 text-body text-kin-muted">{emptyLabel}</p>
      ) : null}
      {footer ? (
        // The negative margins take back the panel's own padding so the footer
        // keeps the edge-to-edge geometry of the surface that owns it.
        <div className="-mx-1.5 -mb-1.5">{footer}</div>
      ) : null}
    </Popover>
  );
}
