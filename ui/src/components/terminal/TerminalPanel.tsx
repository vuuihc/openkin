import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  type TerminalProfile,
  type TerminalSession,
  listTerminalProfiles,
  listTerminalSessions,
  createTerminalSession,
  deleteTerminalSession,
} from "../../api/client";
import { useT } from "../../i18n/react";
import { pickDirectory } from "../../lib/desktop";
import { subscribeDraft } from "../../lib/draftChat";
import {
  TERMINAL_HEIGHT_KEY,
  MIN_TERMINAL_HEIGHT,
  DEFAULT_TERMINAL_HEIGHT,
  parseTerminalHeight,
} from "../../lib/terminal";
import TerminalView from "./TerminalView";
import TerminalTabs from "./TerminalTabs";
import TerminalProfileMenu from "./TerminalProfileMenu";

type Props = {
  open: boolean;
  cwd: string;
  onClose: () => void;
};

type SessionWithConnection = TerminalSession & {
  connectionStatus: "connecting" | "connected" | "disconnected";
};

export default function TerminalPanel({ open, cwd, onClose }: Props) {
  const tr = useT();
  const panelRef = useRef<HTMLDivElement>(null);
  const resizeHandleRef = useRef<HTMLDivElement>(null);
  const [hasOpened, setHasOpened] = useState(false);
  const [height, setHeight] = useState(DEFAULT_TERMINAL_HEIGHT);
  const [isDragging, setIsDragging] = useState(false);

  const [profiles, setProfiles] = useState<TerminalProfile[]>([]);
  const [defaultProfileId, setDefaultProfileId] = useState<string>("");
  const [sessions, setSessions] = useState<SessionWithConnection[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [cwdOverride, setCwdOverride] = useState<string | null>(null);

  const [loadingProfiles, setLoadingProfiles] = useState(false);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [closeError, setCloseError] = useState<string | null>(null);

  // Subscribe to draft cwd changes (for monitoring)
  useEffect(() => {
    return subscribeDraft(() => {
      // Only for monitoring draft changes
    });
  }, []);

  // Load height from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem(TERMINAL_HEIGHT_KEY);
      const parsed = parseTerminalHeight(stored, window.innerHeight);
      setHeight(parsed);
    } catch {
      setHeight(DEFAULT_TERMINAL_HEIGHT);
    }
  }, []);

  // Load profiles and sessions on first open
  useEffect(() => {
    if (!open || hasOpened) return;
    setHasOpened(true);

    const loadInitial = async () => {
      setLoadingProfiles(true);
      try {
        const result = await listTerminalProfiles();
        setProfiles(result.profiles);
        setDefaultProfileId(result.default_profile_id);
      } catch (err) {
        console.error("Failed to load profiles:", err);
        setProfiles([]);
      } finally {
        setLoadingProfiles(false);
      }

      setLoadingSessions(true);
      try {
        const list = await listTerminalSessions();
        const withStatus: SessionWithConnection[] = list.map((s) => ({
          ...s,
          connectionStatus: "disconnected" as const,
        }));
        setSessions(withStatus);

        // Pick newest running session, or newest exited session
        const running = withStatus.find((s) => s.status === "running");
        const newest = running || withStatus[0];
        if (newest) {
          setActiveSessionId(newest.id);
        }
      } catch (err) {
        console.error("Failed to load sessions:", err);
        setSessions([]);
      } finally {
        setLoadingSessions(false);
      }
    };

    void loadInitial();
  }, [open, hasOpened]);

  // Create default session on first open if cwd is available
  useEffect(() => {
    if (!open || !hasOpened || sessions.length > 0) return;
    if (!cwd && !cwdOverride) return; // No cwd; show empty state

    const createDefault = async () => {
      try {
        setCreatingSession(true);
        const effectiveCwd = cwdOverride || cwd;
        const session = await createTerminalSession({
          profile_id: defaultProfileId || profiles[0]?.id,
          cwd: effectiveCwd,
          cols: 80,
          rows: 24,
        });
        const withStatus: SessionWithConnection = {
          ...session,
          connectionStatus: "disconnected",
        };
        setSessions([withStatus]);
        setActiveSessionId(session.id);
        setCreateError(null);
      } catch (err) {
        setCreateError(String(err));
        console.error("Failed to create default session:", err);
      } finally {
        setCreatingSession(false);
      }
    };

    if (profiles.length > 0) {
      void createDefault();
    }
  }, [open, hasOpened, sessions.length, cwd, cwdOverride, profiles, defaultProfileId]);

  const effectiveCwd = cwdOverride || cwd;

  // Create new terminal with profile
  const handleCreateSession = useCallback(
    async (profileId: string) => {
      if (!effectiveCwd) {
        // Show folder picker
        try {
          const chosen = await pickDirectory();
          if (chosen) {
            setCwdOverride(chosen);
            // Create will happen after cwd is set
          }
        } catch (err) {
          setCreateError("Failed to choose folder");
        }
        return;
      }

      if (sessions.length >= 8) {
        setCreateError(tr("terminal.sessionLimit"));
        return;
      }

      setCreatingSession(true);
      setCreateError(null);

      try {
        const session = await createTerminalSession({
          profile_id: profileId,
          cwd: effectiveCwd,
          cols: 80,
          rows: 24,
        });
        const withStatus: SessionWithConnection = {
          ...session,
          connectionStatus: "disconnected",
        };
        setSessions((prev) => [...prev, withStatus]);
        setActiveSessionId(session.id);
      } catch (err) {
        setCreateError(tr("terminal.createFailed"));
        console.error("Failed to create session:", err);
      } finally {
        setCreatingSession(false);
      }
    },
    [effectiveCwd, sessions.length, tr("terminal.sessionLimit"), tr("terminal.createFailed")],
  );

  // Close session
  const handleCloseSession = useCallback(
    async (id: string) => {
      setCloseError(null);
      try {
        await deleteTerminalSession(id);
        setSessions((prev) => {
          const filtered = prev.filter((s) => s.id !== id);
          if (activeSessionId === id) {
            // Select nearest remaining tab
            const removedIdx = prev.findIndex((s) => s.id === id);
            const nextIdx = Math.max(0, removedIdx - 1);
            if (filtered[nextIdx]) {
              setActiveSessionId(filtered[nextIdx].id);
            } else if (filtered.length > 0) {
              setActiveSessionId(filtered[0].id);
            } else {
              setActiveSessionId(null);
            }
          }
          return filtered;
        });
      } catch (err) {
        setCloseError(tr("terminal.closeFailed"));
        console.error("Failed to close session:", err);
      }
    },
    [activeSessionId, tr("terminal.closeFailed")],
  );

  // Handle exit event from TerminalView
  const handleSessionExit = useCallback(
    (id: string, exitCode: number) => {
      setSessions((prev) =>
        prev.map((s) =>
          s.id === id
            ? { ...s, status: "exited" as const, exit_code: exitCode }
            : s,
        ),
      );
    },
    [],
  );

  // Handle connection status changes
  const handleConnectionChange = useCallback(
    (id: string, status: "connecting" | "connected" | "disconnected") => {
      setSessions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, connectionStatus: status } : s)),
      );
    },
    [],
  );

  // Resize handle mouse events
  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!panelRef.current) return;
      const panelRect = panelRef.current.getBoundingClientRect();
      const newHeight = Math.max(
        MIN_TERMINAL_HEIGHT,
        panelRect.bottom - e.clientY,
      );
      const maxHeight = Math.floor(window.innerHeight * 0.7);
      setHeight(Math.min(newHeight, maxHeight));
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      // Save height to localStorage
      try {
        localStorage.setItem(TERMINAL_HEIGHT_KEY, String(height));
      } catch {
        // ignore
      }
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, height]);

  // Resize handle keyboard events
  useEffect(() => {
    if (!resizeHandleRef.current) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!resizeHandleRef.current?.contains(document.activeElement as Node)) {
        return;
      }

      const step = 16;
      const maxHeight = Math.floor(window.innerHeight * 0.7);

      if (e.key === "ArrowUp") {
        setHeight((prev) => Math.min(prev + step, maxHeight));
        e.preventDefault();
      } else if (e.key === "ArrowDown") {
        setHeight((prev) => Math.max(prev - step, MIN_TERMINAL_HEIGHT));
        e.preventDefault();
      } else if (e.key === "Home") {
        setHeight(MIN_TERMINAL_HEIGHT);
        e.preventDefault();
      } else if (e.key === "End") {
        setHeight(maxHeight);
        e.preventDefault();
      }

      // Save on any keyboard adjustment
      try {
        localStorage.setItem(TERMINAL_HEIGHT_KEY, String(height));
      } catch {
        // ignore
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [height]);

  if (!hasOpened) {
    return null;
  }

  const isVisible = open;
  const visibleClass = isVisible ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none";

  return (
    <div
      ref={panelRef}
      className={`
        flex flex-col flex-none border-t border-[var(--kin-hairline)] bg-[var(--kin-bg)]
        overflow-hidden transition-opacity duration-200
        ${visibleClass}
      `}
      style={{ height: isVisible ? height : 0 }}
    >
      {/* Resize handle */}
      <div
        ref={resizeHandleRef}
        className={`
          h-1.5 flex-none cursor-ns-resize border-t border-[var(--kin-hairline)] hover:bg-[var(--kin-fill)]
          focus:outline-none focus:ring-2 focus:ring-kin-blue/30 focus:bg-[var(--kin-fill)]
          transition-colors
        `}
        role="separator"
        aria-orientation="horizontal"
        aria-valuemin={MIN_TERMINAL_HEIGHT}
        aria-valuemax={Math.floor(window.innerHeight * 0.7)}
        aria-valuenow={height}
        tabIndex={0}
        onMouseDown={() => setIsDragging(true)}
      />

      {/* Header with controls */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 flex-none bg-[var(--kin-elevated)] border-b border-[var(--kin-hairline)]">
        <span className="text-[13px] font-semibold text-kin-text">{tr("terminal.title")}</span>

        <div className="flex items-center gap-1">
          {/* Create button */}
          <div className="relative">
            <button
              className="px-2 py-1 text-[12px] rounded bg-kin-blue text-white hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
              onClick={() => handleCreateSession(defaultProfileId || profiles[0]?.id)}
              disabled={creatingSession || sessions.length >= 8}
              title={tr("terminal.new")}
            >
              +
            </button>

            {/* Profile dropdown toggle */}
            {profiles.length > 1 && (
              <button
                className="px-1 py-1 text-[12px] rounded hover:bg-[var(--kin-fill)] disabled:opacity-50 transition-colors"
                onClick={() => setMenuOpen(!menuOpen)}
                disabled={creatingSession}
              >
                ▼
              </button>
            )}

            <TerminalProfileMenu
              profiles={profiles}
              open={menuOpen}
              onClose={() => setMenuOpen(false)}
              onSelectProfile={(profileId) => {
                void handleCreateSession(profileId);
                setMenuOpen(false);
              }}
            />
          </div>

          {/* Close panel button */}
          <button
            className="px-2 py-1 text-[12px] rounded hover:bg-[var(--kin-fill)] transition-colors text-kin-secondary hover:text-kin-text"
            onClick={onClose}
            title={tr("terminal.closePanel")}
          >
            ✕
          </button>
        </div>
      </div>

      {/* Tabs */}
      {sessions.length > 0 && (
        <TerminalTabs
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSelectSession={setActiveSessionId}
          onCloseSession={handleCloseSession}
        />
      )}

      {/* Content area */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {loadingProfiles || loadingSessions ? (
          <div className="flex items-center justify-center h-full text-kin-muted">
            <span className="text-[13px]">{tr("terminal.loading")}</span>
          </div>
        ) : profiles.length === 0 ? (
          <div className="flex items-center justify-center h-full text-kin-muted">
            <span className="text-[13px]">{tr("terminal.noProfiles")}</span>
          </div>
        ) : !effectiveCwd ? (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <span className="text-[13px] text-kin-secondary">{tr("terminal.noSessions")}</span>
            <button
              className="px-3 py-1.5 text-[12px] rounded bg-kin-blue text-white hover:brightness-110 transition-all"
              onClick={async () => {
                const chosen = await pickDirectory();
                if (chosen) {
                  setCwdOverride(chosen);
                }
              }}
            >
              {tr("terminal.chooseFolder")}
            </button>
          </div>
        ) : sessions.length === 0 ? (
          <div className="flex items-center justify-center h-full text-kin-muted">
            <span className="text-[13px]">{tr("terminal.noSessions")}</span>
          </div>
        ) : (
          // Render active terminal
          activeSessionId &&
          (() => {
            const active = sessions.find((s) => s.id === activeSessionId);
            return active ? (
              <TerminalView
                key={active.id}
                session={active}
                active={true}
                onExit={handleSessionExit}
                onConnectionChange={handleConnectionChange}
              />
            ) : null;
          })()
        )}
      </div>

      {/* Error messages */}
      {(createError || closeError) && (
        <div className="flex-none px-3 py-2 bg-kin-orange/10 border-t border-kin-orange/25 text-kin-orange text-[12px]">
          {createError || closeError}
        </div>
      )}
    </div>
  );
}
