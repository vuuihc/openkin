import type { AgentModelOption } from "../../lib/agentModels";
import { modelPickerLabel } from "../../lib/agentModels";
import { useT } from "../../i18n/react";

type Props = {
  /** Selected model id, or "" for agent default. */
  value: string;
  models: AgentModelOption[];
  /** When true, picker is display-only (session locked). */
  locked?: boolean;
  disabled?: boolean;
  onChange: (modelId: string) => void;
};

/**
 * Compact model selector for the composer footer.
 * Empty value = agent / CLI default (no model field on the API request).
 */
export default function ModelPicker({
  value,
  models,
  locked,
  disabled,
  onChange,
}: Props) {
  const tr = useT();
  const readOnly = locked || disabled;
  const hasModels = models.length > 0;
  const current = value.trim();

  if (!hasModels && !current) {
    return null;
  }

  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className="text-[11.5px] text-kin-muted flex-none">
        {tr("modelPicker.label")}
      </span>
      <select
        className={[
          "max-w-[14rem] truncate rounded-lg border border-[var(--kin-hairline-strong)]",
          "bg-transparent px-2 py-1 text-[11.5px] font-medium text-kin-secondary",
          "focus:outline-none focus:ring-1 focus:ring-kin-blue/40",
          readOnly ? "opacity-70 cursor-default" : "cursor-pointer hover:text-kin-text",
        ].join(" ")}
        value={current}
        disabled={readOnly}
        aria-label={tr("modelPicker.label")}
        title={current || tr("modelPicker.defaultHint")}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{tr("modelPicker.default")}</option>
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {modelPickerLabel(m)}
            {m.tier ? ` · ${m.tier}` : ""}
          </option>
        ))}
        {/* Keep unknown current model visible (e.g. task.model not in catalog). */}
        {current && !models.some((m) => m.id === current) && (
          <option value={current}>{current}</option>
        )}
      </select>
      {locked && (
        <span className="text-[11px] text-kin-muted truncate">
          {tr("modelPicker.sessionHint")}
        </span>
      )}
    </div>
  );
}
