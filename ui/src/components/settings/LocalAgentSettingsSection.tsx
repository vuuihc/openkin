import type { ReactNode } from "react";
import type { AgentProvider } from "../../api/client";
import { useCoarsePointer } from "../../hooks/useMediaQuery";
import { useT } from "../../i18n/react";
import type { AgentRole } from "../../lib/agentRoles";
import Button from "../ui/Button";
import InlineAlert from "../ui/InlineAlert";
import { RolesSection } from "./RolesSection";
import { SettingsSection, SettingsTabPanel } from "./SettingsPrimitives";

/** How the agents tab's one provider read is going. The page owns the read;
 *  the import rows render from it and own its read lifecycle on screen. */
export type AgentProvidersStatus = "loading" | "ready" | "failed";

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
  /** False while the console is disconnected: the import group says so, its
   *  read and writes disable with a reason, and the role editor is read-only. */
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
  const readFailed = providersStatus === "failed";
  const importable = agentProviders.filter(canImportAgentSessions);
  // A first read that failed has no results at all; it must not borrow the
  // empty list's sentence (an empty list is a successful read with no rows).
  const firstReadFailed = readFailed && agentProviders.length === 0;
  const importBlockedReason = !online
    ? tr("settings.localAgents.offlineImport")
    : importable.length === 0
      ? firstReadFailed
        ? tr("settings.localAgents.firstReadFailed")
        : tr("settings.localAgents.emptyImport")
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
      {/* Group 1 — import sessions. Owns the provider read's lifecycle and its
          own refresh entry, so removing any other half leaves it working (D2). */}
      <SettingsSection
        title={tr("settings.localAgents.importHeading")}
        description={tr("settings.localAgents.importRule")}
        action={
          <Button
            variant="secondary"
            disabled={detectionBusy || !online}
            onClick={onRefreshAgentCatalog}
            title={!online ? tr("settings.localAgents.offlineImport") : undefined}
            className="text-caption"
          >
            {detectionBusy
              ? tr("settings.localAgents.refreshing")
              : readFailed && agentProviders.length > 0
                ? tr("settings.localAgents.retryDetection")
                : tr("settings.localAgents.refresh")}
          </Button>
        }
      >
        {!online ? <OfflineNote>{tr("settings.localAgents.offlineImport")}</OfflineNote> : null}
        {readFailed && agentProviders.length > 0 ? (
          // D1: a failed re-read keeps the rows and their old timestamps; the
          // failure is one sentence above them.
          <InlineAlert className="space-y-2">
            <p>
              {tr("settings.localAgents.detectionFailed", {
                reason: providersError ?? "",
              })}
            </p>
          </InlineAlert>
        ) : null}
        {firstReadFailed ? (
          <InlineAlert className="space-y-2">
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
          </InlineAlert>
        ) : null}
        {providersStatus === "loading" && agentProviders.length === 0 ? (
          <div className="px-3 py-3 text-caption text-kin-muted">
            {tr("settings.localAgents.refreshing")}
          </div>
        ) : null}
        {providersStatus === "ready" && agentProviders.length === 0 ? (
          <div className="px-3 py-3">
            <p className="text-body text-kin-secondary">{tr("settings.localAgents.emptyImport")}</p>
            <p className="text-caption text-kin-muted">
              {tr("settings.localAgents.emptyImportHint")}
            </p>
          </div>
        ) : null}
        {agentProviders.length > 0 ? (
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
                    {/* Provenance for the row's import: after a failed read the
                        button is honest only beside the old scan time. */}
                    <div className="text-caption text-kin-muted">{lastDetectedText(agent)}</div>
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
        ) : null}
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

      {/* Group 2 — role defaults: saved text, no probe and no import. */}
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
