import { useEffect, useRef, useState } from "react";
import {
  normalizePermissionMode,
  PERMISSION_MODE_LABEL_KEY,
  PERMISSION_MODES,
  type PermissionMode,
} from "../../lib/permissionMode";
import { useT } from "../../i18n/react";
import { useMinWidth } from "../../hooks/useMinWidth";
import { IconChevronDown } from "../icons";
import Button from "../ui/Button";
import Menu from "../ui/Menu";
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
            // eslint-disable-next-line kin/no-raw-button -- an option in a segmented group; the segment itself is the hit area, not an action.
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
 * The desktop permission chip: the shared `Menu` on the shared `Popover` layer.
 *
 * The options carry the consequence of each mode, not only its name — "ask
 * every time" is the safe choice and has to be readable as one — and the
 * current mode is checked rather than merely highlighted. Everything else is
 * the facade's: the body portal, the viewport measurement the composer's
 * `overflow-x-auto` control row needs, outside-pointer and Escape dismissal,
 * focus into the menu and back to the chip, Tab containment, roving focus that
 * wraps, Home/End and typeahead. This function only maps modes to rows.
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
  const triggerRef = useRef<HTMLButtonElement>(null);

  // A pane that goes off screen takes its menu with it. The menu is portaled
  // to <body>, so it is not inside the subtree the tab strip hides; left open
  // it would float over the next conversation and swallow its shortcuts.
  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);

  return (
    <span className="relative inline-flex min-w-0 flex-none">
      {/* The chip's own shape (border, padding, truncation) stays; the facade
          supplies the family's focus ring and press behaviour. Its `quiet`
          variant's ink is overridden with `!` so the mode colour still wins. */}
      <Button
        ref={triggerRef}
        variant="quiet"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        aria-label={`${tr("permission.label")}${tr("common.labelSeparator")}${tr(labelKey[mode])}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={tr(hintKey[mode])}
        className={[
          // The facade wraps children in its own spans, so the chip's row
          // layout lives on one inner flex span (as in `CwdPicker` /
          // `BranchPicker`); `[&>span…]` keeps each wrapper able to shrink, or
          // the mode label cannot truncate.
          "min-w-0 flex-none rounded-lg bg-transparent px-1.5 py-0.5 text-body font-medium sm:text-caption [&>span]:min-w-0 [&>span>span]:min-w-0",
          "border border-[var(--kin-hairline-strong)]",
          disabled ? "cursor-default opacity-70" : "cursor-pointer hover:text-kin-text!",
          mode === "yolo" ? "text-kin-orange-ink!" : "text-kin-secondary!",
        ].join(" ")}
      >
        <span className="inline-flex min-w-0 items-center gap-1">
          <span className="truncate">{tr(labelKey[mode])}</span>
          <IconChevronDown size={11} className="flex-none opacity-70" />
        </span>
      </Button>
      <Menu
        open={open}
        onOpenChange={setOpen}
        triggerRef={triggerRef}
        label={tr("permission.label")}
        // A session already in YOLO opens on YOLO: focus starts on what is
        // set, so the next arrow key moves from the current mode instead of
        // from the top of the list.
        initialFocusId={mode}
        items={options.map((option) => ({
          id: option,
          label: tr(labelKey[option]),
          // The consequence stays inside the row, so it is read as part of the
          // mode's name rather than hidden in a tooltip.
          description: tr(hintKey[option]),
          checked: option === mode,
          onSelect: () => onChange(option),
        }))}
        placement="above"
        align="right"
        // Room for the consequence lines; 240 would truncate them.
        width={288}
      />
    </span>
  );
}
