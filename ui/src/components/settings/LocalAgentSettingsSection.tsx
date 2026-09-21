import type { AgentProvider, AgentProviderState } from "../../api/client";
import { useT } from "../../i18n/react";
import { SettingsTabPanel } from "./SettingsPrimitives";

export type AutoImportSnapshot = {
  imported: number;
  providers: Record<string, unknown>;
  errors?: Record<string, unknown>;
  synced_at: number;
};

export function isAutoImportSnapshot(value: unknown): value is AutoImportSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<AutoImportSnapshot>;
  return (
    typeof snapshot.synced_at === "number" &&
    Number.isFinite(snapshot.synced_at) &&
    typeof snapshot.imported === "number" &&
    Number.isFinite(snapshot.imported) &&
    !!snapshot.providers &&
    typeof snapshot.providers === "object"
  );
}

export function formatSyncTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function localAgentStatusKey(state: AgentProviderState): string {
  if (state === "available") return "settings.localAgents.available";
  if (state === "unsupported") return "settings.localAgents.unsupported";
  if (state === "not_detected") return "settings.localAgents.notDetected";
  if (state === "degraded") return "settings.localAgents.degraded";
  if (state === "permission_required") return "settings.localAgents.permissionRequired";
  return "settings.localAgents.unavailable";
}

export function canImportAgentSessions(agent: AgentProvider): boolean {
  return (agent.capabilities ?? []).some(
    (capability) =>
      capability.capability === "session_list" && capability.state === "available",
  );
}

export function LocalAgentSettingsSection({
  active,
  agentProviders,
  refreshingAgentCatalog,
  importingSessions,
  autoImportMode,
  lastAutoImport,
  settingsBusy,
  onRefreshAgentCatalog,
  onImportSessions,
  onImportProviderSessions,
  onAutoImportModeChange,
  onSaveSettings,
}: {
  active: boolean;
  agentProviders: AgentProvider[];
  refreshingAgentCatalog: boolean;
  importingSessions: boolean;
  autoImportMode: "prompt" | "enabled" | "disabled";
  lastAutoImport: AutoImportSnapshot | null;
  settingsBusy: boolean;
  onRefreshAgentCatalog: () => void;
  onImportSessions: () => void;
  onImportProviderSessions: (agentId: string) => void;
  onAutoImportModeChange: (mode: "prompt" | "enabled" | "disabled") => void;
  onSaveSettings: () => void;
}) {
  const tr = useT();

  return (
    <SettingsTabPanel id="agents" active={active}>
      <section className="rounded-xl border border-[var(--kin-hairline)] bg-kin-elevated/60 p-4 space-y-4">
        <div>
          <div className="flex items-start gap-3">
            <div className="flex-1">
              <h2 className="text-[11px] font-semibold uppercase tracking-wide text-kin-muted">
                {tr("settings.localAgents.heading")}
              </h2>
              <p className="mt-1 text-xs text-kin-muted leading-relaxed">
                {tr("settings.localAgents.desc")}
              </p>
            </div>
            <button
              type="button"
              disabled={refreshingAgentCatalog}
              onClick={onRefreshAgentCatalog}
              className="kin-btn-secondary text-[11px] min-h-[32px] disabled:opacity-50"
            >
              {refreshingAgentCatalog
                ? tr("settings.localAgents.refreshing")
                : tr("settings.localAgents.refresh")}
            </button>
          </div>
        </div>
        <div className="space-y-1.5">
          <div className="text-xs font-medium text-kin-secondary">
            {tr("settings.localAgents.providersHeading")}
          </div>
          <div className="divide-y divide-[var(--kin-hairline)] rounded-lg border border-[var(--kin-hairline)]">
            {agentProviders.map((agent) => {
              const capabilities = new Map(
                (agent.capabilities ?? []).map((capability) => [
                  capability.capability,
                  capability,
                ]),
              );
              const statusText = tr(localAgentStatusKey(agent.state));
              const canImport = canImportAgentSessions(agent);
              const capabilityBadge = (id: string, label: string) => {
                const capability = capabilities.get(id);
                if (!capability) return null;
                const supported = capability.state === "available";
                return (
                  <span
                    title={capability.evidence}
                    className={[
                      "px-1.5 py-0.5 rounded border text-[10px]",
                      supported
                        ? "border-kin-border text-kin-muted"
                        : "border-kin-orange/40 text-kin-orange",
                    ].join(" ")}
                  >
                    {supported
                      ? label
                      : `${label} · ${tr("settings.localAgents.capabilityUnsupported")}`}
                  </span>
                );
              };
              return (
                <div key={agent.id} className="px-3 py-2.5 flex items-center gap-3">
                  <span
                    className={[
                      "w-2 h-2 rounded-full flex-none",
                      agent.state === "available"
                        ? "bg-kin-blue"
                        : agent.state === "unsupported"
                          ? "bg-kin-orange"
                          : "bg-kin-muted",
                    ].join(" ")}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-[12.5px] text-kin-text truncate">
                      {agent.name || agent.id}
                    </div>
                    <div className="text-[10.5px] text-kin-muted truncate">
                      {agent.id}
                      {" · "}
                      {statusText}
                      {agent.reason ? ` · ${agent.reason}` : ""}
                    </div>
                  </div>
                  <div className="flex flex-wrap justify-end gap-1">
                    {capabilityBadge("session_list", tr("settings.localAgents.listCapability"))}
                    {capabilityBadge(
                      "session_history_read",
                      tr("settings.localAgents.historyCapability"),
                    )}
                    {capabilityBadge("session_attach", tr("settings.localAgents.attachCapability"))}
                    {capabilityBadge("resume", tr("settings.localAgents.resumeCapability"))}
                    {capabilities.size === 0 && (
                      <span className="text-[10.5px] text-kin-muted">
                        {tr("settings.localAgents.noCapabilities")}
                      </span>
                    )}
                    {canImport && (
                      <button
                        type="button"
                        disabled={importingSessions}
                        onClick={() => onImportProviderSessions(agent.id)}
                        className="kin-btn-secondary px-2 py-1 text-[10px] min-h-[26px] disabled:opacity-50"
                      >
                        {tr("settings.localAgents.importProvider")}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
            {agentProviders.length === 0 && (
              <div className="px-3 py-3 text-[11px] text-kin-muted">
                {tr("settings.localAgents.noProviders")}
              </div>
            )}
          </div>
        </div>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-kin-secondary">
            {tr("settings.localAgents.autoImport")}
          </span>
          <select
            value={autoImportMode}
            onChange={(event) =>
              onAutoImportModeChange(event.target.value as "prompt" | "enabled" | "disabled")
            }
            className="kin-input min-h-[44px]"
          >
            <option value="prompt">{tr("settings.localAgents.modePrompt")}</option>
            <option value="enabled">{tr("settings.localAgents.modeEnabled")}</option>
            <option value="disabled">{tr("settings.localAgents.modeDisabled")}</option>
          </select>
          <span className="text-[11px] text-kin-muted">
            {tr("settings.localAgents.policy")}
          </span>
          <div
            className="rounded-lg border border-[var(--kin-hairline)] bg-[var(--kin-fill)]/40 px-3 py-2 text-[11px] text-kin-muted"
            role="status"
          >
            <span className="font-medium text-kin-secondary">
              {autoImportMode === "enabled"
                ? tr("settings.localAgents.autoSyncEnabled")
                : tr("settings.localAgents.autoSyncDisabled")}
            </span>
            {" · "}
            {lastAutoImport
              ? tr("settings.localAgents.lastSync", {
                  value: formatSyncTime(lastAutoImport.synced_at),
                  imported: lastAutoImport.imported,
                  errors: Object.keys(lastAutoImport.errors ?? {}).length,
                })
              : tr("settings.localAgents.neverSynced")}
          </div>
        </label>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={importingSessions}
            onClick={onImportSessions}
            className="kin-btn-secondary disabled:opacity-50"
          >
            {importingSessions
              ? tr("settings.localAgents.importing")
              : tr("settings.localAgents.import")}
          </button>
          <button
            type="button"
            disabled={settingsBusy}
            onClick={onSaveSettings}
            className="kin-btn-primary disabled:opacity-50"
          >
            {settingsBusy ? tr("settings.saving") : tr("settings.localAgents.save")}
          </button>
        </div>
      </section>
    </SettingsTabPanel>
  );
}
