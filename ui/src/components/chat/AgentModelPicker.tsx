import { useEffect, useState } from "react";
import type { AgentInfo } from "../../api/client";
import { useT } from "../../i18n/react";
import { agentCatalogState } from "../../lib/agentCatalog";
import { agentAvatarMeta } from "../../lib/agentMention";
import {
  isListedModel,
  modelPickTarget,
  modelPickerOptions,
  modelPickerSelection,
  type AgentModelOption,
} from "../../lib/agentModels";
import SearchSelect from "../ui/SearchSelect";

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

  const modelOptions = modelPickerOptions(models, {
    default: tr("modelPicker.default"),
    custom: tr("modelPicker.custom"),
  });
  // The sentinel, not the raw id — see `modelPickerSelection`.
  const modelSelection = modelPickerSelection(currentModel, custom || currentIsCustom);

  return (
    <div className={["flex items-center min-w-0 gap-1.5", className].filter(Boolean).join(" ")}>
      {/* No `overflow-hidden`: the joined control's radius is drawn by its own
          border, and clipping the children clipped the pickers' panels at the
          control's edge — a 47-model list that opened into a 30px slot. */}
      <div className="inline-flex items-center min-w-0 rounded-lg border border-[var(--kin-hairline-strong)]">
        {agents.length > 1 ? (
          <SearchSelect
            className="max-w-[7.5rem] text-kin-secondary"
            bordered={false}
            label={tr("newChat.hostPicker")}
            value={agentValue}
            options={agents.map((a) => {
              const meta = agentAvatarMeta(a.id);
              return {
                id: a.id,
                label: a.name,
                // One row per agent carries the same tile the transcript draws
                // beside its messages, so the picker and the conversation name
                // the same agent the same way.
                leading: (
                  <span
                    // The tile is the agent's face, not its name: the row
                    // already says "Claude Code", and the initials would be
                    // read as a stray letter before it.
                    aria-hidden
                    className={`flex h-5 w-5 items-center justify-center rounded-md text-micro font-semibold ${meta.className}`}
                  >
                    {meta.initials}
                  </span>
                ),
              };
            })}
            onChange={onAgentChange}
            disabled={disabled}
            placement="top"
          />
        ) : (
          <span
            className="max-w-[7.5rem] truncate px-1.5 py-0.5 text-body font-medium text-kin-secondary sm:text-caption"
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
        <SearchSelect
          className="max-w-[7.5rem] text-kin-secondary"
          bordered={false}
          label={tr("modelPicker.label")}
          value={modelSelection}
          display={custom || currentIsCustom ? tr("modelPicker.custom") : undefined}
          title={
            custom || currentIsCustom
              ? currentModel || tr("modelPicker.custom")
              : currentModel || tr("modelPicker.defaultHint")
          }
          options={modelOptions}
          disabled={disabled}
          placement="top"
          searchable
          searchPlaceholder={tr("modelPicker.searchPlaceholder")}
          emptyLabel={tr("modelPicker.searchEmpty")}
          onChange={(id) => {
            const next = modelPickTarget(id);
            setCustom(next.custom);
            onModelChange(next.value);
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
