import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import { useAnchoredPanel } from "../../hooks/useAnchoredPanel";
import { useT } from "../../i18n/react";
import { hasFinePointer } from "../../lib/pointer";
import Sheet from "../mobile/Sheet";
import { IconCheck, IconChevronDown, IconSearch } from "../icons";

export type SearchSelectOption = {
  id: string;
  label: string;
  /** Secondary text after the label — a model's tier, a gateway's name. */
  detail?: string;
  /** A heading above a run of options (a model catalog's provider). Options
   *  with the same group stay together in the order given; the heading is
   *  drawn once, before the first of them. */
  group?: string;
  /** A mark before the label — an agent's avatar tile. */
  leading?: ReactNode;
};

type Props = {
  /** Accessible name of the control, and the sheet's heading. */
  label: string;
  value: string;
  options: SearchSelectOption[];
  onChange: (id: string) => void;
  /** Trigger text when `value` is not one of `options` (a typed model id). */
  display?: string;
  /** Tooltip on the trigger. Defaults to the current label — pass the hint a
   *  truncated chip cannot carry, e.g. what "Default" means. */
  title?: string;
  disabled?: boolean;
  /** Draws the chip's own hairline. Off inside a joined control whose box
   *  already draws one — two borders 1px apart is the seam that reads as a
   *  rendering bug. */
  bordered?: boolean;
  /**
   * Trigger classes: the width cap and the ink. Every caller passes a cap —
   * this primitive deliberately ships none, because a `max-w-full` here would
   * be emitted after the caller's arbitrary value and silently win the
   * cascade, leaving a long model id to stretch the whole joined control.
   */
  className?: string;
  /** Which edge of the trigger the desktop panel grows from. The composer
   *  footer sits at the bottom of its page, so its pickers open upward. */
  placement?: "top" | "bottom";
  /** A filter field above the list. Off for short lists: a search box over
   *  four agents is a promise the list cannot keep. */
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyLabel?: string;
};

/**
 * The desktop panel's own size and edge inset. Where it goes is
 * `useAnchoredPanel`'s job — the same measurement the dispatch and permission
 * panels use — because the trigger often sits inside an `overflow-*` strip
 * (the composer's control row is one), where an absolutely positioned panel is
 * clipped by the strip and a hand-rolled flip disagrees with its neighbours at
 * the same viewport height. Measured from the viewport, `fixed` escapes the
 * strip: nothing between here and <body> sets a transform, filter or
 * `contain`. The 288px width and 8px edge are this panel's shape, so they stay
 * here.
 */
const PANEL_WIDTH = 288;
const PANEL_MAX_HEIGHT = 360;
const EDGE = 8;

/** Case-insensitive match over everything the row shows, so a gateway name or
 *  a raw id finds a model whose label does not contain the word. */
function matches(option: SearchSelectOption, needle: string): boolean {
  return [option.label, option.id, option.detail ?? ""].some((text) =>
    text.toLowerCase().includes(needle),
  );
}

type OptionRun = { heading: string | null; options: SearchSelectOption[] };

/** Split the flat, already-filtered options into the runs their headings name. */
function groupRuns(options: SearchSelectOption[]): OptionRun[] {
  const runs: OptionRun[] = [];
  for (const option of options) {
    const heading = option.group || null;
    const last = runs[runs.length - 1];
    if (last && last.heading === heading) last.options.push(option);
    else runs.push({ heading, options: [option] });
  }
  return runs;
}

type TriggerProps = {
  label: string;
  current: string;
  open: boolean;
  hasPopup: "listbox" | "dialog";
  disabled?: boolean;
  className: string;
  buttonRef?: Ref<HTMLButtonElement>;
  title?: string;
  /** The panel this button opens, while it is open. */
  controls?: string;
  onClick: () => void;
};

function Trigger({
  label,
  current,
  open,
  hasPopup,
  disabled,
  className,
  buttonRef,
  title,
  controls,
  onClick,
}: TriggerProps) {
  const tr = useT();
  return (
    <button
      ref={buttonRef}
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={`${label}${tr("common.labelSeparator")}${current}`}
      aria-haspopup={hasPopup}
      aria-expanded={open}
      aria-controls={controls}
      title={title ?? current}
      className={className}
    >
      <span className="truncate">{current}</span>
      <IconChevronDown size={11} className="flex-none opacity-70" />
    </button>
  );
}

type ChooserProps = {
  label: string;
  options: SearchSelectOption[];
  value: string;
  onSelect: (id: string) => void;
  searchable: boolean;
  searchPlaceholder: string;
  emptyLabel: string;
  /** Focus the first control on mount. Fine pointers only — a phone must not
   *  raise the keyboard before the list has been read. */
  autoFocus: boolean;
  /**
   * `listbox` in the anchored popover. The phone's surface is a `Sheet`, whose
   * dialog already owns the Escape layer: `Sheet` treats any `[role="listbox"]`
   * inside its panel as a popover opened on top of it and declines to close,
   * so the sheet's list is a plain list of `aria-current` buttons instead.
   */
  listbox: boolean;
  /** Id of the list element, so the desktop trigger can point at it. */
  listId: string;
  /** Closes the surface when focus is about to leave it by keyboard. The phone
   *  surface omits this: there the `Sheet` owns the focus trap, and Tab moves
   *  through the sheet rather than out of it. */
  onDismiss?: () => void;
  listClassName?: string;
};

function Chooser({
  label,
  options,
  value,
  onSelect,
  searchable,
  searchPlaceholder,
  emptyLabel,
  autoFocus,
  listbox,
  listId,
  onDismiss,
  listClassName = "",
}: ChooserProps) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);

  const needle = query.trim().toLowerCase();
  const shown = needle ? options.filter((option) => matches(option, needle)) : options;

  useEffect(() => {
    if (!autoFocus) return;
    if (searchable) inputRef.current?.focus();
    else listRef.current?.focus();
  }, [autoFocus, searchable]);

  useEffect(() => {
    // A gateway catalog is dozens of rows long and the current model can be the
    // last one; opening at the top would hide the very row the chip reports.
    // The list is its own scroll box on both surfaces, so this scrolls the list
    // and leaves the filter where it was. Optional call: jsdom has no layout,
    // and a test that opens the picker should not have to stub a browser API.
    selectedRef.current?.scrollIntoView?.({ block: "nearest" });
  }, []);

  const rows = () =>
    Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("[data-search-option]") ?? []);

  const focusRow = (index: number) => {
    const all = rows();
    if (all.length === 0) return;
    all[Math.max(0, Math.min(index, all.length - 1))]?.focus();
  };

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // An IME candidate list owns the arrow keys until the composition ends;
    // moving focus mid-composition would abort the word the user is typing.
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Tab") {
      // The panel would otherwise stay open behind a focus it no longer owns.
      onDismiss?.();
      return;
    }
    const all = rows();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusRow(at + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      // Out of the top of the list, back into the field that filters it.
      if (at <= 0 && searchable) inputRef.current?.focus();
      else focusRow(at - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusRow(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusRow(all.length - 1);
    }
  };

  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Tab") {
      onDismiss?.();
      return;
    }
    if (event.key === "Enter") {
      // Filtering down to the row you want and pressing Enter should take it;
      // requiring an ArrowDown first makes the field feel inert.
      const first = shown[0];
      if (first) {
        event.preventDefault();
        onSelect(first.id);
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusRow(0);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusRow(rows().length - 1);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {searchable ? (
        <label className="relative flex flex-none items-center">
          <IconSearch size={13} className="pointer-events-none absolute left-2.5 text-kin-muted" />
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onSearchKeyDown}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            role={listbox ? "combobox" : undefined}
            aria-expanded={listbox ? true : undefined}
            aria-controls={listbox ? listId : undefined}
            aria-autocomplete={listbox ? "list" : undefined}
            className={[
              "w-full rounded-lg border border-transparent bg-[var(--kin-fill)] pl-8 pr-2 text-body text-kin-text outline-none transition-colors placeholder:text-kin-muted focus:border-kin-blue/40 focus:bg-[var(--kin-fill-strong)]",
              // A sheet is portaled out of `.touch-lg`, so its own controls
              // carry the 44px floor; the popover is a mouse-sized list.
              listbox ? "h-8" : "h-11",
            ].join(" ")}
          />
        </label>
      ) : null}
      <div
        ref={listRef}
        id={listId}
        role={listbox ? "listbox" : undefined}
        aria-label={listbox ? label : undefined}
        tabIndex={!searchable && autoFocus ? -1 : undefined}
        onKeyDown={onListKeyDown}
        className={["mt-1", listClassName].filter(Boolean).join(" ")}
      >
        {groupRuns(shown).map((run, runIndex) => (
          <div
            key={`${run.heading ?? "__ungrouped"}-${runIndex}`}
            // A listbox may only contain options and groups; a bare heading div
            // is neither, and some screen readers drop the whole list's
            // semantics when they meet one. The heading therefore becomes the
            // group's name and the group holds its options — the shape a native
            // `<optgroup>` gives, so an option can answer "which group am I in"
            // without relying on being drawn next to it.
            role={listbox || run.heading ? "group" : undefined}
            aria-label={run.heading ?? undefined}
          >
            {run.heading ? (
              <div
                // For the eye only in the listbox: the group above already
                // carries the name, and a readable heading would announce the
                // provider twice for every run.
                aria-hidden={listbox ? true : undefined}
                className={[
                  "px-2 pb-0.5 text-micro font-semibold uppercase tracking-label text-kin-muted",
                  runIndex === 0 ? "pt-1" : "pt-2",
                ].join(" ")}
              >
                {run.heading}
              </div>
            ) : null}
            {run.options.map((option) => {
              const selected = option.id === value;
              return (
                <button
                  key={option.id || "__default"}
                  ref={selected ? selectedRef : undefined}
                  type="button"
                  data-search-option
                  role={listbox ? "option" : undefined}
                  // The listbox pattern keeps Tab in the field and moves focus with
                  // the arrow keys; 47 tab stops between the search and the rest of
                  // the page is not a list, it is a maze. The phone's rows keep
                  // their place in the tab order *because* the sheet's focus trap
                  // is built from them: one stop per row is the price of a list
                  // that a keyboard can still reach there, and touch is the path
                  // that surface is actually used by.
                  tabIndex={listbox ? -1 : undefined}
                  aria-selected={listbox ? selected : undefined}
                  aria-current={!listbox && selected ? "true" : undefined}
                  // WebKit does not focus a button on a mouse click, so the field
                  // above blurs with `relatedTarget === null`; keeping the default
                  // would hand focus to nothing mid-click. This is also what the
                  // combobox pattern asks for: focus stays in the field, the row is
                  // a target the arrow keys and the mouse both act on.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onSelect(option.id)}
                  className={[
                    "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors",
                    "hover:bg-[var(--kin-fill-strong)] focus:bg-[var(--kin-fill-strong)] focus:outline-none",
                    // The sheet is portaled out of `.touch-lg`, so its rows carry
                    // their own touch floor; 16px is what the phone's other lists
                    // (`MobileRow`) use. The popover stays dense at body size.
                    listbox ? "text-body" : "min-h-12 text-subtitle",
                    selected ? "text-kin-text" : "text-kin-secondary",
                  ].join(" ")}
                >
                  {option.leading ? <span className="flex-none">{option.leading}</span> : null}
                  <span className="min-w-0 flex-1 truncate">
                    {option.label}
                    {option.detail ? (
                      <span className={listbox ? "text-kin-muted" : "text-caption text-kin-muted"}>
                        {" · "}
                        {option.detail}
                      </span>
                    ) : null}
                  </span>
                  {selected ? (
                    <IconCheck size={13} className="flex-none text-kin-blue-ink" />
                  ) : null}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {/* The region is mounted before it has anything to say: a live region
          added in the same commit as its text is not reliably announced. */}
      <div
        role="status"
        className={shown.length === 0 ? "px-2 py-3 text-body text-kin-muted" : "sr-only"}
      >
        {shown.length === 0 ? emptyLabel : ""}
      </div>
    </div>
  );
}

/**
 * A choice control whose list can be longer than a menu.
 *
 * A native `<select>` is the right control for four options and the wrong one
 * for a gateway catalog of forty-seven: there is no way to filter it, the phone
 * gets a system wheel that ignores the console's theme, and the closed state is
 * a grey box. This is the same chip on both widths, with a filter field and a
 * scrollable list — the shape the iOS run-configuration sheets use, and the
 * reason the model picker can show every model the CLI actually offers.
 *
 * The desktop surface is a fixed-positioned panel with listbox semantics,
 * placed by `useAnchoredPanel` so it flips and clamps exactly like the other
 * composer pickers; the phone surface is the console's own `Sheet`, which is
 * where the safe area, the scrim and Escape already live. Both read from one
 * list component, so the two surfaces cannot disagree about what is selected.
 */
export default function SearchSelect({
  label,
  value,
  options,
  onChange,
  display,
  title,
  disabled,
  bordered = true,
  className,
  placement = "bottom",
  searchable = false,
  searchPlaceholder,
  emptyLabel,
}: Props) {
  const tr = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listId = useId();

  const current = display ?? options.find((option) => option.id === value)?.label ?? value;

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      // The panel held focus; without this the next Tab starts from the top of
      // the document instead of from the control that was just closed.
      triggerRef.current?.focus({ preventScroll: true });
    };
    // Focus leaving the panel closes it: with the options out of the tab order,
    // the next stop is behind the panel, and a list left open there no longer
    // belongs to the focus. A `null` relatedTarget is not a focus move — WebKit
    // reports it when a mouse click blurs the field, and the click that follows
    // is the row selection itself. Closing on it made every mouse pick in
    // Safari remove the row before `click` could land on it.
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget as Node | null;
      if (next && !rootRef.current?.contains(next)) setMenuOpen(false);
    };
    // A panel measured for the desktop is not the phone's surface. Narrowing
    // the window must not leave it open — and its document listeners attached
    // — behind a trigger CSS has already hidden, only to reappear on widening.
    let media: MediaQueryList | null = null;
    const onMediaChange = () => {
      if (!media?.matches) setMenuOpen(false);
    };
    if (typeof window.matchMedia === "function") {
      media = window.matchMedia("(min-width: 640px)");
      media.addEventListener?.("change", onMediaChange);
    }
    const root = rootRef.current;
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    root?.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      root?.removeEventListener("focusout", onFocusOut);
      media?.removeEventListener?.("change", onMediaChange);
    };
  }, [menuOpen]);

  // The sheet is `md:hidden` in `Sheet`; past that width it is invisible but
  // still mounted, and its dialog keeps the Escape/Tab trap. Closing it on the
  // breakpoint is what makes "hidden" mean gone (a tablet rotation, or a phone
  // window dragged wide).
  useEffect(() => {
    if (!sheetOpen || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(min-width: 768px)");
    const onMediaChange = () => {
      if (media.matches) setSheetOpen(false);
    };
    media.addEventListener?.("change", onMediaChange);
    return () => media.removeEventListener?.("change", onMediaChange);
  }, [sheetOpen]);

  /**
   * Where to put the panel, in viewport coordinates.
   *
   * The shared hook measures on a layout effect and again on resize, on scroll
   * in the capture phase (the strip the trigger sits in scrolls independently
   * of the window), on the visual viewport (a phone keyboard moves the trigger
   * without a window resize) and on the trigger's own resize. Keeping the flip
   * here in one place is what makes this panel and the dispatch panel agree
   * about which side has room.
   */
  const anchor = useAnchoredPanel(menuOpen, triggerRef, {
    placement: placement === "top" ? "above" : "below",
    align: "right",
    width: PANEL_WIDTH,
    maxHeight: PANEL_MAX_HEIGHT,
    edge: EDGE,
  });

  const choose = (id: string) => {
    onChange(id);
    // The focused row is about to unmount. Without this the browser drops focus
    // to <body> and the next Tab starts at the top of the page. The sheet
    // restores focus itself, so this is the popover's path only.
    if (menuOpen) triggerRef.current?.focus({ preventScroll: true });
    setMenuOpen(false);
    setSheetOpen(false);
  };

  const triggerClass = [
    // A chosen value reads a step larger on a phone (see `SheetSelect`), and
    // the desktop row this chip joins is set at caption. The coarse-pointer
    // type floor only covers fields, not buttons, so these are the sizes the
    // chip actually gets on each surface.
    "inline-flex min-w-0 flex-none items-center gap-1 rounded-lg bg-transparent px-1.5 py-0.5 text-body font-medium sm:text-caption",
    bordered ? "border border-[var(--kin-hairline-strong)]" : "",
    "focus:outline-none focus:ring-1 focus:ring-kin-focus-ring",
    disabled ? "cursor-default opacity-70" : "cursor-pointer hover:text-kin-text",
    className ?? "text-kin-secondary",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <span ref={rootRef} className="relative hidden min-w-0 sm:block">
        <Trigger
          buttonRef={triggerRef}
          label={label}
          current={current}
          open={menuOpen}
          hasPopup="listbox"
          disabled={disabled}
          className={triggerClass}
          title={title}
          controls={menuOpen ? listId : undefined}
          onClick={() => setMenuOpen((open) => !open)}
        />
        {menuOpen && anchor ? (
          <div
            data-search-panel
            style={{
              left: anchor.left,
              width: anchor.width,
              maxHeight: anchor.maxHeight,
              top: anchor.top,
              bottom: anchor.bottom,
            }}
            className="fixed z-50 flex flex-col overflow-hidden rounded-xl border border-[var(--kin-hairline)] bg-kin-elevated p-1.5 shadow-e3"
          >
            <Chooser
              label={label}
              options={options}
              value={value}
              onSelect={choose}
              searchable={searchable}
              searchPlaceholder={searchPlaceholder ?? label}
              emptyLabel={emptyLabel ?? tr("common.noResults")}
              autoFocus={hasFinePointer()}
              listbox
              listId={listId}
              onDismiss={() => setMenuOpen(false)}
              listClassName="min-h-0 flex-1 overflow-y-auto kin-scroll"
            />
          </div>
        ) : null}
      </span>

      {/* The phone's trigger is separate, not a `sm:hidden` twin sharing one
          panel: a panel portaled to `document.body` cannot be hidden by a
          media query on an ancestor. Each surface owns its own open state. */}
      <span className="min-w-0 sm:hidden">
        <Trigger
          label={label}
          current={current}
          open={sheetOpen}
          hasPopup="dialog"
          disabled={disabled}
          className={triggerClass}
          title={title}
          onClick={() => setSheetOpen(true)}
        />
      </span>

      <Sheet open={sheetOpen} onClose={() => setSheetOpen(false)} title={label}>
        <Chooser
          label={label}
          options={options}
          value={value}
          onSelect={choose}
          searchable={searchable}
          searchPlaceholder={searchPlaceholder ?? label}
          emptyLabel={emptyLabel ?? tr("common.noResults")}
          autoFocus={false}
          listbox={false}
          listId={listId}
          // Its own scroll box, so the filter stays on screen when the selected
          // row is forty rows down and the sheet opens scrolled to it.
          listClassName="max-h-[60dvh] overflow-y-auto kin-scroll"
        />
      </Sheet>
    </>
  );
}
