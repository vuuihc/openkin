import { Link, useLocation, useNavigate } from "react-router-dom";
import type { AgentInfo, ModelSpec, ProviderEntry } from "../../api/client";
import { useT } from "../../i18n/react";
import { agentCatalogState, runnableAgents, sortAgentCatalog } from "../../lib/agentCatalog";
import { onGuardedLinkClick } from "../../lib/phoneNavigation";
import Button from "../ui/Button";
import SearchSelect from "../ui/SearchSelect";
import TextInput from "../ui/TextInput";
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
  const navigate = useNavigate();
  const location = useLocation();

  const updateModel = (index: number, update: Partial<ModelSpec>) => {
    const next = [...providerModels];
    next[index] = { ...next[index], ...update };
    onProviderModelsChange(next);
  };

  return (
    <SettingsTabPanel id="providers" active={active}>
      <section className="rounded-xl bg-kin-elevated/60 p-4 space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1 min-w-0">
            <h2 className="text-caption font-semibold uppercase tracking-label text-kin-muted">
              {tr("settings.provider.heading")}
            </h2>
            <p className="text-body text-kin-secondary leading-prose">
              {tr("settings.provider.descA")}
              <code className="text-caption px-1 rounded bg-[var(--kin-fill)]">kin</code>
              {tr("settings.provider.descB")}
            </p>
          </div>
          <Button
            variant="secondary"
            disabled={providerBusy}
            onClick={onAddProvider}
            className="w-full shrink-0 sm:w-auto"
          >
            {tr("settings.provider.add")}
          </Button>
        </div>

        {providers.length === 0 ? (
          <p className="text-strong text-kin-muted">{tr("settings.provider.empty")}</p>
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
                      ? "border-kin-blue/60 bg-kin-blue/15"
                      : "border-[var(--kin-hairline)] bg-[var(--kin-fill)]",
                  ].join(" ")}
                >
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-strong font-medium truncate">
                        {providerDisplayName(provider)}
                      </span>
                      {isActive ? (
                        <span className="text-micro font-semibold uppercase tracking-label text-kin-blue-ink">
                          {tr("settings.provider.activeBadge")}
                        </span>
                      ) : null}
                    </div>
                    <p className="text-caption text-kin-muted font-mono truncate">
                      {providerSummary(provider)}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2 shrink-0">
                    {!isActive ? (
                      <Button
                        variant="secondary"
                        disabled={providerBusy}
                        onClick={() => onActivateProvider(provider.id)}
                        className="text-body"
                      >
                        {tr("settings.provider.use")}
                      </Button>
                    ) : null}
                    <Button
                      variant="secondary"
                      disabled={providerBusy}
                      onClick={() => onEditProvider(provider)}
                      className="text-body"
                    >
                      {tr("settings.provider.edit")}
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={providerBusy}
                      onClick={() => onDeleteProvider(provider.id)}
                      className="text-body text-kin-red-ink"
                    >
                      {tr("settings.provider.delete")}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {editingId !== null ? (
          <div className="rounded-lg border border-[var(--kin-hairline)] p-3 space-y-3 bg-kin-elevated">
            <h3 className="text-body font-semibold text-kin-secondary">
              {editingId ? tr("settings.provider.editHeading") : tr("settings.provider.addHeading")}
            </h3>
            <TextInput
              label={tr("settings.provider.name")}
              value={providerName}
              onChange={(event) => onProviderNameChange(event.target.value)}
              placeholder={tr("settings.provider.namePlaceholder")}
            />
            <TextInput
              type="url"
              label={tr("settings.provider.baseUrl")}
              value={providerBaseUrl}
              onChange={(event) => onProviderBaseUrlChange(event.target.value)}
              placeholder="https://api.openai.com/v1 · http://127.0.0.1:8317/v1"
              className="font-mono text-body leading-4"
              autoComplete="off"
              hint={
                <>
                  {tr("settings.provider.baseUrlHintA")}
                  <code className="text-micro">/v1</code>
                  {tr("settings.provider.baseUrlHintB")}
                </>
              }
            />
            <div className="block space-y-1">
              {/* The label and the hint stay outside the flex row so the
                  reveal button sits beside the input, not beside the label;
                  the field carries the same words as its hidden label. */}
              <span className="text-body leading-4 font-medium text-kin-secondary">
                {tr("settings.provider.apiKey")}
              </span>
              <div className="flex gap-2">
                <div className="min-w-0 flex-1">
                  <TextInput
                    isLabelHidden
                    label={tr("settings.provider.apiKey")}
                    type={revealApiKey ? "text" : "password"}
                    value={providerApiKey}
                    onChange={(event) => {
                      onProviderApiKeyChange(event.target.value);
                      onProviderApiKeyDirty(true);
                    }}
                    className="font-mono text-body leading-4 flex-1"
                    autoComplete="off"
                  />
                </div>
                <Button variant="secondary" className="shrink-0" onClick={onToggleApiKeyReveal}>
                  {revealApiKey ? tr("settings.hide") : tr("settings.reveal")}
                </Button>
              </div>
              <span className="text-caption text-kin-muted">
                {tr("settings.provider.apiKeyHint")}
              </span>
            </div>
            <div className="block space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-body leading-4 font-medium text-kin-secondary">
                  {tr("settings.provider.model")}
                </span>
                <Button
                  variant="quiet"
                  disabled={providerModelLoading}
                  onClick={onFetchProviderModels}
                  className="shrink-0 text-caption text-kin-blue-ink!"
                >
                  {providerModelLoading
                    ? tr("settings.provider.modelsFetching")
                    : tr("settings.provider.modelsFetch")}
                </Button>
              </div>
              <TextInput
                isLabelHidden
                label={tr("settings.provider.model")}
                type="text"
                list="provider-model-options"
                value={providerModel}
                onChange={(event) => onProviderModelChange(event.target.value)}
                placeholder="gpt-4.1-mini · grok-3 · llama3.2"
                className="font-mono text-body leading-4"
              />
              <datalist id="provider-model-options">
                {providerModelOptions.map((model) => (
                  <option key={model} value={model} />
                ))}
              </datalist>
              {providerModelError ? (
                <span className="block text-caption text-kin-red-ink">{providerModelError}</span>
              ) : null}
              {providerModelOptions.length > 0 ? (
                <SearchSelect
                  variant="field"
                  searchable
                  className="mt-1 text-body"
                  label={tr("settings.provider.model")}
                  value=""
                  display={tr("settings.provider.modelsPick").replace(
                    "{count}",
                    String(providerModelOptions.length),
                  )}
                  options={providerModelOptions.map((model) => ({ id: model, label: model }))}
                  onChange={onProviderModelChange}
                />
              ) : null}
            </div>
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={providerStream}
                onChange={(event) => onProviderStreamChange(event.target.checked)}
                className="mt-1"
              />
              <span className="space-y-0.5">
                <span className="block text-body leading-4 font-medium text-kin-secondary">
                  {tr("settings.provider.stream")}
                </span>
                <span className="block text-caption text-kin-muted">
                  {tr("settings.provider.streamHint")}
                </span>
              </span>
            </label>
            <div className="border-t border-[var(--kin-hairline)] pt-2">
              <button
                type="button"
                aria-expanded={showRouting}
                onClick={onToggleRouting}
                className="flex items-center gap-1 text-body leading-4 font-medium text-kin-secondary hover:text-kin-blue-ink"
              >
                <span className={`transition-transform ${showRouting ? "rotate-90" : ""}`}>▸</span>
                {tr("settings.routing.heading")}
              </button>
              {showRouting && (
                <div className="mt-2 space-y-3">
                  <div className="space-y-1">
                    <TextInput
                      label={tr("settings.routing.supportsAgents")}
                      value={providerSupportsAgents}
                      onChange={(event) => onProviderSupportsAgentsChange(event.target.value)}
                      className="min-h-10 font-mono text-body leading-4"
                      placeholder="claude-code, kin, codex"
                    />
                    {/* `text-micro`, which the field's caption-sized hint
                        would not preserve. */}
                    <span className="text-micro text-kin-muted">
                      {tr("settings.provider.supportsAgentsHint")}
                    </span>
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-body leading-4 font-medium text-kin-secondary">
                        {tr("settings.routing.models")}
                      </span>
                      <Button
                        variant="quiet"
                        onClick={() =>
                          onProviderModelsChange([
                            ...providerModels,
                            { id: "", tier: "balanced", cost_label: "unknown" },
                          ])
                        }
                        className="text-caption text-kin-blue-ink!"
                      >
                        {tr("settings.routing.addModel")}
                      </Button>
                    </div>
                    {providerModels.map((model, index) => (
                      <div
                        key={index}
                        className="rounded border border-[var(--kin-hairline)] p-2 space-y-1.5"
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-micro font-mono text-kin-muted">
                            {tr("settings.provider.modelLabel", { index: index + 1 })}
                          </span>
                          <Button
                            variant="quiet-danger"
                            onClick={() =>
                              onProviderModelsChange(
                                providerModels.filter((_, modelIndex) => modelIndex !== index),
                              )
                            }
                            className="text-micro"
                          >
                            {tr("settings.provider.removeModel")}
                          </Button>
                        </div>
                        <TextInput
                          isLabelHidden
                          label={tr("settings.provider.modelLabel", { index: index + 1 })}
                          value={model.id}
                          onChange={(event) => updateModel(index, { id: event.target.value })}
                          className="min-h-8 text-body leading-4 font-mono"
                          placeholder="claude-sonnet-4-20250514"
                        />
                        <div className="flex gap-2">
                          <SearchSelect
                            variant="field"
                            className="text-body"
                            label={tr("settings.routing.tier")}
                            value={model.tier}
                            options={[
                              { id: "smart", label: tr("settings.provider.tierSmart") },
                              { id: "balanced", label: tr("settings.provider.tierBalanced") },
                              { id: "fast", label: tr("settings.provider.tierFast") },
                              { id: "free", label: tr("settings.provider.tierFree") },
                            ]}
                            onChange={(tier) => updateModel(index, { tier })}
                          />
                          <SearchSelect
                            variant="field"
                            className="text-body"
                            label={tr("settings.provider.costLabel")}
                            value={model.cost_label}
                            options={[
                              { id: "paid", label: tr("settings.provider.costPaid") },
                              { id: "company", label: tr("settings.provider.costCompany") },
                              { id: "free", label: tr("settings.provider.costFree") },
                              { id: "unknown", label: tr("settings.provider.costUnknown") },
                            ]}
                            onChange={(cost_label) => updateModel(index, { cost_label })}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button disabled={providerBusy} onClick={onSaveProvider}>
                {providerBusy ? tr("settings.saving") : tr("settings.provider.saveEntry")}
              </Button>
              <Button variant="secondary" disabled={providerBusy} onClick={onCloseProviderForm}>
                {tr("settings.provider.cancel")}
              </Button>
            </div>
          </div>
        ) : null}

        <div className="block space-y-1">
          <span className="text-body leading-4 font-medium text-kin-secondary">
            {tr("settings.provider.defaultAgent")}
          </span>
          <SearchSelect
            variant="field"
            label={tr("settings.provider.defaultAgent")}
            value={agentDefault}
            options={[
              { id: "", label: tr("settings.provider.autoOption") },
              ...sortAgentCatalog(runnableAgents(agentList)).map((agent) => {
                const state = agentCatalogState(agent);
                let suffix = "";
                if (agent.default) {
                  suffix = tr("settings.provider.currentDefault").replace(/^\s*—\s*/, "");
                } else if (state === "generic") {
                  suffix = tr("agentCatalog.generic");
                }
                return {
                  id: agent.id,
                  label: `${agent.name} (${agent.id})${suffix ? ` — ${suffix}` : ""}`,
                };
              }),
            ]}
            onChange={onAgentDefaultChange}
            describedBy="default-agent-desc"
          />
          <div id="default-agent-desc" className="space-y-1">
            <span className="block text-caption text-kin-muted">
              {tr("settings.provider.defaultAgentHint")}
            </span>
            <span className="block text-caption text-kin-muted">
              {tr("settings.provider.defaultAgentEffect")}
            </span>
          </div>
          {agentList.some((agent) => !agent.available) ? (
            <Link
              to="/agents"
              // Agent Ops is a phone destination of its own, so it replaces
              // settings rather than stacking on top of it: Back is one step
              // to the list (KIN-CONTINUE-002). Settings answers for unsaved
              // edits first, through the page's leave guard.
              onClick={(event) => onGuardedLinkClick(event, navigate, location, "/agents")}
              className="inline-flex min-h-11 items-center text-caption text-kin-blue-ink hover:underline sm:min-h-0 sm:mt-1"
            >
              {tr("agents.manageLink")}
            </Link>
          ) : null}
        </div>
        <Button disabled={settingsBusy} onClick={onSaveSettings}>
          {settingsBusy ? tr("settings.saving") : tr("settings.provider.save")}
        </Button>
      </section>
    </SettingsTabPanel>
  );
}
