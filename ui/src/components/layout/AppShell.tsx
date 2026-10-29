import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  deleteTask,
  getSettings,
  getUsageSummary,
  listAgents,
  listAgentSessionsPage,
  type AgentInfo,
  type AgentSession,
  type AgentSessionImportResult,
  type Approval,
  type Task,
} from "../../api/client";
import { liveResources } from "../../api/liveResources";
import { useTaskList, useTaskResource } from "../../api/useLiveResources";
import { DRAFT_PATH, setDraftCwd, getDraftCwd, subscribeDraft } from "../../lib/draftChat";
import { importToast } from "../../lib/agentSessionImport";
import { useAgentSessionImport, importsInFlight } from "../../hooks/useAgentSessionImport";
import { useT } from "../../i18n/react";
import CommandPalette from "../CommandPalette";
import { useAppStore } from "../../store/appStore";
import Sidebar from "./Sidebar";
import MobileHeader, { IdentityDisc, MobileHeaderButton } from "../mobile/MobileHeader";
import MobileDock from "../mobile/MobileDock";
import SessionsHeader from "../mobile/SessionsHeader";
import { IconSearch, IconX } from "../icons";
import TerminalPanel from "../terminal/TerminalPanel";
import { isKinDesktop } from "../../lib/desktop";
import { isTerminalToggle, localTerminalCwd } from "../../lib/terminal";
import {
  SHELL_VIEW,
  isPanelAvailable,
  panelForView,
  resolvePanel,
  type PanelContext,
  type PanelId,
} from "../../lib/panels";
import { useMachines } from "../../hooks/useMachines";
import { remoteMachine } from "../../lib/devices";
import { taskDisplayTitle } from "../../lib/taskTitle";
import { placePath } from "../../lib/places";
import { floatingApprovals } from "../../lib/floatingApprovals";
import { useApprovalDecision } from "../../hooks/useApprovalDecision";
import FloatingApproval from "../cards/FloatingApproval";

type Props = {
  children: ReactNode;
  pendingCount: number;
  /** The waiting approvals themselves, so one can be answered from any screen. */
  pendingApprovals: Approval[];
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
export default function AppShell({
  children,
  pendingCount,
  pendingApprovals,
  routineUnreadCount = 0,
}: Props) {
  const location = useLocation();
  const navigate = useNavigate();
  const tr = useT();
  const selectedTaskId = taskIdFromPath(location.pathname);
  const draftActive = location.pathname === DRAFT_PATH;
  const desktop = isKinDesktop();
  // On the phone there is no sidebar to say where you are, so the header has to.
  const pathname = location.pathname.replace(/\/+$/, "") || "/";
  const approvalDecision = useApprovalDecision();
  // One approval can be answered from every screen, but not from the two that
  // already show it: the inbox lists them all, and a task's own transcript
  // renders its approval inline. See `lib/floatingApprovals.ts`.
  const floating = floatingApprovals(pendingApprovals, {
    onInbox: pathname === placePath("inbox"),
    visibleTaskId: selectedTaskId,
  });
  /**
   * The pages that are a single list or form, where the shell bar can carry the
   * page's name. A detail route is excluded on purpose: its title is the item's,
   * which the route cannot know, so the page keeps its own heading.
   */
  const listTitle = !desktop
    ? pathname === "/agents"
      ? tr("nav.agents")
      : pathname === "/tasks"
        ? tr("nav.tasks")
        : pathname === "/artifacts"
          ? tr("nav.artifacts")
          : pathname === "/projects"
            ? tr("nav.projects")
            : pathname === "/routines"
              ? tr("nav.routines")
              : ""
    : "";
  const mobileTitle = draftActive
    ? tr("nav.newChat")
    : location.pathname.startsWith("/sessions")
      ? tr("nav.sessions")
      : location.pathname.startsWith("/inbox")
        ? tr("nav.inbox")
        : location.pathname.startsWith("/settings")
          ? tr("nav.settings")
          : listTitle || tr("app.name");
  const onSessionsTab = location.pathname.startsWith("/sessions");

  /**
   * Routes whose page title lives in this bar on a phone. Each of them hides
   * its own `<h1>` below `md` so the same word cannot appear twice (it did,
   * between `sm` and `md`). Everywhere else the bar only names the app and the
   * page's heading is still on screen, so the bar is a heading on these routes
   * only — which keeps exactly one visible `<h1>` at every width.
   *
   * `/sessions` is not one of them any more: it renders `SessionsHeader`, which
   * has no title (the rows are the page), and the page keeps its own `<h1>`
   * for assistive tech at every width.
   *
   * The draft is not one of them: its page opens with the greeting as its own
   * `<h1>`, so the bar names the screen in a span.
   */
  const barIsHeading =
    location.pathname.startsWith("/inbox") ||
    location.pathname.startsWith("/settings") ||
    listTitle !== "";

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

  /** Detail routes whose page renders `MobileHeader` (and its own top inset). */
  const pageOwnsTopInset = selectedTaskId !== null;

  /**
   * The dock floats over the page, so the shell reserves its height under the
   * content instead of every scroll container guessing at it. Doing it here is
   * what makes it true for pages that were written before the dock existed —
   * settings kept its last card under the pill, and its last control was not
   * reachable because the page believed it had reached the bottom.
   */
  const dockVisible = !detailRoute && location.pathname !== DRAFT_PATH;

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
  // Zen: chrome out of the way, session untouched. State, not a preference —
  // nothing writes it anywhere, so a reload is always back to the shell (P3 plan
  // §2.3). What it hides is decided in `index.css` by the `kin-zen-hide` marker.
  const [zen, setZen] = useState(false);
  const [externalSessions, setExternalSessions] = useState<AgentSession[]>([]);
  const [agentCatalog, setAgentCatalog] = useState<AgentInfo[]>([]);
  const agentCatalogRequest = useRef(0);
  const autoImportInFlight = useRef(false);
  const externalRefreshInFlight = useRef(false);
  const externalRefreshQueued = useRef(false);
  const [draftCwdLocal, setDraftCwdLocal] = useState<string>("");
  const pushToast = useAppStore((s) => s.pushToast);
  const wsStatus = useAppStore((s) => s.wsStatus);
  // Read here rather than beside the task panel below, because the session sync
  // needs the machine list too: importing a session means asking the machine
  // that holds it, and the list of machines is what says which those are.
  const { machines } = useMachines();
  // The fan-out itself lives in the hook, because the settings section offers
  // the same errand under the same label and must ask the same machines. The
  // hook also owns the busy flag, so the sidebar's control and the settings
  // page's disable each other: two fan-outs a second apart would report counts
  // that are each other's duplicates.
  const { importing: importingExternalSessions, importEveryMachine } = useAgentSessionImport();

  /**
   * Import the sessions of this machine and every other one, and say what came
   * back.
   *
   * The refresh loop below is deliberately dependency-free — it holds a 30s
   * interval and re-subscribing it on every machine-list update would restart
   * the clock — so the sync reads the current import through a ref instead of
   * capturing the first one, which would be the one built before any machine
   * was known.
   */
  const importEveryMachineRef = useRef(importEveryMachine);
  useEffect(() => {
    importEveryMachineRef.current = importEveryMachine;
  }, [importEveryMachine]);

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
        // A manual import in flight is the person's own errand, and it already
        // imports from every machine: the tick has nothing to add and would only
        // make the count wrong. The flag above cannot see it — that one is only
        // ever set here — so this asks the hook's counter, and it asks now
        // rather than before the settings read: that read is an await, and an
        // import that starts while the tick waits for settings is still one that
        // started first.
        if (settings?.["agent_sessions.auto_import_mode"] === "enabled" && !importsInFlight()) {
          autoImportInFlight.current = true;
          try {
            const result = await importEveryMachineRef.current();
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
      try {
        const result = await importEveryMachine(agents);
        await loadExternalSessions(true);
        const toast = importToast(result, tr);
        pushToast(toast.message, toast.kind);
      } catch (e) {
        // Unreachable today — the hook answers every failure with a result,
        // including a machine that never replied. It stays because the button
        // is the only thing a person can press: if a later change to the hook
        // makes it throw, the alternative is a control that looks like it did
        // nothing at all.
        pushToast(tr("settings.localAgents.importFailed"), "error");
      }
    },
    [importingExternalSessions, importEveryMachine, loadExternalSessions, pushToast, tr],
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

  // The terminal is the shell's panel, and the shell's panel is the one keyed to
  // no session: there is one instance, and its directory follows the route. It
  // goes through the same store as the session panels, so `Ctrl+\`` over an open
  // workspace panel replaces it instead of painting on top of it.
  const shownPanel = useAppStore((s) => s.shownPanel);
  const togglePanel = useAppStore((s) => s.togglePanel);
  // The terminal belongs to no session, so its view key is the shell's. It is
  // still rendered unconditionally on desktop and told whether to be open, even
  // though a closed panel is invisible: `TerminalPanel` mounts its PTY on first
  // open and keeps it, and unmounting on close would kill the shell.
  //
  // Memoised on `desktop` alone: a fresh object here would rebuild the command
  // palette's row list on every render (the shell re-renders on each WS tick).
  const shellCtx: PanelContext = useMemo(
    () => ({ taskId: null, remote: false, desktop }),
    [desktop],
  );
  // Asked of the table rather than of `desktop` directly, so "where is there a
  // terminal" has one answer and the shortcut, the panel and the palette cannot
  // disagree about it.
  const terminalAvailable = isPanelAvailable("terminal", shellCtx);
  const terminalPanel = resolvePanel(panelForView(shownPanel, SHELL_VIEW), shellCtx);
  // The shell's way to open any of its panels, by id. The palette asks for one by
  // the id its table names rather than for a specific panel, so a panel added to
  // the table needs no second entry point here.
  const toggleShellPanel = useCallback(
    (id: PanelId) => {
      togglePanel(SHELL_VIEW, id);
    },
    [togglePanel],
  );
  const toggleTerminal = useCallback(() => {
    toggleShellPanel("terminal");
  }, [toggleShellPanel]);

  const openNewSessionInProject = useCallback(
    (cwd: string) => {
      setDraftCwd(cwd);
      navigate(`${DRAFT_PATH}?cwd=${encodeURIComponent(cwd)}`);
    },
    [navigate],
  );

  const handleDeleteSession = useCallback(
    async (task: Task) => {
      // A task with neither a title nor a prompt is rare enough that the id is
      // better than a blank line in a confirmation dialog.
      const title = taskDisplayTitle(task) || task.id;
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

  // ⌘N new chat · ⌘K command palette · Ctrl+Backquote toggle terminal · ⌘. zen
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // A held key is one press: `isTerminalToggle` already refuses repeats, and
      // without this the two chords that toggle a surface (⌘K, ⌘.) strobe.
      if (e.repeat) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        openNewChat();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
      // Not while the palette is up: it is a modal surface with its own key
      // handling, and hiding the chrome behind it is a change nobody asked for.
      if ((e.metaKey || e.ctrlKey) && e.key === "." && !paletteOpen) {
        e.preventDefault();
        setZen((v) => !v);
      }
      if (terminalAvailable && isTerminalToggle(e)) {
        e.preventDefault();
        e.stopPropagation();
        toggleTerminal();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [terminalAvailable, openNewChat, toggleTerminal, paletteOpen]);

  // Which machine the open task runs on. Read from the task resource the page
  // itself uses, not from the sidebar list: that list is capped and filtered by
  // search, and a task missing from it would silently drop the guard below.
  const openTaskDetail = useTaskResource(selectedTaskId ?? "", Boolean(selectedTaskId));
  const openTask = selectedTaskId ? openTaskDetail.data.task : undefined;
  // The terminal is a shell on *this* machine. A task running on another machine
  // has a cwd that means something only over there, so it must not become this
  // shell's starting directory; the panel says why instead.
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
    <div
      className={`touch-lg h-[100dvh] flex bg-[var(--kin-page)] text-kin-text overflow-hidden safe-pad ${
        zen ? "kin-zen" : ""
      }`}
    >
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
        {detailRoute && !pageOwnsTopInset ? (
          /*
            No bar, but still the top inset. The page below draws its own
            header, and exactly one element must own the notch: handing that
            job to the page would mean every future detail screen has to
            remember `pt-safe`, and getting it wrong puts a title under the
            sensor housing. The session screen is the exception: it now draws a
            `MobileHeader`, which applies the inset itself — reserving it here
            too would spend the notch twice.
          */
          <div className="md:hidden flex-none pt-safe kin-zen-hide" />
        ) : detailRoute ? null : onSessionsTab ? (
          /*
            The list's own bar: identity, in-place search, inbox and settings.
            No page title — the rows are the page — and no hamburger, because
            the identity disc is the drawer trigger here. The command palette
            icon is gone from this route too: search is the field in the middle
            now, and a second search affordance beside it would be a question
            about which one filters the list.
          */
          <SessionsHeader
            pendingCount={pendingCount}
            onOpenMenu={() => setMobileOpen(true)}
            onOpenInbox={() => navigate(placePath("inbox"))}
            onOpenSettings={() => navigate(placePath("settings"))}
          />
        ) : (
          <MobileHeader
            heading={barIsHeading}
            title={mobileTitle}
            leading={
              /*
                The drawer is the phone's only navigation, so its trigger is on
                every screen including the draft. The draft used to swap this
                button for a close ×, which left the landing screen — the one
                the FAB opens and the one most sessions start from — with no way
                into settings, the inbox, or any other session. The × moved to
                the trailing cluster, where the compose screens already put
                cancel.
              */
              <MobileHeaderButton
                label={tr("app.openMenu")}
                onClick={() => setMobileOpen(true)}
              >
                {/* The same identity disc the sessions bar leads with: the
                    drawer is one destination, and one shape for it on every
                    screen. A hamburger here and a disc there made the two
                    pages look like they opened different things. */}
                <IdentityDisc />
              </MobileHeaderButton>
            }
            trailing={
              <>
                {/* No "+" here: the dock's FAB is the same action, 100px
                    below, and two identical buttons in one viewport make the
                    screen look unsure which one it means. */}
                <MobileHeaderButton
                  label={tr("app.commandPalette")}
                  onClick={() => setPaletteOpen(true)}
                  tone="muted"
                >
                  <IconSearch size={18} />
                </MobileHeaderButton>
                {draftActive && (
                  <MobileHeaderButton label={tr("app.close")} onClick={closeDraft} tone="muted">
                    <IconX size={20} strokeWidth={2.1} />
                  </MobileHeaderButton>
                )}
              </>
            }
          />
        )}

        {/*
          Below the bar, not above it. As the topmost element this pushed the
          one bar that owns `pt-safe` down the screen, so the inset was spent on
          a gap under the banner instead of on the notch, and the bar itself
          still rendered under the sensor housing.
        */}
        {wsStatus !== "connected" && (
          <div
            className={[
              "flex-none bg-kin-orange/10 border-b border-kin-orange/25 text-kin-orange-ink text-body text-center px-3 pb-1.5",
              // On the session screen the page draws its own `MobileHeader`
              // *below* this banner, so nothing above the banner owns the
              // notch. Without this the reconnect strip — shown on every cold
              // load, because `wsStatus` starts as "disconnected" — rendered
              // under the sensor housing and then the header spent the inset
              // a second time beneath it.
              pageOwnsTopInset ? "pt-safe" : "pt-1.5",
            ].join(" ")}
            role="status"
          >
            {tr("app.reconnecting")}
          </div>
        )}

        <main
          className={[
            "kin-main flex-1 min-h-0 overflow-hidden flex flex-col",
            dockVisible ? "kin-dock-pad" : "",
          ].join(" ")}
        >
          {children}
        </main>

        {/* The phone's three primary jobs. Hidden on the draft screen, which
            is a focused flow with its own way out, and on detail routes — a
            pushed chat owns the whole screen, and its back button is the way
            out (the iOS convention). */}
        {dockVisible && <MobileDock />}

        {/* An approval blocks the agent that asked for it wherever the reader
            happens to be. The dock's presence decides the offset, because on
            the phone the card has to clear the pill and its "new chat" button,
            and on a pushed conversation the composer sits where the dock would
            be. See `FloatingApproval` for which one it shows. */}
        <FloatingApproval
          approvals={floating}
          titleFor={(taskId) =>
            taskDisplayTitle(tasks.find((task) => task.id === taskId))
          }
          busy={approvalDecision.busy}
          onDecide={(id, decision) => void approvalDecision.decide(id, decision)}
          onOpenTask={(taskId) => navigate(`/tasks/${encodeURIComponent(taskId)}`)}
          raised={dockVisible}
        />

        {/* Terminal panel — the shell's own panel, desktop only */}
        {terminalAvailable && (
          <TerminalPanel
            open={terminalPanel === "terminal"}
            cwd={terminalCwd}
            notice={terminalNotice}
            onClose={() => togglePanel(SHELL_VIEW, "terminal")}
          />
        )}
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onNewChat={openNewChat}
        onTogglePanel={toggleShellPanel}
        panelCtx={shellCtx}
      />
    </div>
  );
}
