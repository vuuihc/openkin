import type { ReactNode } from "react";
import type { AgentProvider, AgentProviderState } from "../../api/client";
import { useCoarsePointer } from "../../hooks/useMediaQuery";
import { useT } from "../../i18n/react";
import type { AgentRole } from "../../lib/agentRoles";
import Button from "../ui/Button";
import InlineAlert from "../ui/InlineAlert";
import { RolesSection } from "./RolesSection";
import { SettingsSection, SettingsTabPanel } from "./SettingsPrimitives";

/** How the agents tab's one provider read is going. The page owns the read;
 *  both the detection rows and the import rows render from it. */
export type AgentProvidersStatus = "loading" | "ready" | "failed";

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

/** Local clock time of a scan, or null when there has never been one. A failed
 *  scan keeps the old time (D1); "never" is only for a missing timestamp. */
export function detectedClock(iso: string | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** A group's offline note. Plain text on purpose: the disabled controls carry
 *  the same reason, and a live region would repeat on every reconnect. */
function OfflineNote({ children }: { children: ReactNode }) {
  return <p className="px-1 text-body leading-4 text-kin-orange-ink">{children}</p>;
}

export function LocalAgentSettingsSection({
  active,
  agentProviders,
  providersStatus = "ready",
  providersError = null,
  online = true,
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
  providersStatus?: AgentProvidersStatus;
  providersError?: string | null;
  /** False while the console is disconnected: every group says so, the two
   *  write actions disable with a reason, and the role editor is read-only. */
  online?: boolean;
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
  const coarse = useCoarsePointer();
  const detectionBusy = refreshingAgentCatalog || providersStatus === "loading";
  const importable = agentProviders.filter(canImportAgentSessions);
  const importBlockedReason = !online
    ? tr("settings.localAgents.offlineImport")
    : importable.length === 0
      ? tr("settings.localAgents.emptyImport")
      : undefined;
  // TASTE 16: the 44px floor follows the pointer, not the viewport. The import
  // row's compact shape is a mouse convenience; on glass the same button keeps
  // a thumb-sized box at every width.
  const rowImportClass = coarse ? "min-h-11 px-2.5 py-1 text-caption" : "px-2.5 py-1 text-caption";
  const lastDetectedText = (agent: AgentProvider) => {
    const clock = detectedClock(agent.last_scanned_at);
    return tr("settings.localAgents.lastDetected", {
      value: clock ?? tr("settings.localAgents.neverDetected"),
    });
  };

  return (
    <SettingsTabPanel id="agents" active={active}>
      {/* Group 1 — installation status: automatic and read-only. */}
      <SettingsSection
        title={tr("settings.localAgents.detectionHeading")}
        description={tr("settings.localAgents.detectionRule")}
        action={
          <Button
            variant="secondary"
            disabled={detectionBusy || !online}
            onClick={onRefreshAgentCatalog}
            title={!online ? tr("settings.localAgents.offlineDetection") : undefined}
            className="text-caption"
          >
            {detectionBusy
              ? tr("settings.localAgents.refreshing")
              : providersStatus === "failed" && agentProviders.length > 0
                ? tr("settings.localAgents.retryDetection")
                : tr("settings.localAgents.refresh")}
          </Button>
        }
      >
        {!online ? <OfflineNote>{tr("settings.localAgents.offlineDetection")}</OfflineNote> : null}
        {providersStatus === "failed" ? (
          <InlineAlert className="space-y-2">
            {agentProviders.length > 0 ? (
              // D1: a failed re-probe keeps the rows and their old timestamps;
              // the failure is one sentence at the group head.
              <p>
                {tr("settings.localAgents.detectionFailed", {
                  reason: providersError ?? "",
                })}
              </p>
            ) : (
              <>
                <p className="font-medium">{tr("settings.localAgents.firstReadFailed")}</p>
                <p className="text-caption">
                  {providersError || tr("settings.localAgents.firstReadFailedHint")}
                </p>
                <Button
                  variant="secondary"
                  disabled={!online}
                  onClick={onRefreshAgentCatalog}
                  className="text-caption"
                >
                  {tr("common.retry")}
                </Button>
              </>
            )}
          </InlineAlert>
        ) : null}
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
                  <div className="text-caption text-kin-muted">{lastDetectedText(agent)}</div>
                  {!canImport ? (
                    <div className="text-caption text-kin-orange-ink">
                      {tr("settings.localAgents.importUnsupportedReason")}
                    </div>
                  ) : null}
                </div>
                {canImport && (
                  <Button
                    variant="secondary"
                    disabled={importingSessions || !online}
                    onClick={() => onImportProviderSessions(agent.id)}
                    aria-label={tr("settings.localAgents.importProviderLabel", {
                      name: agent.name || agent.id,
                    })}
                    title={!online ? tr("settings.localAgents.offlineImport") : undefined}
                    className={rowImportClass}
                  >
                    {tr("settings.localAgents.importProvider")}
                  </Button>
                )}
                {/* The capability chips are reference detail; on a phone they
                    used to share the row with the name and the import button,
                    which left the agent's name 3 characters wide. They take
                    their own full-width line below `lg`. */}
                <div className="flex flex-wrap justify-end gap-1 max-lg:order-last max-lg:w-full max-lg:justify-start">
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
              {detectionBusy
                ? tr("settings.localAgents.refreshing")
                : tr("settings.localAgents.noProviders")}
            </div>
          )}
        </div>
      </SettingsSection>

      {/* Group 2 — import sessions, drawn from the same metadata but never
          from the detection group's markup (D2). */}
      <SettingsSection
        title={tr("settings.localAgents.importHeading")}
        description={tr("settings.localAgents.importRule")}
      >
        {!online ? <OfflineNote>{tr("settings.localAgents.offlineImport")}</OfflineNote> : null}
        {agentProviders.length === 0 ? (
          <div className="px-3 py-3">
            <p className="text-body text-kin-secondary">{tr("settings.localAgents.emptyImport")}</p>
            <p className="text-caption text-kin-muted">
              {tr("settings.localAgents.emptyImportHint")}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-[var(--kin-hairline)] rounded-lg border border-[var(--kin-hairline)]">
            {agentProviders.map((agent) => {
              const canImport = canImportAgentSessions(agent);
              const name = agent.name || agent.id;
              return (
                <li
                  key={agent.id}
                  className="px-3 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-body text-kin-text truncate">{name}</div>
                    <div className="text-caption text-kin-muted truncate">
                      {tr("settings.localAgents.importRowDetail", { name })}
                    </div>
                    {!canImport ? (
                      <div className="text-caption text-kin-orange-ink">
                        {tr("settings.localAgents.importUnsupportedReason")}
                      </div>
                    ) : null}
                  </div>
                  {canImport && (
                    <Button
                      variant="secondary"
                      disabled={importingSessions || !online}
                      onClick={() => onImportProviderSessions(agent.id)}
                      aria-label={tr("settings.localAgents.importProviderLabel", { name })}
                      title={!online ? tr("settings.localAgents.offlineImport") : undefined}
                      className={rowImportClass}
                    >
                      {tr("settings.localAgents.importProvider")}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Button
            variant="secondary"
            disabled={importingSessions || !online || importable.length === 0}
            onClick={onImportSessions}
            title={importBlockedReason}
          >
            {importingSessions
              ? tr("settings.localAgents.importing")
              : tr("settings.localAgents.import")}
          </Button>
          {/* There is no automatic-import control: KIN-AGENTS-001 says a
              session enters Kin only when a person presses an import button.
              The daemon still accepts the old
              `agent_sessions.auto_import_mode` setting so an older console can
              save its settings without an error, but no surface reads it to
              start an import. */}
          <p className="min-w-0 flex-1 text-caption leading-prose text-kin-muted">
            {tr("settings.localAgents.importGroupNote")}
          </p>
        </div>
      </SettingsSection>

      {/* Group 3 — role defaults: saved text, no probe and no import. */}
      <RolesSection
        roles={roles}
        onChange={onRolesChange}
        onSave={onSaveSettings}
        saving={settingsBusy}
        disabled={settingsBusy || !online}
        offline={!online}
      />
    </SettingsTabPanel>
  );
}
