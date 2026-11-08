import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  normalizePermissionMode,
  PERMISSION_MODE_LABEL_KEY,
  PERMISSION_MODES,
  type PermissionMode,
} from "../../lib/permissionMode";
import { useT } from "../../i18n/react";
import { isImeKeyEvent } from "../../lib/ime";
import { useAnchoredPanel } from "../../hooks/useAnchoredPanel";
import { useMinWidth } from "../../hooks/useMinWidth";
import { IconCheck, IconChevronDown } from "../icons";
import SheetSelect from "../ui/SheetSelect";

type Props = {
  value: PermissionMode | string;
  /** Modes to offer. Omitted means every mode; empty means none can run here. */
  modes?: PermissionMode[];
  /** When true, mode is session-scoped (already created task) and cannot change. */
  locked?: boolean;
  disabled?: boolean;
  /** Single-row footer: hide labels / locked hint. */
  compact?: boolean;
  /**
   * Whether the pane this control belongs to is the one on screen. A menu
   * portaled to <body> is outside the pane's hidden subtree, so without this
   * it stays over the next conversation and owns its keyboard.
   */
  active?: boolean;
  onChange: (mode: PermissionMode) => void;
};

/** The modes, in the order the picker offers them. The list itself lives in
 *  `lib/permissionMode` beside the label keys, so a mode added to one is a mode
 *  the other knows about. */
const OPTIONS = PERMISSION_MODES;

/**
 * Compact session permission-mode control for the composer footer.
 * Applies to every agent run in the session (main + multi-@ workers).
 */
export default function PermissionModePicker({
  value,
  modes,
  locked,
  disabled,
  compact,
  active = true,
  onChange,
}: Props) {
  const tr = useT();
  const wide = useMinWidth(768);
  const mode = normalizePermissionMode(value);
  const readOnly = locked || disabled;
  const options = modes ? OPTIONS.filter((option) => modes.includes(option)) : OPTIONS;

  const labelKey = PERMISSION_MODE_LABEL_KEY;
  const hintKey = {
    default: "permission.defaultHint",
    accept_edits: "permission.acceptEditsHint",
    yolo: "permission.yoloHint",
  } as const;

  if (compact) {
    // A bottom sheet is the phone's shape. On a Mac the same compact chip used
    // to open one — an iPhone action sheet in the middle of a desktop window,
    // covering the composer it was describing. Above the breakpoint the chip
    // opens a menu anchored to itself instead.
    if (!wide) {
      return (
        <SheetSelect
          label={tr("permission.label")}
          value={mode}
          options={options.map((option) => ({ id: option, label: tr(labelKey[option]) }))}
          onChange={(id) => onChange(id as PermissionMode)}
          disabled={readOnly}
          className={
            mode === "yolo"
              ? "max-w-[10rem] text-kin-orange-ink"
              : "max-w-[10rem] text-kin-secondary"
          }
        />
      );
    }
    return (
      <PermissionMenu
        mode={mode}
        options={options}
        disabled={readOnly}
        active={active}
        labelKey={labelKey}
        hintKey={hintKey}
        onChange={onChange}
      />
    );
  }

  return (
    <div className="flex items-center min-w-0 gap-2">
      <span className="text-caption text-kin-muted flex-none">{tr("permission.label")}</span>
      <div
        className={[
          "inline-flex items-center rounded-lg border border-[var(--kin-hairline-strong)] p-0.5 gap-0.5",
          readOnly ? "opacity-70" : "",
        ].join(" ")}
        role="group"
        aria-label={tr("permission.label")}
        title={tr(hintKey[mode])}
      >
        {options.map((opt) => {
          const active = mode === opt;
          const yolo = opt === "yolo";
          return (
            <button
              key={opt}
              type="button"
              disabled={readOnly}
              onClick={() => onChange(opt)}
              className={[
                "px-2 py-0.5 rounded-md text-caption font-medium transition-colors",
                active
                  ? yolo
                    ? "bg-kin-orange/15 text-kin-orange-ink"
                    : "bg-kin-blue/15 text-kin-blue-ink"
                  : "text-kin-muted hover:text-kin-secondary hover:bg-[var(--kin-fill)]",
                readOnly ? "cursor-default" : "cursor-pointer",
              ].join(" ")}
              title={tr(hintKey[opt])}
              aria-pressed={active}
            >
              {tr(labelKey[opt])}
            </button>
          );
        })}
      </div>
      {locked && (
        <span className="text-caption text-kin-muted truncate">
          {tr("permission.sessionLocked")}
        </span>
      )}
    </div>
  );
}

/**
 * The desktop permission chip: a menu that grows out of the chip itself.
 *
 * The options carry the consequence of each mode, not only its name — "ask
 * every time" is the safe choice and has to be readable as one — and the
 * current mode is checked rather than merely highlighted. Escape and a click
 * outside close it without answering; choosing closes it and returns focus to
 * the chip, so the keyboard does not fall back to the top of the document.
 */
function PermissionMenu({
  mode,
  options,
  disabled,
  labelKey,
  hintKey,
  active,
  onChange,
}: {
  mode: PermissionMode;
  options: readonly PermissionMode[];
  disabled?: boolean;
  active: boolean;
  labelKey: Record<PermissionMode, string>;
  hintKey: Record<PermissionMode, string>;
  onChange: (mode: PermissionMode) => void;
}) {
  const tr = useT();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Viewport coordinates, not `absolute bottom-full`: the composer's control
  // row is an `overflow-x-auto` strip, which clips an absolutely positioned
  // panel to its own ~30px height. Portaled to <body>, the menu is above the
  // strip and cannot be cut by it.
  const anchor = useAnchoredPanel(open, triggerRef, {
    placement: "above",
    align: "right",
    width: 288,
    maxHeight: 360,
  });
  // The menu is measured in a layout effect after the click that opened it, so
  // it is not in the DOM on the render `open` first turns true. Keying the
  // focus step on the measured anchor is what makes it run when there is a row
  // to focus.
  const anchored = Boolean(anchor);

  // A pane that goes off screen takes its menu with it. The menu is portaled
  // to <body>, so it is not inside the subtree the tab strip hides; left open
  // it would float over the next conversation and swallow its shortcuts.
  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);

  useEffect(() => {
    if (!open) return;
    const inside = (node: Node | null) =>
      Boolean(node && (rootRef.current?.contains(node) || menuRef.current?.contains(node)));
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      // The menu lives in a portal, so it is not a DOM child of the trigger.
      if (inside(target)) return;
      setOpen(false);
    };
    const onFocus = (event: FocusEvent) => {
      // Tabbing out closes the menu: it is a layer over the page, not a
      // section of the tab order that keeps going after the last item.
      if (inside(event.target as Node)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Only the layer the reader is in answers the key. A menu left in the
      // corner closing on an Escape pressed somewhere else — and moving focus
      // to its chip — is worse than the menu staying open.
      if (!inside(event.target as Node) && !inside(document.activeElement)) return;
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("focus", onFocus, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("focus", onFocus, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !anchored) return;
    // Opening with the keyboard should land on the current choice, not on the
    // first row: the next arrow key then moves relative to what is set. The
    // first row is the fallback when the current mode is not offered here.
    const menu = menuRef.current;
    (menu?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]') ??
      menu?.querySelector<HTMLButtonElement>('[role="menuitemradio"]'))?.focus({
      preventScroll: true,
    });
  }, [open, anchored]);

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (isImeKeyEvent(event.nativeEvent)) return;
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [],
    );
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      items[Math.min(at + 1, items.length - 1)]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      items[Math.max(at - 1, 0)]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      items[items.length - 1]?.focus();
    }
  };

  const pick = (next: PermissionMode) => {
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
    onChange(next);
  };

  return (
    <span ref={rootRef} className="relative inline-flex min-w-0 flex-none">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        aria-label={`${tr("permission.label")}${tr("common.labelSeparator")}${tr(labelKey[mode])}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={tr(hintKey[mode])}
        className={[
          "inline-flex min-w-0 flex-none items-center gap-1 rounded-lg bg-transparent px-1.5 py-0.5 text-body font-medium sm:text-caption",
          "border border-[var(--kin-hairline-strong)] focus:outline-none focus:ring-1 focus:ring-kin-focus-ring",
          disabled ? "cursor-default opacity-70" : "cursor-pointer hover:text-kin-text",
          mode === "yolo" ? "text-kin-orange-ink" : "text-kin-secondary",
        ].join(" ")}
      >
        <span className="truncate">{tr(labelKey[mode])}</span>
        <IconChevronDown size={11} className="flex-none opacity-70" />
      </button>
      {open && anchor
        ? createPortal(
            <div
              ref={menuRef}
              role="menu"
              aria-label={tr("permission.label")}
              onKeyDown={onMenuKeyDown}
              style={{
                left: anchor.left,
                width: anchor.width,
                maxHeight: anchor.maxHeight,
                top: anchor.top,
                bottom: anchor.bottom,
              }}
              className="fixed z-50 overflow-y-auto kin-scroll rounded-xl border border-[var(--kin-hairline)] bg-kin-elevated p-1 shadow-e3"
            >
              {options.map((option) => {
                const active = option === mode;
                const yolo = option === "yolo";
                return (
                  <button
                    key={option}
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    onClick={() => pick(option)}
                    className={[
                      "flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors",
                      "hover:bg-[var(--kin-fill-strong)] focus:bg-[var(--kin-fill-strong)] focus:outline-none",
                      active ? "text-kin-text" : "text-kin-secondary",
                    ].join(" ")}
                  >
                    <span className="min-w-0 flex-1">
                      <span
                        className={[
                          "block truncate text-body",
                          active ? "font-medium" : "",
                          yolo ? "text-kin-orange-ink" : "",
                        ].join(" ")}
                      >
                        {tr(labelKey[option])}
                      </span>
                      <span className="block text-caption text-kin-muted">
                        {tr(hintKey[option])}
                      </span>
                    </span>
                    {active ? (
                      <IconCheck size={13} className="mt-0.5 flex-none text-kin-blue-ink" />
                    ) : null}
                  </button>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
