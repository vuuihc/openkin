import { useCallback, useEffect, useRef, useState } from "react";
import {
  createTerminalSession,
  deleteTerminalSession,
  listTerminalProfiles,
  listTerminalSessions,
  type TerminalProfile,
  type TerminalSession,
} from "../../api/client";
import { useT } from "../../i18n/react";
import { pickDirectory } from "../../lib/desktop";
import { projectLabel, shortPath } from "../../lib/paths";
import { effectiveTerminalCwd } from "../../lib/terminal";
import { IconChevron, IconPlus, IconTerminal, IconX } from "../icons";
import TerminalProfileMenu from "./TerminalProfileMenu";
import TerminalTabs from "./TerminalTabs";
import TerminalView from "./TerminalView";

type Props = {
  open: boolean;
  cwd: string;
  onClose: () => void;
};

type SessionWithConnection = TerminalSession & {
  connectionStatus: "connecting" | "connected" | "disconnected";
};

/**
 * Full-screen terminal overlay (same shell pattern as the workspace/files panel).
 * Lives inside the main content column so the app sidebar stays visible.
 */
export default function TerminalPanel({ open, cwd, onClose }: Props) {
  const tr = useT();
  const [hasOpened, setHasOpened] = useState(false);
  const loadStartedRef = useRef(false);
  const autoCreateAttemptedRef = useRef(false);
  const newSessionRef = useRef<HTMLDivElement>(null);

  const [profiles, setProfiles] = useState<TerminalProfile[]>([]);
  const [defaultProfileId, setDefaultProfileId] = useState("");
  const [sessions, setSessions] = useState<SessionWithConnection[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [cwdOverride, setCwdOverride] = useState<string | null>(null);
  const [initialLoaded, setInitialLoaded] = useState(false);
  const [loadingProfiles, setLoadingProfiles] = useState(false);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [closeError, setCloseError] = useState<string | null>(null);

  const effectiveCwd = effectiveTerminalCwd(cwd, cwdOverride);

  useEffect(() => {
    if (open) setHasOpened(true);
    else setMenuOpen(false);
  }, [open]);

  useEffect(() => {
    if (!open || loadStartedRef.current) return;
    loadStartedRef.current = true;

    setLoadingProfiles(true);
    setLoadingSessions(true);

    const profileRequest = listTerminalProfiles()
      .then((result) => result)
      .catch(() => ({ profiles: [] as TerminalProfile[], default_profile_id: "" }));
    const sessionRequest = listTerminalSessions().catch(
      () => [] as TerminalSession[],
    );

    void Promise.all([profileRequest, sessionRequest]).then(
      ([profileResult, sessionList]) => {
        setProfiles(profileResult.profiles);
        setDefaultProfileId(profileResult.default_profile_id);
        setLoadingProfiles(false);

        const withStatus: SessionWithConnection[] = sessionList.map((session) => ({
          ...session,
          connectionStatus: "disconnected",
        }));
        setSessions(withStatus);
        const newestRunning = [...withStatus]
          .reverse()
          .find((session) => session.status === "running");
        const newest = newestRunning ?? withStatus.at(-1);
        setActiveSessionId(newest?.id ?? null);
        if (withStatus.length > 0) autoCreateAttemptedRef.current = true;
        setLoadingSessions(false);
        setInitialLoaded(true);
      },
    );
  }, [open]);

  const createForProfile = useCallback(
    async (profileId: string, targetCwd: string) => {
      if (!profileId || !targetCwd || creatingSession) return;
      if (sessions.length >= 8) {
        setCreateError(tr("terminal.sessionLimit"));
        return;
      }
      setCreatingSession(true);
      setCreateError(null);
      try {
        const session = await createTerminalSession({
          profile_id: profileId,
          cwd: targetCwd,
          cols: 80,
          rows: 24,
        });
        setSessions((previous) => [
          ...previous,
          { ...session, connectionStatus: "disconnected" },
        ]);
        setActiveSessionId(session.id);
      } catch {
        setCreateError(tr("terminal.createFailed"));
      } finally {
        setCreatingSession(false);
      }
    },
    [creatingSession, sessions.length, tr],
  );

  useEffect(() => {
    if (
      !open ||
      !initialLoaded ||
      autoCreateAttemptedRef.current ||
      sessions.length > 0 ||
      profiles.length === 0 ||
      !effectiveCwd
    ) {
      return;
    }
    const profileId = defaultProfileId || profiles[0].id;
    autoCreateAttemptedRef.current = true;
    void createForProfile(profileId, effectiveCwd);
  }, [
    createForProfile,
    defaultProfileId,
    effectiveCwd,
    initialLoaded,
    open,
    profiles,
    sessions.length,
  ]);

  const handleCreateSession = useCallback(
    async (profileId: string) => {
      if (!profileId || creatingSession) return;
      autoCreateAttemptedRef.current = true;
      let targetCwd = effectiveCwd;
      if (!targetCwd) {
        try {
          targetCwd = (await pickDirectory()) ?? "";
        } catch {
          setCreateError(tr("terminal.createFailed"));
          return;
        }
        if (!targetCwd) return;
        setCwdOverride(targetCwd);
      }
      await createForProfile(profileId, targetCwd);
    },
    [createForProfile, creatingSession, effectiveCwd, tr],
  );

  const handleCloseSession = useCallback(
    async (id: string) => {
      autoCreateAttemptedRef.current = true;
      setCloseError(null);
      try {
        await deleteTerminalSession(id);
        setSessions((previous) => {
          const removedIndex = previous.findIndex((session) => session.id === id);
          const remaining = previous.filter((session) => session.id !== id);
          if (activeSessionId === id) {
            const nextIndex = Math.min(
              Math.max(removedIndex, 0),
              remaining.length - 1,
            );
            setActiveSessionId(remaining[nextIndex]?.id ?? null);
          }
          return remaining;
        });
      } catch {
        setCloseError(tr("terminal.closeFailed"));
      }
    },
    [activeSessionId, tr],
  );

  const handleSessionExit = useCallback((id: string, exitCode: number) => {
    setSessions((previous) =>
      previous.map((session) =>
        session.id === id
          ? { ...session, status: "exited", exit_code: exitCode }
          : session,
      ),
    );
  }, []);

  const handleConnectionChange = useCallback(
    (
      id: string,
      connectionStatus: SessionWithConnection["connectionStatus"],
    ) => {
      setSessions((previous) =>
        previous.map((session) =>
          session.id === id ? { ...session, connectionStatus } : session,
        ),
      );
    },
    [],
  );

  const canCreate =
    !creatingSession && profiles.length > 0 && sessions.length < 8;
  const defaultCreateId = defaultProfileId || profiles[0]?.id || "";

  // Keep the component mounted after first open so PTY sockets survive toggles.
  if (!hasOpened) return null;

  return (
    <div
      className={[
        "absolute inset-0 z-40 bg-[var(--kin-inspector)] safe-pad",
        open ? "flex flex-col" : "hidden",
      ].join(" ")}
      role="complementary"
      aria-label={tr("terminal.title")}
      aria-hidden={!open}
    >
      <div className="flex h-full min-h-0 w-full flex-col">
        {/* Header — matches WorkspacePanel chrome */}
        <div className="flex flex-none items-center gap-2 border-b border-[var(--kin-hairline)] px-3 py-2">
          <IconTerminal size={14} className="flex-none text-kin-muted" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12px] font-semibold text-kin-text">
              {tr("terminal.title")}
            </div>
            {effectiveCwd ? (
              <div
                className="truncate font-mono text-[11px] text-kin-muted"
                title={effectiveCwd}
              >
                {projectLabel(effectiveCwd)} · {shortPath(effectiveCwd, 48)}
              </div>
            ) : (
              <div className="truncate text-[11px] text-kin-muted">
                {tr("terminal.noSessions")}
              </div>
            )}
          </div>

          <div className="relative flex flex-none items-center" ref={newSessionRef}>
            <div className="flex items-center overflow-hidden rounded-md border border-[var(--kin-hairline-strong)] bg-[var(--kin-fill)]">
              <button
                type="button"
                className="flex items-center gap-1 px-2 py-1 text-[12px] text-kin-text transition-colors hover:bg-[var(--kin-fill-strong)] disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => {
                  setMenuOpen(false);
                  void handleCreateSession(defaultCreateId);
                }}
                disabled={!canCreate || !defaultCreateId}
                aria-label={tr("terminal.new")}
                title={tr("terminal.new")}
              >
                <IconPlus size={13} strokeWidth={1.9} />
                <span className="hidden sm:inline">{tr("terminal.new")}</span>
              </button>
              {profiles.length > 1 && (
                <button
                  type="button"
                  className="flex items-center border-l border-[var(--kin-hairline-strong)] px-1.5 py-1 text-kin-muted transition-colors hover:bg-[var(--kin-fill-strong)] hover:text-kin-text disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => {
                    if (!canCreate) return;
                    setMenuOpen((value) => !value);
                  }}
                  disabled={!canCreate}
                  aria-label={tr("terminal.chooseProfile")}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  title={tr("terminal.chooseProfile")}
                >
                  <IconChevron
                    size={12}
                    className={menuOpen ? "rotate-[-90deg]" : "rotate-90"}
                  />
                </button>
              )}
            </div>
            <TerminalProfileMenu
              profiles={profiles}
              open={menuOpen}
              onClose={() => setMenuOpen(false)}
              onSelectProfile={(profileId) => {
                setMenuOpen(false);
                void handleCreateSession(profileId);
              }}
              anchorRef={newSessionRef}
            />
          </div>

          <button
            type="button"
            onClick={onClose}
            className="flex-none rounded-md p-1.5 text-kin-muted hover:bg-[var(--kin-fill)] hover:text-kin-text"
            aria-label={tr("terminal.closePanel")}
            title={tr("terminal.closePanel")}
          >
            <IconX size={14} />
          </button>
        </div>

        {sessions.length > 0 && (
          <TerminalTabs
            sessions={sessions}
            activeSessionId={activeSessionId}
            onSelectSession={setActiveSessionId}
            onCloseSession={(id) => void handleCloseSession(id)}
          />
        )}

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {loadingProfiles || loadingSessions ? (
            <div className="flex h-full items-center justify-center text-kin-muted">
              <span className="text-[13px]">{tr("terminal.loading")}</span>
            </div>
          ) : sessions.length > 0 ? (
            sessions.map((session) => {
              const isActive = session.id === activeSessionId;
              return (
                <div
                  key={session.id}
                  className={isActive ? "h-full w-full" : "hidden"}
                  aria-hidden={!isActive}
                >
                  <TerminalView
                    session={session}
                    active={open && isActive}
                    onExit={handleSessionExit}
                    onConnectionChange={handleConnectionChange}
                  />
                </div>
              );
            })
          ) : profiles.length === 0 ? (
            <div className="flex h-full items-center justify-center text-kin-muted">
              <span className="text-[13px]">{tr("terminal.noProfiles")}</span>
            </div>
          ) : !effectiveCwd ? (
            <div className="flex h-full flex-col items-center justify-center gap-3">
              <span className="text-[13px] text-kin-secondary">
                {tr("terminal.noSessions")}
              </span>
              <button
                type="button"
                className="rounded-md bg-kin-blue px-3 py-1.5 text-[12px] text-white transition-all hover:brightness-110"
                onClick={async () => {
                  try {
                    const chosen = await pickDirectory();
                    if (chosen) setCwdOverride(chosen);
                  } catch {
                    setCreateError(tr("terminal.createFailed"));
                  }
                }}
              >
                {tr("terminal.chooseFolder")}
              </button>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-kin-muted">
              <span className="text-[13px]">{tr("terminal.noSessions")}</span>
            </div>
          )}
        </div>

        {(createError || closeError) && (
          <div className="flex-none border-t border-kin-orange/25 bg-kin-orange/10 px-3 py-2 text-[12px] text-kin-orange">
            {createError || closeError}
          </div>
        )}
      </div>
    </div>
  );
}
