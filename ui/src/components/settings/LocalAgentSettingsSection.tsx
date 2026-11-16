import type { AgentProvider, AgentProviderState } from "../../api/client";
import { useT } from "../../i18n/react";
import type { AgentRole } from "../../lib/agentRoles";
import Button from "../ui/Button";
import { RolesSection } from "./RolesSection";
import { SettingsSection, SettingsTabPanel } from "./SettingsPrimitives";

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
    (capability) => capability.capability === "session_list" && capability.state === "available",
  );
}

export function LocalAgentSettingsSection({
  active,
  agentProviders,
  refreshingAgentCatalog,
  importingSessions,
  settingsBusy,
  onRefreshAgentCatalog,
  onImportSessions,
  onImportProviderSessions,
  onSaveSettings,
  roles,
  onRolesChange,
}: {
  active: boolean;
  agentProviders: AgentProvider[];
  refreshingAgentCatalog: boolean;
  importingSessions: boolean;
  settingsBusy: boolean;
  onRefreshAgentCatalog: () => void;
  onImportSessions: () => void;
  onImportProviderSessions: (agentId: string) => void;
  onSaveSettings: () => void;
  roles: AgentRole[];
  onRolesChange: (roles: AgentRole[]) => void;
}) {
  const tr = useT();

  return (
    <SettingsTabPanel id="agents" active={active}>
      <SettingsSection
        title={tr("settings.localAgents.heading")}
        description={tr("settings.localAgents.desc")}
        action={
          <Button
            variant="secondary"
            disabled={refreshingAgentCatalog}
            onClick={onRefreshAgentCatalog}
            className="text-caption"
          >
            {refreshingAgentCatalog
              ? tr("settings.localAgents.refreshing")
              : tr("settings.localAgents.refresh")}
          </Button>
        }
      >
        <div className="space-y-1.5">
          <div className="text-body leading-4 font-medium text-kin-secondary">
            {tr("settings.localAgents.providersHeading")}
          </div>
          <div className="divide-y divide-[var(--kin-hairline)] rounded-lg border border-[var(--kin-hairline)]">
            {agentProviders.map((agent) => {
              const capabilities = new Map(
                (agent.capabilities ?? []).map((capability) => [capability.capability, capability]),
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
                      "px-1.5 py-0.5 rounded border text-micro",
                      supported
                        ? "border-kin-hairline text-kin-muted"
                        : "border-kin-orange/40 text-kin-orange-ink",
                    ].join(" ")}
                  >
                    {supported
                      ? label
                      : `${label} · ${tr("settings.localAgents.capabilityUnsupported")}`}
                  </span>
                );
              };
              return (
                <div
                  key={agent.id}
                  className="px-3 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5"
                >
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
                    <div className="text-body text-kin-text truncate">{agent.name || agent.id}</div>
                    <div className="text-caption text-kin-muted truncate">
                      {agent.id}
                      {" · "}
                      {statusText}
                      {agent.reason ? ` · ${agent.reason}` : ""}
                    </div>
                  </div>
                  {canImport && (
                    <Button
                      variant="secondary"
                      disabled={importingSessions}
                      onClick={() => onImportProviderSessions(agent.id)}
                      className="px-2.5 py-1 text-caption"
                    >
                      {tr("settings.localAgents.importProvider")}
                    </Button>
                  )}
                  {/* The capability chips are reference detail; on a phone they
                      used to share the row with the name and the import button,
                      which left the agent's name 3 characters wide. They take
                      their own full-width line below `md`. */}
                  <div className="flex flex-wrap justify-end gap-1 max-md:order-last max-md:w-full max-md:justify-start">
                    {capabilityBadge("session_list", tr("settings.localAgents.listCapability"))}
                    {capabilityBadge(
                      "session_history_read",
                      tr("settings.localAgents.historyCapability"),
                    )}
                    {capabilityBadge("session_attach", tr("settings.localAgents.attachCapability"))}
                    {capabilityBadge("resume", tr("settings.localAgents.resumeCapability"))}
                    {capabilities.size === 0 && (
                      <span className="text-caption text-kin-muted">
                        {tr("settings.localAgents.noCapabilities")}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
            {agentProviders.length === 0 && (
              <div className="px-3 py-3 text-caption text-kin-muted">
                {tr("settings.localAgents.noProviders")}
              </div>
            )}
          </div>
        </div>
        {/* There is no automatic-import control: KIN-AGENTS-001 says a
            session enters Kin only when a person presses one of the import
            buttons above. The daemon still accepts the old
            `agent_sessions.auto_import_mode` setting so an older console can
            save its settings without an error, but no surface reads it to
            start an import. */}
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" disabled={importingSessions} onClick={onImportSessions}>
            {importingSessions
              ? tr("settings.localAgents.importing")
              : tr("settings.localAgents.import")}
          </Button>
          <Button disabled={settingsBusy} onClick={onSaveSettings}>
            {settingsBusy ? tr("settings.saving") : tr("settings.localAgents.save")}
          </Button>
        </div>
      </SettingsSection>
      {/* Roles sit beside the agents because they answer the same question —
          what am I about to run — and because a role is a prompt prefix, not a
          setting of the daemon. */}
      <RolesSection
        roles={roles}
        onChange={onRolesChange}
        onSave={onSaveSettings}
        saving={settingsBusy}
        disabled={settingsBusy}
      />
    </SettingsTabPanel>
  );
}
