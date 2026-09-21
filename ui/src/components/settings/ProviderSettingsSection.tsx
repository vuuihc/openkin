import { Link } from "react-router-dom";
import type { AgentInfo, ModelSpec, ProviderEntry } from "../../api/client";
import { useT } from "../../i18n/react";
import {
  agentCatalogState,
  runnableAgents,
  sortAgentCatalog,
} from "../../lib/agentCatalog";
import { SettingsTabPanel } from "./SettingsPrimitives";

export function providerDisplayName(provider: ProviderEntry): string {
  return provider.name || provider.model || provider.id;
}

export function providerSummary(provider: ProviderEntry): string {
  return `${provider.model}${provider.base_url ? ` · ${provider.base_url}` : ""}`;
}

export function ProviderSettingsSection({
  active,
  providers,
  activeProviderId,
  providerBusy,
  editingId,
  providerName,
  providerBaseUrl,
  providerApiKey,
  providerModel,
  providerStream,
  revealApiKey,
  providerModelOptions,
  providerModelLoading,
  providerModelError,
  showRouting,
  providerSupportsAgents,
  providerModels,
  agentDefault,
  agentList,
  settingsBusy,
  onAddProvider,
  onActivateProvider,
  onEditProvider,
  onDeleteProvider,
  onProviderNameChange,
  onProviderBaseUrlChange,
  onProviderApiKeyChange,
  onProviderApiKeyDirty,
  onProviderModelChange,
  onProviderStreamChange,
  onToggleApiKeyReveal,
  onFetchProviderModels,
  onToggleRouting,
  onProviderSupportsAgentsChange,
  onProviderModelsChange,
  onCloseProviderForm,
  onSaveProvider,
  onAgentDefaultChange,
  onSaveSettings,
}: {
  active: boolean;
  providers: ProviderEntry[];
  activeProviderId: string;
  providerBusy: boolean;
  editingId: string | null;
  providerName: string;
  providerBaseUrl: string;
  providerApiKey: string;
  providerModel: string;
  providerStream: boolean;
  revealApiKey: boolean;
  providerModelOptions: string[];
  providerModelLoading: boolean;
  providerModelError: string | null;
  showRouting: boolean;
  providerSupportsAgents: string;
  providerModels: ModelSpec[];
  agentDefault: string;
  agentList: AgentInfo[];
  settingsBusy: boolean;
  onAddProvider: () => void;
  onActivateProvider: (id: string) => void;
  onEditProvider: (provider: ProviderEntry) => void;
  onDeleteProvider: (id: string) => void;
  onProviderNameChange: (value: string) => void;
  onProviderBaseUrlChange: (value: string) => void;
  onProviderApiKeyChange: (value: string) => void;
  onProviderApiKeyDirty: (dirty: boolean) => void;
  onProviderModelChange: (value: string) => void;
  onProviderStreamChange: (value: boolean) => void;
  onToggleApiKeyReveal: () => void;
  onFetchProviderModels: () => void;
  onToggleRouting: () => void;
  onProviderSupportsAgentsChange: (value: string) => void;
  onProviderModelsChange: (models: ModelSpec[]) => void;
  onCloseProviderForm: () => void;
  onSaveProvider: () => void;
  onAgentDefaultChange: (value: string) => void;
  onSaveSettings: () => void;
}) {
  const tr = useT();

  const updateModel = (index: number, update: Partial<ModelSpec>) => {
    const next = [...providerModels];
    next[index] = { ...next[index], ...update };
    onProviderModelsChange(next);
  };

  return (
    <SettingsTabPanel id="providers" active={active}>
      <section className="rounded-xl border border-[var(--kin-hairline)] bg-kin-elevated/60 p-4 space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1 min-w-0">
            <h2 className="text-[11px] font-semibold uppercase tracking-wide text-kin-muted">
              {tr("settings.provider.heading")}
            </h2>
            <p className="text-[12px] text-kin-secondary leading-relaxed">
              {tr("settings.provider.descA")}
              <code className="text-[11px] px-1 rounded bg-[var(--kin-fill)]">kin</code>
              {tr("settings.provider.descB")}
            </p>
          </div>
          <button
            type="button"
            disabled={providerBusy}
            onClick={onAddProvider}
            className="kin-btn-secondary w-full shrink-0 disabled:opacity-50 sm:w-auto"
          >
            {tr("settings.provider.add")}
          </button>
        </div>

        {providers.length === 0 ? (
          <p className="text-[13px] text-kin-muted">{tr("settings.provider.empty")}</p>
        ) : (
          <ul className="space-y-2">
            {providers.map((provider) => {
              const isActive = provider.id === activeProviderId || provider.active;
              return (
                <li
                  key={provider.id}
                  className={[
                    "rounded-lg border p-3 flex flex-col sm:flex-row sm:items-center gap-3",
                    isActive
                      ? "border-kin-blue bg-kin-blue-soft/40"
                      : "border-[var(--kin-hairline)] bg-[var(--kin-fill)]/40",
                  ].join(" ")}
                >
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[13px] font-medium truncate">
                        {providerDisplayName(provider)}
                      </span>
                      {isActive ? (
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-kin-blue">
                          {tr("settings.provider.activeBadge")}
                        </span>
                      ) : null}
                    </div>
                    <p className="text-[11px] text-kin-muted font-mono truncate">
                      {providerSummary(provider)}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2 shrink-0">
                    {!isActive ? (
                      <button
                        type="button"
                        disabled={providerBusy}
                        onClick={() => onActivateProvider(provider.id)}
                        className="kin-btn-secondary text-[12px] min-h-[36px] disabled:opacity-50"
                      >
                        {tr("settings.provider.use")}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={providerBusy}
                      onClick={() => onEditProvider(provider)}
                      className="kin-btn-secondary text-[12px] min-h-[36px] disabled:opacity-50"
                    >
                      {tr("settings.provider.edit")}
                    </button>
                    <button
                      type="button"
                      disabled={providerBusy}
                      onClick={() => onDeleteProvider(provider.id)}
                      className="kin-btn-secondary text-[12px] min-h-[36px] text-kin-red disabled:opacity-50"
                    >
                      {tr("settings.provider.delete")}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {editingId !== null ? (
          <div className="rounded-lg border border-[var(--kin-hairline)] p-3 space-y-3 bg-kin-elevated">
            <h3 className="text-[12px] font-semibold text-kin-secondary">
              {editingId
                ? tr("settings.provider.editHeading")
                : tr("settings.provider.addHeading")}
            </h3>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-kin-secondary">
                {tr("settings.provider.name")}
              </span>
              <input
                type="text"
                value={providerName}
                onChange={(event) => onProviderNameChange(event.target.value)}
                placeholder={tr("settings.provider.namePlaceholder")}
                className="kin-input min-h-[44px]"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-kin-secondary">
                {tr("settings.provider.baseUrl")}
              </span>
              <input
                type="url"
                value={providerBaseUrl}
                onChange={(event) => onProviderBaseUrlChange(event.target.value)}
                placeholder="https://api.openai.com/v1 · http://127.0.0.1:8317/v1"
                className="kin-input min-h-[44px] font-mono text-xs"
                autoComplete="off"
              />
              <span className="text-[11px] text-kin-muted">
                {tr("settings.provider.baseUrlHintA")}
                <code className="text-[10px]">/v1</code>
                {tr("settings.provider.baseUrlHintB")}
              </span>
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-kin-secondary">
                {tr("settings.provider.apiKey")}
              </span>
              <div className="flex gap-2">
                <input
                  type={revealApiKey ? "text" : "password"}
                  value={providerApiKey}
                  onChange={(event) => {
                    onProviderApiKeyChange(event.target.value);
                    onProviderApiKeyDirty(true);
                  }}
                  className="kin-input min-h-[44px] font-mono text-xs flex-1"
                  autoComplete="off"
                />
                <button
                  type="button"
                  className="kin-btn-secondary shrink-0"
                  onClick={onToggleApiKeyReveal}
                >
                  {revealApiKey ? tr("settings.hide") : tr("settings.reveal")}
                </button>
              </div>
              <span className="text-[11px] text-kin-muted">
                {tr("settings.provider.apiKeyHint")}
              </span>
            </label>
            <label className="block space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-kin-secondary">
                  {tr("settings.provider.model")}
                </span>
                <button
                  type="button"
                  disabled={providerModelLoading}
                  onClick={onFetchProviderModels}
                  className="text-[11px] text-kin-blue hover:underline disabled:opacity-50 shrink-0"
                >
                  {providerModelLoading
                    ? tr("settings.provider.modelsFetching")
                    : tr("settings.provider.modelsFetch")}
                </button>
              </div>
              <input
                type="text"
                list="provider-model-options"
                value={providerModel}
                onChange={(event) => onProviderModelChange(event.target.value)}
                placeholder="gpt-4.1-mini · grok-3 · llama3.2"
                className="kin-input min-h-[44px] font-mono text-xs"
              />
              <datalist id="provider-model-options">
                {providerModelOptions.map((model) => (
                  <option key={model} value={model} />
                ))}
              </datalist>
              {providerModelError ? (
                <span className="block text-[11px] text-kin-red">{providerModelError}</span>
              ) : null}
              {providerModelOptions.length > 0 ? (
                <select
                  value=""
                  onChange={(event) => {
                    if (event.target.value) onProviderModelChange(event.target.value);
                  }}
                  className="kin-input min-h-[40px] text-xs mt-1"
                >
                  <option value="">
                    {tr("settings.provider.modelsPick").replace(
                      "{count}",
                      String(providerModelOptions.length),
                    )}
                  </option>
                  {providerModelOptions.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
              ) : null}
            </label>
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={providerStream}
                onChange={(event) => onProviderStreamChange(event.target.checked)}
                className="mt-1"
              />
              <span className="space-y-0.5">
                <span className="block text-xs font-medium text-kin-secondary">
                  {tr("settings.provider.stream")}
                </span>
                <span className="block text-[11px] text-kin-muted">
                  {tr("settings.provider.streamHint")}
                </span>
              </span>
            </label>
            <div className="border-t border-[var(--kin-hairline)] pt-2">
              <button
                type="button"
                onClick={onToggleRouting}
                className="flex items-center gap-1 text-xs font-medium text-kin-secondary hover:text-kin-blue"
              >
                <span className={`transition-transform ${showRouting ? "rotate-90" : ""}`}>
                  ▸
                </span>
                {tr("settings.routing.heading")}
              </button>
              {showRouting && (
                <div className="mt-2 space-y-3">
                  <label className="block space-y-1">
                    <span className="text-xs font-medium text-kin-secondary">
                      {tr("settings.routing.supportsAgents")}
                    </span>
                    <input
                      type="text"
                      value={providerSupportsAgents}
                      onChange={(event) => onProviderSupportsAgentsChange(event.target.value)}
                      className="kin-input min-h-[40px] font-mono text-xs"
                      placeholder="claude-code, kin, codex"
                    />
                    <span className="text-[10px] text-kin-muted">
                      {tr("settings.provider.supportsAgentsHint")}
                    </span>
                  </label>
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-kin-secondary">
                        {tr("settings.routing.models")}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          onProviderModelsChange([
                            ...providerModels,
                            { id: "", tier: "balanced", cost_label: "unknown" },
                          ])
                        }
                        className="text-[11px] text-kin-blue hover:underline"
                      >
                        {tr("settings.routing.addModel")}
                      </button>
                    </div>
                    {providerModels.map((model, index) => (
                      <div
                        key={index}
                        className="rounded border border-[var(--kin-hairline)] p-2 space-y-1.5"
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] font-mono text-kin-muted">
                            {tr("settings.provider.modelLabel", { index: index + 1 })}
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              onProviderModelsChange(
                                providerModels.filter((_, modelIndex) => modelIndex !== index),
                              )
                            }
                            className="text-[10px] text-kin-red hover:underline"
                          >
                            {tr("settings.provider.removeModel")}
                          </button>
                        </div>
                        <input
                          type="text"
                          value={model.id}
                          onChange={(event) => updateModel(index, { id: event.target.value })}
                          className="kin-input min-h-[32px] text-xs font-mono"
                          placeholder="claude-sonnet-4-20250514"
                        />
                        <div className="flex gap-2">
                          <select
                            value={model.tier}
                            onChange={(event) => updateModel(index, { tier: event.target.value })}
                            className="kin-input min-h-[32px] text-xs flex-1"
                          >
                            <option value="smart">{tr("settings.provider.tierSmart")}</option>
                            <option value="balanced">{tr("settings.provider.tierBalanced")}</option>
                            <option value="fast">{tr("settings.provider.tierFast")}</option>
                            <option value="free">{tr("settings.provider.tierFree")}</option>
                          </select>
                          <select
                            value={model.cost_label}
                            onChange={(event) =>
                              updateModel(index, { cost_label: event.target.value })
                            }
                            className="kin-input min-h-[32px] text-xs flex-1"
                          >
                            <option value="paid">{tr("settings.provider.costPaid")}</option>
                            <option value="company">{tr("settings.provider.costCompany")}</option>
                            <option value="free">{tr("settings.provider.costFree")}</option>
                            <option value="unknown">{tr("settings.provider.costUnknown")}</option>
                          </select>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={providerBusy}
                onClick={onSaveProvider}
                className="kin-btn-primary disabled:opacity-50"
              >
                {providerBusy ? tr("settings.saving") : tr("settings.provider.saveEntry")}
              </button>
              <button
                type="button"
                disabled={providerBusy}
                onClick={onCloseProviderForm}
                className="kin-btn-secondary disabled:opacity-50"
              >
                {tr("settings.provider.cancel")}
              </button>
            </div>
          </div>
        ) : null}

        <label className="block space-y-1">
          <span className="text-xs font-medium text-kin-secondary">
            {tr("settings.provider.defaultAgent")}
          </span>
          <select
            value={agentDefault}
            onChange={(event) => onAgentDefaultChange(event.target.value)}
            className="kin-input min-h-[44px]"
          >
            <option value="">{tr("settings.provider.autoOption")}</option>
            {sortAgentCatalog(runnableAgents(agentList)).map((agent) => {
              const state = agentCatalogState(agent);
              let suffix = "";
              if (agent.default) {
                suffix = tr("settings.provider.currentDefault").replace(/^\s*—\s*/, "");
              } else if (state === "generic") {
                suffix = tr("agentCatalog.generic");
              }
              return (
                <option key={agent.id} value={agent.id}>
                  {agent.name} ({agent.id})
                  {suffix ? ` — ${suffix}` : ""}
                </option>
              );
            })}
          </select>
          <span className="text-[11px] text-kin-muted">
            {tr("settings.provider.defaultAgentHint")}
          </span>
          {agentList.some((agent) => !agent.available) ? (
            <Link to="/agents" className="text-[11px] text-kin-blue hover:underline pt-1">
              {tr("agents.manageLink")}
            </Link>
          ) : null}
        </label>
        <button
          type="button"
          disabled={settingsBusy}
          onClick={onSaveSettings}
          className="kin-btn-primary disabled:opacity-50"
        >
          {settingsBusy ? tr("settings.saving") : tr("settings.provider.save")}
        </button>
      </section>
    </SettingsTabPanel>
  );
}
