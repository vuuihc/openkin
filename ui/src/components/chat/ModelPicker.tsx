import type { AgentModelOption } from "../../lib/agentModels";
import { isListedModel, modelPickerLabel } from "../../lib/agentModels";
import { useEffect, useState } from "react";
import { useT } from "../../i18n/react";
import SheetSelect from "../ui/SheetSelect";

type Props = {
  /** Selected model id, or "" for agent default. */
  value: string;
  models: AgentModelOption[];
  source?: "configured" | "discovered" | "recommended" | "none";
  status?: "available" | "default_only" | "unavailable";
  /** When true, picker is display-only (session locked). */
  locked?: boolean;
  disabled?: boolean;
  /** Single-row footer: hide labels / secondary hints. */
  compact?: boolean;
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
  compact,
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

  const sourceLabel =
    source && source !== "none"
      ? tr(`modelPicker.source.${source}`)
      : status === "default_only"
        ? tr("modelPicker.defaultOnly")
        : "";

  if (compact) {
    const options = [
      { id: "", label: tr("modelPicker.default") },
      ...models.map((m) => ({
        id: m.id,
        label: `${modelPickerLabel(m)}${m.tier ? ` · ${m.tier}` : ""}`,
      })),
      { id: "__custom__", label: tr("modelPicker.custom") },
    ];
    const display = custom || currentIsCustom ? current || tr("modelPicker.custom") : undefined;
    return (
      <div className="flex items-center gap-1.5 flex-none">
        <SheetSelect
          label={tr("modelPicker.label")}
          // The sentinel, not the raw id: a custom model matches no option, and
          // picking "Custom" stores "" — which would mark the *Default* row as
          // current while the chip reads "Custom". The desktop `<select>` below
          // already maps this way; the sheet has to agree with it.
          value={custom || currentIsCustom ? "__custom__" : current}
          display={display}
          options={options}
          disabled={readOnly}
          onChange={(id) => {
            if (id === "__custom__") {
              setCustom(true);
              onChange("");
            } else {
              setCustom(false);
              onChange(id);
            }
          }}
          className="text-kin-secondary"
        />
        {(custom || currentIsCustom) && !readOnly && (
          <input
            className="w-28 px-1.5 py-0.5 text-caption rounded-lg border border-[var(--kin-hairline-strong)] bg-transparent text-kin-secondary focus:outline-none focus:ring-1 focus:ring-kin-focus-ring"
            value={current}
            placeholder={tr("modelPicker.customPlaceholder")}
            aria-label={tr("modelPicker.customLabel")}
            onChange={(e) => onChange(e.target.value)}
          />
        )}
        {currentIsCustom && readOnly && (
          <span className="text-caption text-kin-secondary truncate">{current}</span>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className="text-caption text-kin-muted flex-none">{tr("modelPicker.label")}</span>
      <select
        className={[
          "max-w-[14rem] truncate rounded-lg border border-[var(--kin-hairline-strong)]",
          "bg-transparent px-2 py-1 text-caption font-medium text-kin-secondary",
          "focus:outline-none focus:ring-1 focus:ring-kin-focus-ring",
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
          className="w-44 px-2 py-1 text-caption rounded-lg border border-[var(--kin-hairline-strong)] bg-transparent text-kin-secondary focus:outline-none focus:ring-1 focus:ring-kin-focus-ring"
          value={current}
          placeholder={tr("modelPicker.customPlaceholder")}
          aria-label={tr("modelPicker.customLabel")}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {currentIsCustom && readOnly && (
        <span className="text-caption text-kin-secondary truncate">{current}</span>
      )}
      {sourceLabel && <span className="text-caption text-kin-muted truncate">{sourceLabel}</span>}
      {locked && (
        <span className="text-caption text-kin-muted truncate">
          {tr("modelPicker.sessionHint")}
        </span>
      )}
    </div>
  );
}
