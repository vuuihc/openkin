import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  deleteTask,
  getSettings,
  getUsageSummary,
  importAgentSessions,
  listAgents,
  listAgentSessionsPage,
  type AgentInfo,
  type AgentSession,
  type AgentSessionImportResult,
  type Task,
} from "../../api/client";
import { liveResources } from "../../api/liveResources";
import { useTaskList, useTaskResource } from "../../api/useLiveResources";
import { DRAFT_PATH, setDraftCwd, getDraftCwd, subscribeDraft } from "../../lib/draftChat";
import { useT } from "../../i18n/react";
import CommandPalette from "../CommandPalette";
import { useAppStore } from "../../store/appStore";
import Sidebar from "./Sidebar";
import MobileTabBar from "./MobileTabBar";
import TerminalPanel from "../terminal/TerminalPanel";
import { isKinDesktop } from "../../lib/desktop";
import { isTerminalToggle, localTerminalCwd } from "../../lib/terminal";
import { useMachines } from "../../hooks/useMachines";
import { remoteMachine } from "../../lib/devices";
import { displayUserPrompt } from "../../lib/attachments";

type Props = {
  children: ReactNode;
  pendingCount: number;
  routineUnreadCount?: number;
};

function publishAgentSessionSync(result: AgentSessionImportResult): void {
  const detail = {
    ...result,
    synced_at: Date.now(),
  } satisfies AgentSessionImportResult & { synced_at: number };
  try {
    window.localStorage.setItem("kin_agent_sessions_last_sync", JSON.stringify(detail));
  } catch {
    // Session sync must remain useful when browser storage is unavailable.
  }
  window.dispatchEvent(new CustomEvent("kin:agent-sessions-sync", { detail }));
}

function taskIdFromPath(pathname: string): string | null {
  const m = pathname.match(/^\/tasks\/([^/]+)\/?$/);
  return m?.[1] ?? null;
}

/**
 * Desktop: sidebar + main. Mobile: hamburger drawer + full-width main.
 * New chat → navigate to DRAFT_PATH (no modal).
 */
export default function AppShell({ children, pendingCount, routineUnreadCount = 0 }: Props) {
  const location = useLocation();
  const navigate = useNavigate();
  const tr = useT();
  const selectedTaskId = taskIdFromPath(location.pathname);
  const draftActive = location.pathname === DRAFT_PATH;
  const desktop = isKinDesktop();
  // On the phone there is no sidebar to say where you are, so the header has to.
  const mobileTitle = draftActive
    ? tr("nav.newChat")
    : location.pathname.startsWith("/sessions")
      ? tr("nav.sessions")
      : location.pathname.startsWith("/inbox")
        ? tr("nav.inbox")
        : location.pathname.startsWith("/settings")
          ? tr("nav.settings")
          : tr("app.name");
  const onSessionsTab = location.pathname.startsWith("/sessions");

  /**
   * Routes whose page title lives in this bar on a phone. Each of them hides
   * its own `<h1>` below `md` so the same word cannot appear twice (it did,
   * between `sm` and `md`). Everywhere else the bar only names the app and the
   * page's heading is still on screen, so the bar is a heading on these routes
   * only — which keeps exactly one visible `<h1>` at every width.
   */
  const barIsHeading =
    draftActive ||
    onSessionsTab ||
    location.pathname.startsWith("/inbox") ||
    location.pathname.startsWith("/settings");

  /**
   * Screens that ship their own header (back button + the real title).
   *
   * The prototype gives every phone screen exactly one nav bar. These three put
   * theirs inside the page — a session's or an artifact's title is not knowable
   * from the route — so the shell header would be a second bar saying nothing
   * ("Kin") and eating 48px above the one bar that matters. Back is the way out
   * of a detail screen, which is what iOS does too. `/artifacts` (the library)
   * is a list, not a detail screen, and keeps the shell bar; `/projects/:id` is
   * a scrolling page whose back link sits in its own content flow, so it keeps
   * the bar too.
   */
  const detailRoute =
    selectedTaskId !== null ||
    location.pathname.startsWith("/agent-sessions/") ||
    location.pathname.startsWith("/artifacts/");

  /**
   * Leaving the new-chat screen.
   *
   * `/` redirects here (App.tsx), so this screen is where a cold launch lands —
   * and it deliberately has no tab bar, which used to leave the header
   * hamburger as the only way out. The prototype gives it a close button; this
   * is that button. History wins when there is any, so opening the draft from
   * a session and closing it returns to that session.
   *
   * The test is `idx > 0`, not `location.key !== "default"`. A `<Navigate
   * replace>` — which is how this screen is reached from `/` — mints a fresh
   * random key, so the key looks like "we navigated here" on a cold launch
   * where the history really has nothing behind it, and `navigate(-1)` is then
   * a no-op: measured on a fresh load of `/`, `history.state` is
   * `{key: "cxd8pjf4", idx: 0}` and clicking × did nothing at all.
   */
  function closeDraft() {
    if ((window.history.state?.idx ?? 0) > 0) navigate(-1);
    else navigate("/sessions");
  }

  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const taskListParams = useMemo(
    () => (debouncedQuery ? { limit: 200, q: debouncedQuery } : { limit: 100 }),
    [debouncedQuery],
  );
  const taskList = useTaskList(taskListParams);
  const tasks = taskList.data;
  const searchLoading = searchQuery.trim() !== debouncedQuery || taskList.loading;
  const [weekCost, setWeekCost] = useState<number | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [externalSessions, setExternalSessions] = useState<AgentSession[]>([]);
  const [agentCatalog, setAgentCatalog] = useState<AgentInfo[]>([]);
  const agentCatalogRequest = useRef(0);
  const autoImportInFlight = useRef(false);
  const externalRefreshInFlight = useRef(false);
  const externalRefreshQueued = useRef(false);
  const [importingExternalSessions, setImportingExternalSessions] = useState(false);
  const [draftCwdLocal, setDraftCwdLocal] = useState<string>("");
  const pushToast = useAppStore((s) => s.pushToast);
  const wsStatus = useAppStore((s) => s.wsStatus);

  const loadExternalSessions = useCallback(async (skipAutoImport = false) => {
    if (externalRefreshInFlight.current) {
      externalRefreshQueued.current = true;
      return;
    }
    externalRefreshInFlight.current = true;
    try {
      const catalogRequest = ++agentCatalogRequest.current;
      await listAgents()
        .then((catalog) => {
          if (catalogRequest === agentCatalogRequest.current) setAgentCatalog(catalog);
        })
        .catch(() => {
          if (catalogRequest === agentCatalogRequest.current) setAgentCatalog([]);
        });
      if (!skipAutoImport && !autoImportInFlight.current) {
        const settings = await getSettings().catch(() => null);
        if (settings?.["agent_sessions.auto_import_mode"] === "enabled") {
          autoImportInFlight.current = true;
          try {
            const result = await importAgentSessions();
            publishAgentSessionSync(result);
          } catch (error) {
            publishAgentSessionSync({
              imported: 0,
              providers: {},
              errors: {
                sync: error instanceof Error ? error.message : "sync failed",
              },
            });
          } finally {
            autoImportInFlight.current = false;
          }
        }
      }
      const sessions: AgentSession[] = [];
      let before = "";
      for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
        const page = await listAgentSessionsPage({
          limit: 500,
          before: before || undefined,
        });
        sessions.push(...page.items);
        if (!page.next_cursor) break;
        before = page.next_cursor;
      }
      setExternalSessions(sessions);
    } catch {
      // Keep the last successful snapshot visible during transient refresh failures.
    } finally {
      externalRefreshInFlight.current = false;
      if (externalRefreshQueued.current) {
        externalRefreshQueued.current = false;
        void loadExternalSessions(true);
      }
    }
  }, []);

  const importExternalSessions = useCallback(
    async (agents?: string[]) => {
      if (importingExternalSessions) return;
      setImportingExternalSessions(true);
      try {
        const result = await importAgentSessions(agents);
        await loadExternalSessions(true);
        const errorCount = Object.keys(result.errors ?? {}).length;
        pushToast(
          errorCount > 0
            ? tr("settings.localAgents.importPartial", {
                imported: result.imported,
                errors: errorCount,
              })
            : tr("settings.localAgents.imported", { imported: result.imported }),
          errorCount > 0 ? "error" : "info",
        );
      } catch (e) {
        pushToast(tr("settings.localAgents.importFailed"), "error");
      } finally {
        setImportingExternalSessions(false);
      }
    },
    [importingExternalSessions, loadExternalSessions, pushToast, tr],
  );

  useEffect(() => {
    if (wsStatus === "disconnected") return;
    void loadExternalSessions();
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<{ skipAutoImport?: boolean }>).detail;
      void loadExternalSessions(detail?.skipAutoImport === true);
    };
    const timer = window.setInterval(() => void loadExternalSessions(), 30_000);
    window.addEventListener("kin:agent-sessions-changed", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("kin:agent-sessions-changed", refresh);
    };
  }, [loadExternalSessions, wsStatus]);

  const openNewChat = useCallback(() => {
    // Single draft entry: always jump to /new (create-or-focus).
    navigate(DRAFT_PATH);
  }, [navigate]);

  const toggleTerminal = useCallback(() => {
    setTerminalOpen((value) => !value);
  }, []);

  const openNewSessionInProject = useCallback(
    (cwd: string) => {
      setDraftCwd(cwd);
      navigate(`${DRAFT_PATH}?cwd=${encodeURIComponent(cwd)}`);
    },
    [navigate],
  );

  const handleDeleteSession = useCallback(
    async (task: Task) => {
      const title = (task.title || displayUserPrompt(task.prompt || "") || task.id).trim();
      const ok = window.confirm(tr("task.deleteConfirm") + (title ? `\n\n${title}` : ""));
      if (!ok) return;
      try {
        await deleteTask(task.id);
        liveResources.applyMessage({ kind: "task_deleted", data: { id: task.id } });
        pushToast(tr("task.deleted"), "info");
        if (taskIdFromPath(location.pathname) === task.id) {
          navigate("/");
        }
      } catch (e) {
        pushToast(e instanceof Error ? e.message : tr("task.deleteFailed"), "error");
      }
    },
    [location.pathname, navigate, pushToast, tr],
  );

  const loadUsage = useCallback(async () => {
    try {
      const rows = await getUsageSummary(7);
      const cost = rows.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
      setWeekCost(cost);
    } catch {
      setWeekCost(null);
    }
  }, []);

  useEffect(() => {
    void loadUsage();
  }, [loadUsage]);

  // Debounced session list load. Empty q = recent 100; non-empty = full-library search.
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) {
      setDebouncedQuery("");
      return;
    }
    const t = window.setTimeout(() => {
      setDebouncedQuery(q);
    }, 250);
    return () => window.clearTimeout(t);
  }, [searchQuery]);

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
        toggleTerminal();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [desktop, openNewChat, toggleTerminal]);

  // Which machine the open task runs on. Read from the task resource the page
  // itself uses, not from the sidebar list: that list is capped and filtered by
  // search, and a task missing from it would silently drop the guard below.
  const openTaskDetail = useTaskResource(selectedTaskId ?? "", Boolean(selectedTaskId));
  const openTask = selectedTaskId ? openTaskDetail.data.task : undefined;
  // The terminal is a shell on *this* machine. A task running on another machine
  // has a cwd that means something only over there, so it must not become this
  // shell's starting directory; the panel says why instead.
  const { machines } = useMachines();
  const remoteTask = remoteMachine(machines, openTask?.executing_device_id);
  const terminalCwd = localTerminalCwd(
    openTask,
    Boolean(remoteTask),
    draftActive ? draftCwdLocal : "",
  );
  const terminalNotice = remoteTask
    ? tr(remoteTask.known ? "terminal.runsOn" : "terminal.runsOnUnknown", {
        name: remoteTask.text,
      })
    : null;

  // Tray "New Chat" deep-link: /?new=1 or /new
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get("new") === "1") {
      params.delete("new");
      const qs = params.toString();
      navigate({ pathname: DRAFT_PATH, search: qs ? `?${qs}` : "" }, { replace: true });
    }
  }, [location.pathname, location.search, navigate]);

  return (
    /*
      `touch-lg` belongs on this root, not on <main>: the drawer (a fixed
      sibling of <main>) and the command palette below it are the two surfaces
      the phone uses to reach everything the three tabs do not cover, and both
      sit outside <main>. See index.css.
    */
    <div className="touch-lg h-[100dvh] flex bg-[var(--kin-page)] text-kin-text overflow-hidden safe-pad">
      <Sidebar
        tasks={tasks}
        selectedTaskId={selectedTaskId}
        draftActive={draftActive}
        pendingCount={pendingCount}
        routineUnreadCount={routineUnreadCount}
        weekCost={weekCost}
        onNewChat={openNewChat}
        onNewSessionInProject={openNewSessionInProject}
        onDeleteSession={(task) => void handleDeleteSession(task)}
        externalSessions={externalSessions}
        agentCatalog={agentCatalog}
        importingExternalSessions={importingExternalSessions}
        onImportExternalSessions={(agents) => void importExternalSessions(agents)}
        onOpenExternalSession={(session) => {
          navigate(`/agent-sessions/${encodeURIComponent(session.id)}`);
        }}
        mobileOpen={mobileOpen}
        onCloseMobile={() => setMobileOpen(false)}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        searchLoading={searchLoading}
      />

      <div className="relative flex-1 flex flex-col min-w-0 min-h-0">
        {/*
          Height is a *minimum*, not a fixed `h-12`. With `h-12` the box is 48px
          tall including its padding, so on a notched iPhone — where the safe
          area alone is 59px — the content box collapsed to nothing and the
          title rendered half inside the sensor housing.
        */}
        {detailRoute ? (
          /*
            No bar, but still the top inset. The page below draws its own
            header, and exactly one element must own the notch: handing that
            job to the page would mean every future detail screen has to
            remember `pt-safe`, and getting it wrong puts a title under the
            sensor housing.
          */
          <div className="md:hidden flex-none pt-safe" />
        ) : (
          <div className="md:hidden flex items-center gap-2 px-3 min-h-[48px] pt-safe border-b border-[var(--kin-hairline)] flex-none">
            {draftActive ? (
              <button
                type="button"
                onClick={closeDraft}
                className="min-w-[44px] min-h-[44px] -ml-1 flex items-center justify-center text-kin-blue"
                aria-label={tr("app.close")}
              >
                <svg
                  width="21"
                  height="21"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.1"
                  strokeLinecap="round"
                >
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setMobileOpen(true)}
                className="min-w-[44px] min-h-[44px] -ml-1 flex items-center justify-center text-kin-blue"
                aria-label={tr("app.openMenu")}
              >
                <svg
                  width="22"
                  height="22"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" />
                </svg>
              </button>
            )}
            {barIsHeading ? (
              <h1 className="font-semibold text-[15px]">{mobileTitle}</h1>
            ) : (
              <span className="font-semibold text-[15px]">{mobileTitle}</span>
            )}
            {onSessionsTab && (
              <button
                type="button"
                onClick={openNewChat}
                className="ml-auto min-w-[44px] min-h-[44px] flex items-center justify-center text-kin-blue"
                aria-label={tr("nav.newChat")}
              >
                <svg
                  width="22"
                  height="22"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.9"
                  strokeLinecap="round"
                >
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </button>
            )}
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              className={`${onSessionsTab ? "" : "ml-auto "}min-w-[44px] min-h-[44px] flex items-center justify-center text-kin-tertiary`}
              aria-label={tr("app.commandPalette")}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="m21 21-4.3-4.3" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        )}

        {/*
          Below the bar, not above it. As the topmost element this pushed the
          one bar that owns `pt-safe` down the screen, so the inset was spent on
          a gap under the banner instead of on the notch, and the bar itself
          still rendered under the sensor housing.
        */}
        {wsStatus !== "connected" && (
          <div
            className="flex-none bg-[rgba(255,159,10,.12)] border-b border-[rgba(255,159,10,.25)] text-kin-orange text-[12px] text-center px-3 py-1.5"
            role="status"
          >
            {tr("app.reconnecting")}
          </div>
        )}

        <main className="flex-1 min-h-0 overflow-hidden flex flex-col">{children}</main>

        {/* The phone's three primary jobs. Hidden on the draft screen, which is
            a focused flow with its own way out. */}
        {location.pathname !== DRAFT_PATH && <MobileTabBar pendingCount={pendingCount} />}

        {/* Terminal panel — desktop only */}
        {desktop && (
          <TerminalPanel
            open={terminalOpen}
            cwd={terminalCwd}
            notice={terminalNotice}
            onClose={() => setTerminalOpen(false)}
          />
        )}
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onNewChat={openNewChat}
        onToggleTerminal={toggleTerminal}
        terminalAvailable={desktop}
      />
    </div>
  );
}
