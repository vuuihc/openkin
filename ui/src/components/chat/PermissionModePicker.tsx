import {
  normalizePermissionMode,
  type PermissionMode,
} from "../../lib/permissionMode";
import { useT } from "../../i18n/react";

type Props = {
  value: PermissionMode | string;
  /** When true, mode is session-scoped (already created task) and cannot change. */
  locked?: boolean;
  disabled?: boolean;
  onChange: (mode: PermissionMode) => void;
};

const OPTIONS: PermissionMode[] = ["default", "accept_edits", "yolo"];

/**
 * Compact session permission-mode control for the composer footer.
 * Applies to every agent run in the session (main + multi-@ workers).
 */
export default function PermissionModePicker({
  value,
  locked,
  disabled,
  onChange,
}: Props) {
  const tr = useT();
  const mode = normalizePermissionMode(value);
  const readOnly = locked || disabled;

  const labelKey = {
    default: "permission.default",
    accept_edits: "permission.acceptEdits",
    yolo: "permission.yolo",
  } as const;
  const hintKey = {
    default: "permission.defaultHint",
    accept_edits: "permission.acceptEditsHint",
    yolo: "permission.yoloHint",
  } as const;

  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className="text-[11.5px] text-kin-muted flex-none">
        {tr("permission.label")}
      </span>
      <div
        className={[
          "inline-flex items-center rounded-lg border border-[var(--kin-hairline-strong)] p-0.5 gap-0.5",
          readOnly ? "opacity-70" : "",
        ].join(" ")}
        role="group"
        aria-label={tr("permission.label")}
        title={tr(hintKey[mode])}
      >
        {OPTIONS.map((opt) => {
          const active = mode === opt;
          const yolo = opt === "yolo";
          return (
            <button
              key={opt}
              type="button"
              disabled={readOnly}
              onClick={() => onChange(opt)}
              className={[
                "px-2 py-0.5 rounded-md text-[11.5px] font-medium transition-colors",
                active
                  ? yolo
                    ? "bg-[rgba(255,159,10,.18)] text-[#ffb340]"
                    : "bg-kin-blue-soft text-kin-blue"
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
        <span className="text-[11px] text-kin-muted truncate">
          {tr("permission.sessionLocked")}
        </span>
      )}
    </div>
  );
}
