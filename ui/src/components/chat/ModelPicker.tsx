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

  return (
    <div
      className={[
        "flex items-center",
        // In a strip that scrolls, an item that can shrink shrinks to nothing
        // first and then paints its contents over the chip beside it — the row
        // has to overflow for the scroll to be the thing that gives.
        compact ? "gap-1.5 flex-none" : "gap-2 min-w-0",
      ].join(" ")}
    >
      {!compact && (
        <span className="text-caption text-kin-muted flex-none">{tr("modelPicker.label")}</span>
      )}
      <select
        className={[
          compact ? "max-w-[9.5rem]" : "max-w-[14rem]",
          "truncate rounded-lg border border-[var(--kin-hairline-strong)]",
          compact
            ? "bg-transparent px-1.5 py-0.5 text-caption font-medium text-kin-secondary"
            : "bg-transparent px-2 py-1 text-caption font-medium text-kin-secondary",
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
          className={[
            compact ? "w-28 px-1.5 py-0.5 text-caption" : "w-44 px-2 py-1 text-caption",
            "rounded-lg border border-[var(--kin-hairline-strong)] bg-transparent text-kin-secondary focus:outline-none focus:ring-1 focus:ring-kin-focus-ring",
          ].join(" ")}
          value={current}
          placeholder={tr("modelPicker.customPlaceholder")}
          aria-label={tr("modelPicker.customLabel")}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {currentIsCustom && readOnly && (
        <span className="text-caption text-kin-secondary truncate">{current}</span>
      )}
      {sourceLabel && !compact && (
        <span className="text-caption text-kin-muted truncate">{sourceLabel}</span>
      )}
      {locked && !compact && (
        <span className="text-caption text-kin-muted truncate">
          {tr("modelPicker.sessionHint")}
        </span>
      )}
    </div>
  );
}
