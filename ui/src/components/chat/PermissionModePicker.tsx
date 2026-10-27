import {
  normalizePermissionMode,
  PERMISSION_MODE_LABEL_KEY,
  PERMISSION_MODES,
  type PermissionMode,
} from "../../lib/permissionMode";
import { useT } from "../../i18n/react";
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
  onChange,
}: Props) {
  const tr = useT();
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
    return (
      <SheetSelect
        label={tr("permission.label")}
        value={mode}
        options={options.map((option) => ({ id: option, label: tr(labelKey[option]) }))}
        onChange={(id) => onChange(id as PermissionMode)}
        disabled={readOnly}
        className={mode === "yolo" ? "text-kin-orange-ink" : "text-kin-secondary"}
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
