import type { AgentModelOption } from "../../lib/agentModels";
import { isListedModel, modelPickerLabel } from "../../lib/agentModels";
import { useEffect, useState } from "react";
import { useT } from "../../i18n/react";

type Props = {
  /** Selected model id, or "" for agent default. */
  value: string;
  models: AgentModelOption[];
  source?: "configured" | "discovered" | "recommended" | "none";
  status?: "available" | "default_only" | "unavailable";
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
  source,
  status,
  locked,
  disabled,
  onChange,
}: Props) {
  const tr = useT();
  const readOnly = locked || disabled;
  const current = value.trim();
  const currentIsCustom = Boolean(current) && !isListedModel(models, current);
  const [custom, setCustom] = useState(currentIsCustom);
  useEffect(() => {
    if (currentIsCustom) setCustom(true);
    else if (current) setCustom(false);
  }, [currentIsCustom, current]);

  const sourceLabel = source && source !== "none"
    ? tr(`modelPicker.source.${source}`)
    : status === "default_only" ? tr("modelPicker.defaultOnly") : "";

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
        value={custom || currentIsCustom ? "__custom__" : current}
        disabled={readOnly}
        aria-label={tr("modelPicker.label")}
        title={current || tr("modelPicker.defaultHint")}
        onChange={(e) => {
          if (e.target.value === "__custom__") {
            setCustom(true);
            onChange("");
          } else {
            setCustom(false);
            onChange(e.target.value);
          }
        }}
      >
        <option value="">{tr("modelPicker.default")}</option>
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {modelPickerLabel(m)}
            {m.tier ? ` · ${m.tier}` : ""}
          </option>
        ))}
        <option value="__custom__">{tr("modelPicker.custom")}</option>
      </select>
      {(custom || currentIsCustom) && !readOnly && (
        <input
          className="w-44 rounded-lg border border-[var(--kin-hairline-strong)] bg-transparent px-2 py-1 text-[11.5px] text-kin-secondary focus:outline-none focus:ring-1 focus:ring-kin-blue/40"
          value={current}
          placeholder={tr("modelPicker.customPlaceholder")}
          aria-label={tr("modelPicker.customLabel")}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {currentIsCustom && readOnly && <span className="text-[11.5px] text-kin-secondary truncate">{current}</span>}
      {sourceLabel && <span className="text-[11px] text-kin-muted truncate">{sourceLabel}</span>}
      {locked && (
        <span className="text-[11px] text-kin-muted truncate">
          {tr("modelPicker.sessionHint")}
        </span>
      )}
    </div>
  );
}
