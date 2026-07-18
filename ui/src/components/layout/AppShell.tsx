import {
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  getToken,
  getUsageSummary,
  listTasks,
  type Task,
} from "../../api/client";
import { DRAFT_PATH, setDraftCwd, getDraftCwd, subscribeDraft } from "../../lib/draftChat";
import { useT } from "../../i18n/react";
import CommandPalette from "../CommandPalette";
import { subscribeWS, useAppStore } from "../../store/appStore";
import Sidebar from "./Sidebar";
import TerminalPanel from "../terminal/TerminalPanel";
import { isKinDesktop } from "../../lib/desktop";
import { isTerminalToggle } from "../../lib/terminal";

type Props = {
  children: ReactNode;
  pendingCount: number;
};

function taskIdFromPath(pathname: string): string | null {
  const m = pathname.match(/^\/tasks\/([^/]+)\/?$/);
  return m?.[1] ?? null;
}

/**
 * Desktop: sidebar + main. Mobile: hamburger drawer + full-width main.
 * New chat → navigate to DRAFT_PATH (no modal).
 */
export default function AppShell({ children, pendingCount }: Props) {
  const location = useLocation();
  const navigate = useNavigate();
  const tr = useT();
  const selectedTaskId = taskIdFromPath(location.pathname);
  const draftActive = location.pathname === DRAFT_PATH;

  const [tasks, setTasks] = useState<Task[]>([]);
  const [weekCost, setWeekCost] = useState<number | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [draftCwdLocal, setDraftCwdLocal] = useState<string>("");
  const reconnectGen = useAppStore((s) => s.reconnectGen);
  const wsStatus = useAppStore((s) => s.wsStatus);

  const openNewChat = useCallback(() => {
    // Single draft entry: always jump to /new (create-or-focus).
    navigate(DRAFT_PATH);
  }, [navigate]);

  const openNewSessionInProject = useCallback(
    (cwd: string) => {
      setDraftCwd(cwd);
      navigate(`${DRAFT_PATH}?cwd=${encodeURIComponent(cwd)}`);
    },
    [navigate],
  );

  const loadTasks = useCallback(async () => {
    if (!getToken()) return;
    try {
      const list = await listTasks({ limit: 100 });
      setTasks(list);
    } catch {
      // best-effort sidebar
    }
  }, []);

  const loadUsage = useCallback(async () => {
    if (!getToken()) return;
    try {
      const rows = await getUsageSummary(7);
      const cost = rows.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
      setWeekCost(cost);
    } catch {
      setWeekCost(null);
    }
  }, []);

  useEffect(() => {
    void loadTasks();
    void loadUsage();
  }, [loadTasks, loadUsage]);

  useEffect(() => {
    if (reconnectGen === 0) return;
    void loadTasks();
  }, [reconnectGen, loadTasks]);

  useEffect(() => {
    return subscribeWS((msg) => {
      if (msg.kind === "task_update") {
        const t = msg.data as Task;
        setTasks((prev) => {
          const rest = prev.filter((x) => x.id !== t.id);
          return [t, ...rest].sort((a, b) => b.created_at - a.created_at);
        });
      }
    });
  }, []);

  // Subscribe to draft cwd changes
  useEffect(() => {
    // Get initial cwd
    setDraftCwdLocal(getDraftCwd());
    // Subscribe to changes
    return subscribeDraft(() => {
      setDraftCwdLocal(getDraftCwd());
    });
  }, []);

  // ⌘N new chat · ⌘K command palette · Ctrl+Backquote toggle terminal
  useEffect(() => {
    const desktop = isKinDesktop();

    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        openNewChat();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
      if (desktop && isTerminalToggle(e)) {
        e.preventDefault();
        e.stopPropagation();
        setTerminalOpen((value) => !value);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openNewChat]);

  // Tray "New Chat" deep-link: /?new=1 or /new
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get("new") === "1") {
      params.delete("new");
      const qs = params.toString();
      navigate(
        { pathname: DRAFT_PATH, search: qs ? `?${qs}` : "" },
        { replace: true },
      );
    }
  }, [location.pathname, location.search, navigate]);

  return (
    <div className="h-[100dvh] flex bg-[var(--kin-page)] text-kin-text overflow-hidden safe-pad">
      <Sidebar
        tasks={tasks}
        selectedTaskId={selectedTaskId}
        draftActive={draftActive}
        pendingCount={pendingCount}
        weekCost={weekCost}
        onNewChat={openNewChat}
        onNewSessionInProject={openNewSessionInProject}
        mobileOpen={mobileOpen}
        onCloseMobile={() => setMobileOpen(false)}
      />

      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {wsStatus !== "connected" && (
          <div
            className="flex-none bg-[rgba(255,159,10,.12)] border-b border-[rgba(255,159,10,.25)] text-kin-orange text-[12px] text-center px-3 py-1.5"
            role="status"
          >
            {tr("app.reconnecting")}
          </div>
        )}

        <div className="md:hidden flex items-center gap-3 px-3 h-12 border-b border-[var(--kin-hairline)] flex-none pt-[env(safe-area-inset-top)]">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            className="min-w-[44px] min-h-[44px] -ml-1 flex items-center justify-center text-kin-blue"
            aria-label={tr("app.openMenu")}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" />
            </svg>
          </button>
          <span className="font-semibold text-[15px]">Kin</span>
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="ml-auto min-w-[44px] min-h-[44px] flex items-center justify-center text-kin-tertiary"
            aria-label={tr("app.commandPalette")}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
              <circle cx="11" cy="11" r="7" />
              <path d="m21 21-4.3-4.3" strokeLinecap="round" />
            </svg>
          </button>
          {pendingCount > 0 && (
            <span className="min-w-[20px] h-5 px-1.5 rounded-full bg-kin-orange text-[#1a1a1c] text-[11.5px] font-bold inline-flex items-center justify-center">
              {pendingCount}
            </span>
          )}
        </div>

        <main className="flex-1 min-h-0 overflow-hidden flex flex-col">
          {children}
        </main>

        {/* Terminal panel — desktop only */}
        {isKinDesktop() && (
          <TerminalPanel
            open={terminalOpen}
            cwd={
              selectedTaskId
                ? tasks.find((t) => t.id === selectedTaskId)?.cwd ?? (draftActive ? draftCwdLocal : "")
                : draftActive
                  ? draftCwdLocal
                  : ""
            }
            onClose={() => setTerminalOpen(false)}
          />
        )}
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onNewChat={openNewChat}
        onToggleTerminal={() => setTerminalOpen((v) => !v)}
        terminalAvailable={isKinDesktop()}
      />
    </div>
  );
}
