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
import {
  clampTerminalHeight,
  DEFAULT_TERMINAL_HEIGHT,
  effectiveTerminalCwd,
  maxTerminalHeight,
  MIN_TERMINAL_HEIGHT,
  parseTerminalHeight,
  TERMINAL_HEIGHT_KEY,
} from "../../lib/terminal";
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

type DragState = {
  pointerId: number;
  startY: number;
  startHeight: number;
};

export default function TerminalPanel({ open, cwd, onClose }: Props) {
  const tr = useT();
  const [hasOpened, setHasOpened] = useState(false);
  const [height, setHeight] = useState(DEFAULT_TERMINAL_HEIGHT);
  const heightRef = useRef(height);
  const dragRef = useRef<DragState | null>(null);
  const loadStartedRef = useRef(false);
  const autoCreateAttemptedRef = useRef(false);

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

  heightRef.current = height;
  const effectiveCwd = effectiveTerminalCwd(cwd, cwdOverride);

  const persistHeight = useCallback((value: number) => {
    try {
      localStorage.setItem(TERMINAL_HEIGHT_KEY, String(value));
    } catch {
      // Client preference persistence is best-effort.
    }
  }, []);

  const updateHeight = useCallback((value: number, persist = false) => {
    const next = clampTerminalHeight(value, window.innerHeight);
    heightRef.current = next;
    setHeight(next);
    if (persist) persistHeight(next);
    return next;
  }, [persistHeight]);

  useEffect(() => {
    try {
      updateHeight(
        parseTerminalHeight(
          localStorage.getItem(TERMINAL_HEIGHT_KEY),
          window.innerHeight,
        ),
      );
    } catch {
      updateHeight(DEFAULT_TERMINAL_HEIGHT);
    }
  }, [updateHeight]);

  useEffect(() => {
    const onResize = () => updateHeight(heightRef.current);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [updateHeight]);

  useEffect(() => {
    if (!open || loadStartedRef.current) return;
    loadStartedRef.current = true;
    setHasOpened(true);
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

  const handleResizeKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const maximum = maxTerminalHeight(window.innerHeight);
    let next: number | null = null;
    switch (event.key) {
      case "ArrowUp":
        next = Math.min(heightRef.current + 16, maximum);
        break;
      case "ArrowDown":
        next = Math.max(heightRef.current - 16, MIN_TERMINAL_HEIGHT);
        break;
      case "Home":
        next = MIN_TERMINAL_HEIGHT;
        break;
      case "End":
        next = maximum;
        break;
    }
    if (next === null) return;
    event.preventDefault();
    updateHeight(next, true);
  };

  if (!hasOpened) return null;

  return (
    <div
      className={`flex flex-none flex-col overflow-hidden border-t border-[var(--kin-hairline)] bg-[var(--kin-bg)] transition-[height,opacity] duration-200 ${
        open ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
      }`}
      style={{ height: open ? height : 0 }}
      aria-hidden={!open}
    >
      <div
        className="h-1.5 flex-none cursor-ns-resize border-t border-[var(--kin-hairline)] transition-colors hover:bg-[var(--kin-fill)] focus:bg-[var(--kin-fill)] focus:outline-none focus:ring-2 focus:ring-kin-blue/30"
        role="separator"
        aria-label={tr("terminal.resize")}
        aria-orientation="horizontal"
        aria-valuemin={MIN_TERMINAL_HEIGHT}
        aria-valuemax={maxTerminalHeight(window.innerHeight)}
        aria-valuenow={height}
        tabIndex={open ? 0 : -1}
        onKeyDown={handleResizeKey}
        onPointerDown={(event) => {
          dragRef.current = {
            pointerId: event.pointerId,
            startY: event.clientY,
            startHeight: heightRef.current,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          updateHeight(drag.startHeight + drag.startY - event.clientY);
        }}
        onPointerUp={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          dragRef.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          persistHeight(heightRef.current);
        }}
        onPointerCancel={(event) => {
          dragRef.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          persistHeight(heightRef.current);
        }}
      />

      <div className="flex flex-none items-center justify-between gap-2 border-b border-[var(--kin-hairline)] bg-[var(--kin-elevated)] px-3 py-2">
        <span className="text-[13px] font-semibold text-kin-text">
          {tr("terminal.title")}
        </span>
        <div className="flex items-center gap-1">
          <div className="relative flex items-center gap-0.5">
            <button
              type="button"
              className="rounded bg-kin-blue px-2 py-1 text-[12px] text-white transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() =>
                void handleCreateSession(defaultProfileId || profiles[0]?.id || "")
              }
              disabled={
                creatingSession || profiles.length === 0 || sessions.length >= 8
              }
              aria-label={tr("terminal.new")}
              title={tr("terminal.new")}
            >
              +
            </button>
            {profiles.length > 1 && (
              <button
                type="button"
                className="rounded px-1 py-1 text-[12px] transition-colors hover:bg-[var(--kin-fill)] disabled:opacity-50"
                onClick={() => setMenuOpen((value) => !value)}
                disabled={creatingSession}
                aria-label={tr("terminal.new")}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
              >
                ▼
              </button>
            )}
            <TerminalProfileMenu
              profiles={profiles}
              open={menuOpen}
              onClose={() => setMenuOpen(false)}
              onSelectProfile={(profileId) => {
                setMenuOpen(false);
                void handleCreateSession(profileId);
              }}
            />
          </div>
          <button
            type="button"
            className="rounded px-2 py-1 text-[12px] text-kin-secondary transition-colors hover:bg-[var(--kin-fill)] hover:text-kin-text"
            onClick={onClose}
            aria-label={tr("terminal.closePanel")}
            title={tr("terminal.closePanel")}
          >
            ✕
          </button>
        </div>
      </div>

      {sessions.length > 0 && (
        <TerminalTabs
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSelectSession={setActiveSessionId}
          onCloseSession={(id) => void handleCloseSession(id)}
        />
      )}

      <div className="flex flex-1 flex-col overflow-hidden">
        {loadingProfiles || loadingSessions ? (
          <div className="flex h-full items-center justify-center text-kin-muted">
            <span className="text-[13px]">{tr("terminal.loading")}</span>
          </div>
        ) : sessions.length > 0 ? (
          sessions.map((session) => {
            const active = session.id === activeSessionId;
            return (
              <div
                key={session.id}
                className={active ? "min-h-0 flex-1" : "hidden"}
              >
                <TerminalView
                  session={session}
                  active={open && active}
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
              className="rounded bg-kin-blue px-3 py-1.5 text-[12px] text-white transition-all hover:brightness-110"
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
  );
}
