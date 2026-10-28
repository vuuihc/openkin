import { useEffect, useState } from "react";
import type { AgentInfo } from "../../api/client";
import { useT } from "../../i18n/react";
import { agentCatalogState } from "../../lib/agentCatalog";
import { isListedModel, modelPickerLabel, type AgentModelOption } from "../../lib/agentModels";
import SheetSelect from "../ui/SheetSelect";

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
          <>
            {/* Two shapes of one control, split at `sm`: a native `<select>`
                opens a system wheel that ignores the console's theme, and its
                closed state is a grey box — fine under a mouse, wrong on the
                phone the composer is most used from. The sheet pair below is
                the same choice in the console's own surface, and it is the
                primitive the model picker and the permission picker already
                use. Both carry the same label; the hidden one leaves the
                accessibility tree with `display:none`. */}
            <select
              className="hidden sm:block max-w-[7.5rem] truncate bg-transparent px-1.5 py-0.5 text-caption font-medium text-kin-secondary focus:outline-none focus:ring-1 focus:ring-inset focus:ring-kin-focus-ring disabled:opacity-70 disabled:cursor-default cursor-pointer hover:text-kin-text"
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
            <SheetSelect
              className="sm:hidden max-w-[7.5rem] px-1.5 text-kin-secondary"
              bordered={false}
              label={tr("newChat.hostPicker")}
              value={agentValue}
              options={agents.map((a) => ({ id: a.id, label: a.name }))}
              onChange={onAgentChange}
              disabled={disabled}
            />
          </>
        ) : (
          <span
            className="max-w-[7.5rem] truncate px-1.5 py-0.5 text-caption font-medium text-kin-secondary"
            title={selected?.name}
          >
            {selected?.name}
          </span>
        )}
        {generic && (
          <span
            className="flex-none pr-1.5 text-micro text-kin-muted"
            title={tr("agentCatalog.genericHint")}
          >
            {tr("agentCatalog.generic")}
          </span>
        )}
        <span className="w-px self-stretch bg-[var(--kin-hairline-strong)]" aria-hidden />
        <select
          className="hidden sm:block max-w-[7.5rem] truncate bg-transparent px-1.5 py-0.5 text-caption font-medium text-kin-secondary focus:outline-none focus:ring-1 focus:ring-inset focus:ring-kin-focus-ring disabled:opacity-70 disabled:cursor-default cursor-pointer hover:text-kin-text"
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
        <SheetSelect
          className="sm:hidden max-w-[7.5rem] px-1.5 text-kin-secondary"
          bordered={false}
          label={tr("modelPicker.label")}
          value={custom || currentIsCustom ? "__custom__" : currentModel}
          display={custom || currentIsCustom ? tr("modelPicker.custom") : undefined}
          options={[
            { id: "", label: tr("modelPicker.default") },
            ...models.map((m) => ({
              id: m.id,
              label: `${modelPickerLabel(m)}${m.tier ? ` · ${m.tier}` : ""}`,
            })),
            { id: "__custom__", label: tr("modelPicker.custom") },
          ]}
          disabled={disabled}
          onChange={(id) => {
            if (id === "__custom__") {
              setCustom(true);
              onModelChange("");
            } else {
              setCustom(false);
              onModelChange(id);
            }
          }}
        />
      </div>
      {(custom || currentIsCustom) && (
        <input
          className="w-28 px-1.5 py-0.5 text-caption rounded-lg border border-[var(--kin-hairline-strong)] bg-transparent text-kin-secondary focus:outline-none focus:ring-1 focus:ring-kin-focus-ring"
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
