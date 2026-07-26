import { useEffect, useState } from "react";
import type { AgentInfo } from "../../api/client";
import { useT } from "../../i18n/react";
import { agentCatalogState } from "../../lib/agentCatalog";
import { isListedModel, modelPickerLabel, type AgentModelOption } from "../../lib/agentModels";

type Props = {
  /** Available (installed + usable) agents to host the session. */
  agents: AgentInfo[];
  agentValue: string;
  onAgentChange: (id: string) => void;
  modelValue: string;
  models: AgentModelOption[];
  onModelChange: (id: string) => void;
  disabled?: boolean;
  className?: string;
};

/**
 * Cascading Agent → Model control for the composer footer: pick the host
 * agent, then a model scoped to that agent, in one joined control instead
 * of a separate hero picker + standalone model dropdown.
 */
export default function AgentModelPicker({
  agents,
  agentValue,
  onAgentChange,
  modelValue,
  models,
  onModelChange,
  disabled,
  className,
}: Props) {
  const tr = useT();
  const selected = agents.find((a) => a.id === agentValue);
  const generic = selected ? agentCatalogState(selected) === "generic" : false;

  const currentModel = modelValue.trim();
  const currentIsCustom = Boolean(currentModel) && !isListedModel(models, currentModel);
  const [custom, setCustom] = useState(currentIsCustom);
  useEffect(() => {
    if (currentIsCustom) setCustom(true);
    else if (currentModel) setCustom(false);
  }, [currentIsCustom, currentModel]);

  return (
    <div className={["flex items-center min-w-0 gap-1.5", className].filter(Boolean).join(" ")}>
      <div className="inline-flex items-center min-w-0 rounded-lg border border-[var(--kin-hairline-strong)] overflow-hidden">
        {agents.length > 1 ? (
          <select
            className="max-w-[7.5rem] truncate bg-transparent px-1.5 py-0.5 text-[11px] font-medium text-kin-secondary focus:outline-none focus:ring-1 focus:ring-inset focus:ring-kin-blue/40 disabled:opacity-70 disabled:cursor-default cursor-pointer hover:text-kin-text"
            value={agentValue}
            disabled={disabled}
            aria-label={tr("newChat.hostPicker")}
            title={selected?.name}
            onChange={(e) => onAgentChange(e.target.value)}
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        ) : (
          <span
            className="max-w-[7.5rem] truncate px-1.5 py-0.5 text-[11px] font-medium text-kin-secondary"
            title={selected?.name}
          >
            {selected?.name}
          </span>
        )}
        {generic && (
          <span
            className="flex-none pr-1.5 text-[10px] text-kin-muted"
            title={tr("agentCatalog.genericHint")}
          >
            {tr("agentCatalog.generic")}
          </span>
        )}
        <span className="w-px self-stretch bg-[var(--kin-hairline-strong)]" aria-hidden />
        <select
          className="max-w-[7.5rem] truncate bg-transparent px-1.5 py-0.5 text-[11px] font-medium text-kin-secondary focus:outline-none focus:ring-1 focus:ring-inset focus:ring-kin-blue/40 disabled:opacity-70 disabled:cursor-default cursor-pointer hover:text-kin-text"
          value={custom || currentIsCustom ? "__custom__" : currentModel}
          disabled={disabled}
          aria-label={tr("modelPicker.label")}
          title={currentModel || tr("modelPicker.defaultHint")}
          onChange={(e) => {
            if (e.target.value === "__custom__") {
              setCustom(true);
              onModelChange("");
            } else {
              setCustom(false);
              onModelChange(e.target.value);
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
      </div>
      {(custom || currentIsCustom) && (
        <input
          className="w-28 px-1.5 py-0.5 text-[11px] rounded-lg border border-[var(--kin-hairline-strong)] bg-transparent text-kin-secondary focus:outline-none focus:ring-1 focus:ring-kin-blue/40"
          value={currentModel}
          disabled={disabled}
          placeholder={tr("modelPicker.customPlaceholder")}
          aria-label={tr("modelPicker.customLabel")}
          onChange={(e) => onModelChange(e.target.value)}
        />
      )}
    </div>
  );
}
