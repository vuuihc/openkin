import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  ensureProject,
  formatCost,
  isTerminal,
  type AgentInfo,
  type AgentSession,
  type Task,
} from "../../api/client";
import { useT } from "../../i18n/react";
import { isImeKeyEvent } from "../../lib/ime";
import { getDraftCwd, getDraftPrompt, subscribeDraft } from "../../lib/draftChat";
import {
  archiveProject,
  getProjectSortMode,
  setProjectSortMode,
  subscribeProjectSidebar,
  toggleProjectPinned,
  touchProject,
  touchSession,
  unarchiveProject,
  type ProjectGroup,
  type ProjectSortMode,
} from "../../lib/projectSidebar";
import {
  groupByDevice,
  ONLY_THIS_MACHINE,
  projectKey,
  sessionsForProject,
  type DeviceGroup,
} from "../../lib/deviceSidebar";
import { useMachines } from "../../hooks/useMachines";
import { useCoarsePointer } from "../../hooks/useMediaQuery";
import { useMinWidth } from "../../hooks/useMinWidth";
import { placeById, PLACES, type PlaceId } from "../../lib/places";
import { PLACE_ICONS } from "../placeIcons";
import {
  getViewedSessionIds,
  isSessionViewed,
  markSessionViewed,
  sessionStatusDotClass,
  subscribeSessionViewed,
} from "../../lib/sessionViewed";
import { taskDisplayTitle } from "../../lib/taskTitle";
import { agentAvatarMeta, agentDisplayName } from "../../lib/agentMention";
import {
  agentSessionAvailability,
  displayAgentSessionTitle,
  type AgentSessionAvailability,
} from "../../lib/agentSessionTitle";
import {
  IconArchive,
  IconFile,
  IconChevron,
  IconDownload,
  IconInbox,
  IconMore,
  IconPin,
  IconPlus,
  IconSearch,
  IconSort,
  IconTrash,
  IconX,
} from "../icons";
import { IonActionSheet } from "@ionic/react";

type Props = {
  tasks: Task[];
  selectedTaskId?: string | null;
  /** Highlight the draft / New chat entry. */
  draftActive?: boolean;
  pendingCount: number;
  routineUnreadCount?: number;
  weekCost?: number | null;
  onNewChat: () => void;
  /** New session scoped to a project cwd (Claude/Codex style). */
  onNewSessionInProject?: (cwd: string) => void;
  /** Permanently delete a session/task. */
  onDeleteSession?: (task: Task) => void;
  externalSessions?: AgentSession[];
  agentCatalog?: AgentInfo[];
  importingExternalSessions?: boolean;
  onImportExternalSessions?: (agents?: string[]) => void;
  onOpenExternalSession?: (session: AgentSession) => void;
  /** Mobile drawer open. Desktop always visible. */
  mobileOpen: boolean;
  onCloseMobile: () => void;
  /** Controlled session search (server-side fuzzy over all tasks). */
  searchQuery?: string;
  onSearchQueryChange?: (q: string) => void;
  searchLoading?: boolean;
};

/** Normalize path for cwd comparison across platforms. */
function normCwd(cwd: string): string {
  return cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function readSidebarDisclosure(key: string): boolean {
  try {
    return localStorage.getItem(`kin_sidebar_open:${key}`) !== "0";
  } catch {
    return true;
  }
}

function useSidebarDisclosure(key: string): [boolean, () => void] {
  const [open, setOpen] = useState(() => readSidebarDisclosure(key));
  const toggle = () => {
    setOpen((current) => {
      const next = !current;
      try {
        localStorage.setItem(`kin_sidebar_open:${key}`, next ? "1" : "0");
      } catch {
        // Ignore unavailable local storage.
      }
      return next;
    });
  };
  return [open, toggle];
}

export default function Sidebar({
  tasks,
  selectedTaskId,
  draftActive,
  pendingCount,
  routineUnreadCount = 0,
  weekCost,
  onNewChat,
  onNewSessionInProject,
  onDeleteSession,
  externalSessions = [],
  agentCatalog = [],
  importingExternalSessions = false,
  onImportExternalSessions,
  onOpenExternalSession,
  mobileOpen,
  onCloseMobile,
  searchQuery = "",
  onSearchQueryChange,
  searchLoading = false,
}: Props) {
  const tr = useT();
  const navigate = useNavigate();
  const location = useLocation();
  const draftCwd = useSyncExternalStore(subscribeDraft, getDraftCwd, () => "");
  const draftPrompt = useSyncExternalStore(subscribeDraft, getDraftPrompt, () => "");
  /** Keep the draft row visible when navigating away with unsent text (or any draft cwd). */
  const hasDraft = Boolean(draftActive || draftPrompt.trim());
  // Re-render when sort / pin / archive / last-interact prefs change.
  const [prefsTick, setPrefsTick] = useState(0);
  useEffect(() => subscribeProjectSidebar(() => setPrefsTick((n) => n + 1)), []);
  // Re-render when a session is marked viewed (green completion dot → clear).
  useSyncExternalStore(
    subscribeSessionViewed,
    () => getViewedSessionIds().slice().sort().join(","),
    () => "",
  );

  const sortMode = getProjectSortMode();
  // Which machine runs a session is the first thing the tree answers, so the
  // device list is read here rather than passed down: a console that has not
  // heard back yet still shows one unnamed machine (this one), never raw ids.
  const { machines, loading: machinesLoading } = useMachines();
  // prefsTick invalidates after localStorage updates (sort / pin / archive / interact).
  const machineList = machines.length > 0 ? machines : ONLY_THIS_MACHINE;
  const archivedGroups = useMemo(
    () => groupByDevice(tasks, externalSessions, machineList, null, true, machinesLoading),
    [tasks, externalSessions, machineList, machinesLoading, prefsTick],
  );
  const groups = useMemo(
    () => groupByDevice(tasks, externalSessions, machineList, null, false, machinesLoading),
    [tasks, externalSessions, machineList, machinesLoading, prefsTick],
  );
  // One tree, one width: a phone has no sidebar to hold the list, and the
  // drawer is entries only. Rendering both copies and hiding one with CSS left
  // the other's search field in the document, which is how the same list grew
  // two search boxes.
  const wide = useMinWidth(768);
  // An iPad gets the desktop layout at ≥768px but not a mouse. On a coarse
  // pointer a row that changes on hover spends the first tap on the hover
  // state, and a control only revealed by hover is never reached; the two
  // touch shapes below (no hover styling, the project action sheet) are keyed
  // on the pointer rather than the width for exactly that reason.
  const coarse = useCoarsePointer();
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLElement>(null);

  /**
   * ↑/↓ walk the conversation rows from the search box and from one row to the
   * next; Enter opens the focused row because a row is a link; Escape empties
   * the query and leaves the field. The results are the list itself rather
   * than a dropdown, so the keyboard model lives on the list.
   */
  function sessionRows(): HTMLElement[] {
    return Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-session-row]") ?? []);
  }

  function onSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (isImeKeyEvent(event.nativeEvent)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      onSearchQueryChange?.("");
      event.currentTarget.blur();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = sessionRows();
    if (rows.length === 0) return;
    event.preventDefault();
    (event.key === "ArrowDown" ? rows[0] : rows[rows.length - 1])?.focus();
  }

  function onListKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.defaultPrevented || isImeKeyEvent(event.nativeEvent)) return;
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = sessionRows();
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if (at === -1) return;
    event.preventDefault();
    const next =
      event.key === "ArrowDown" ? Math.min(at + 1, rows.length - 1) : Math.max(at - 1, 0);
    rows[next]?.focus();
  }
  const archivedSectionRef = useRef<HTMLDivElement>(null);
  const archivedScope = new URLSearchParams(location.search).get("scope") === "archived";
  // On a Mac the archived address is a filter of this one list, not a second
  // list in the main area. Following such a link (a restored window, a shared
  // URL) opens the section, where the phone's drawer entry already leads.
  useEffect(() => {
    if (wide && archivedScope) setArchivedOpen(true);
  }, [archivedScope, wide]);
  /**
   * The project whose overflow sheet is open.
   *
   * A phone cannot hover, so the three per-project actions that the desktop
   * row reveals on hover used to be re-rendered as three full-width buttons in
   * the expanded body — three 44px controls per project, each the width of the
   * drawer, which buried the session list and ran off the bottom of the
   * screen. One 44px `⋯` in the project row opens all of them in an action
   * sheet instead, which is the same affordance iOS uses for a row's secondary
   * actions.
   */
  const [projectMenu, setProjectMenu] = useState<{
    group: ProjectGroup;
    mode: "active" | "archived";
  } | null>(null);
  const sortMenuRef = useRef<HTMLDivElement>(null);
  const [importMenuOpen, setImportMenuOpen] = useState(false);
  const importMenuRef = useRef<HTMLDivElement>(null);
  const sessionProviders = agentCatalog.filter((agent) =>
    agent.capabilities?.includes("session_list"),
  );

  useEffect(() => {
    if (!sortMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!sortMenuRef.current?.contains(e.target as Node)) setSortMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSortMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [sortMenuOpen]);

  useEffect(() => {
    if (!importMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!importMenuRef.current?.contains(e.target as Node)) setImportMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setImportMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [importMenuOpen]);

  // When the user opens a task, bump its project last-interact so "recent" stays fresh.
  // Also restores the project if it was archived (open ⇒ unarchive).
  //
  // Green completion dots: mark viewed at most once per navigation into a
  // session. If the open session later flips to terminal, do NOT mark — the
  // green "done" marker must remain until the user leaves and re-opens (or
  // clicks the row). tasks[] may load after the route, so we wait until the
  // selected row exists before deciding.
  const handledSelectionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedTaskId) {
      handledSelectionRef.current = null;
      return;
    }
    const t = tasks.find((x) => x.id === selectedTaskId);
    if (t?.cwd) touchProject(t.cwd);
    if (!t) return; // wait for sidebar list / WS to populate the row

    // Already decided for this selection (including "was open while running").
    if (handledSelectionRef.current === selectedTaskId) return;

    // First time we resolve this navigation: bump session recency for in-project sort.
    touchSession(selectedTaskId);

    if (isTerminal(t.status)) {
      markSessionViewed(t.id);
    }
    // Record whether terminal or not — a later status flip on the same
    // selection must not clear the green dot.
    handledSelectionRef.current = selectedTaskId;
  }, [selectedTaskId, tasks]);

  // A draft belongs to one machine. The same cwd can be a project on several
  // machines, so matching on the path alone would nest a "New chat" row under
  // each of them.
  const draftHome =
    hasDraft && draftCwd
      ? [...groups, ...archivedGroups].reduce<{ deviceId: string; cwd: string } | null>(
          (found, device) => {
            if (found) return found;
            const g = device.projects.find((p) => normCwd(p.cwd) === normCwd(draftCwd));
            return g ? { deviceId: device.id, cwd: g.cwd } : null;
          },
          null,
        )
      : null;
  const draftGroupCwd = draftHome?.cwd ?? null;
  // Show orphan "New chat" tab when we have a draft and it is not nested under a project group.
  const showOrphanDraft = Boolean(hasDraft && !draftGroupCwd);

  const pickSort = (mode: ProjectSortMode) => {
    setProjectSortMode(mode);
    setSortMenuOpen(false);
  };

  const onArchive = (g: ProjectGroup) => {
    const ok = window.confirm(tr("nav.archiveConfirm", { project: g.label }));
    if (!ok) return;
    archiveProject(g.cwd);
  };

  /**
   * One project row, on the machine that holds it.
   *
   * Archived projects differ in three ways only: new sessions restore them,
   * the pin button is inert, and the archive button means the opposite.
   */
  const projectBlock = (g: ProjectGroup, device: DeviceGroup, mode: "active" | "archived") => {
    const archived = mode === "archived";
    return (
      <ProjectBlock
        key={`${device.id}:${mode}:${g.cwd}`}
        group={g}
        nestDraft={Boolean(
          hasDraft && draftHome?.deviceId === device.id && draftHome.cwd === g.cwd,
        )}
        draftRowActive={Boolean(draftActive)}
        selectedTaskId={selectedTaskId}
        draftLabel={tr("nav.draftChat")}
        onDraftClick={() => {
          navigate("/new");
          onCloseMobile();
        }}
        onCloseMobile={onCloseMobile}
        onNewSession={() => {
          if (archived) unarchiveProject(g.cwd);
          touchProject(g.cwd);
          if (onNewSessionInProject) onNewSessionInProject(g.cwd);
          else onNewChat();
          onCloseMobile();
        }}
        onTogglePin={() => toggleProjectPinned(g.cwd)}
        onArchive={() => (archived ? unarchiveProject(g.cwd) : onArchive(g))}
        onMenu={() => setProjectMenu({ group: g, mode })}
        pinLabel={g.pinned && !archived ? tr("nav.unpinProject") : tr("nav.pinProject")}
        collapseLabel={tr("nav.collapseProject")}
        expandLabel={tr("nav.expandProject")}
        coverLabel={tr("nav.openCover")}
        archiveLabel={archived ? tr("nav.unarchiveProject") : tr("nav.archiveProject")}
        newSessionLabel={tr("nav.newSessionIn", { project: g.label })}
        menuLabel={tr("nav.projectActions")}
        onDeleteSession={onDeleteSession}
        deleteLabel={tr("task.deleteSession")}
        coarse={coarse}
        externalSessions={sessionsForProject(device.sessions, g)}
        onOpenExternalSession={onOpenExternalSession}
        mode={mode}
      />
    );
  };

  const header = (drawer: boolean) => (
    <div className="px-3 pt-3 pb-2 max-md:px-3 max-md:pt-4 max-md:pb-3 flex items-center gap-2">
      {/* The mark, flat: the accent fill every primary action already uses.
          There were two different gradients for this same "K" in the tree —
          this one and the chat avatar's — which is two brand palettes, not
          one. The gradient also could not carry white initials at 4.5:1 at
          both of its ends. */}
      <div className="w-7 h-7 max-md:h-8 max-md:w-8 rounded-lg bg-kin-blue flex items-center justify-center text-kin-on-brand text-strong font-semibold shadow-e1">
        K
      </div>
      <span className="text-strong max-md:text-subtitle font-semibold tracking-tight">
        {tr("app.name")}
      </span>
      <div className="ml-auto flex items-center gap-1">
        {!drawer && (
          <div className="relative" ref={sortMenuRef}>
            <button
              type="button"
              title={tr("nav.sortProjects")}
              aria-label={tr("nav.sortProjects")}
              aria-expanded={sortMenuOpen}
              aria-haspopup="menu"
              onClick={() => setSortMenuOpen((o) => !o)}
              className="w-7 h-7 max-md:h-11 max-md:w-11 max-md:rounded-full rounded-md inline-flex items-center justify-center text-kin-muted hover:text-kin-text hover:bg-[var(--kin-fill-strong)] max-md:active:bg-[var(--kin-fill)] transition-colors"
            >
              <IconSort size={15} className="max-md:h-[18px] max-md:w-[18px]" />
            </button>
            {sortMenuOpen && (
              <div
                role="menu"
                className="absolute right-0 top-full mt-1 z-50 min-w-menu rounded-lg bg-kin-elevated shadow-e3 py-1"
                onKeyDown={(e) => {
                  if (e.key === "Escape") setSortMenuOpen(false);
                }}
              >
                {(
                  [
                    ["active", "nav.sortByActive"],
                    ["created", "nav.sortByCreated"],
                  ] as const
                ).map(([mode, key]) => {
                  const active = sortMode === mode;
                  return (
                    <button
                      key={mode}
                      type="button"
                      role="menuitemradio"
                      aria-checked={active}
                      onClick={() => pickSort(mode)}
                      className={[
                        "w-full text-left px-3 py-1.5 text-body transition-colors",
                        active
                          ? "text-kin-text bg-[var(--kin-fill-strong)]"
                          : "text-kin-secondary hover:bg-[var(--kin-fill)] hover:text-kin-text",
                      ].join(" ")}
                    >
                      {tr(key)}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
        {drawer && (
          // The drawer's own dismissal. The scrim still closes it, but a
          // full-height panel that covers 86% of the screen leaves almost no
          // scrim to hit — the close control is the reliable way out.
          <button
            type="button"
            onClick={onCloseMobile}
            aria-label={tr("app.closeMenu")}
            title={tr("app.closeMenu")}
            className="inline-flex h-11 w-11 -mr-2 items-center justify-center rounded-full text-kin-muted active:bg-[var(--kin-fill)]"
          >
            <IconX size={22} />
          </button>
        )}
      </div>
    </div>
  );

  // Escape puts the disclosure away and hands focus back to the button that
  // opened it — the wrapper's first button, which is the trigger in both
  // surfaces. Tab is how the rows are reached; there is no arrow-key model to
  // keep, because the popup is a group of plain buttons rather than a menu.
  const onImportMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    setImportMenuOpen(false);
    importMenuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  };

  // The import entry's menu, shared by the drawer's full-width button and the
  // desktop footer's icon. One list, so the two surfaces cannot offer different
  // imports.
  const importMenuItems = (
    <>
      <button
        type="button"
        // An import that is already running cannot be started again — one
        // fan-out at a time, which is the hook's rule and not this menu's.
        // Disabled rather than ignored, because a menu item that closes
        // the menu and does nothing is a tap that looks like it worked.
        disabled={importingExternalSessions}
        onClick={() => {
          setImportMenuOpen(false);
          onImportExternalSessions?.();
        }}
        className="w-full text-left px-3 py-2 text-body text-kin-text hover:bg-[var(--kin-fill-strong)] disabled:opacity-50"
      >
        {tr("nav.importAllAgents")}
      </button>
      <div className="my-1 border-t border-kin-hairline" />
      {sessionProviders.length > 0 ? (
        sessionProviders.map((provider) => (
          <button
            key={provider.id}
            type="button"
            disabled={importingExternalSessions}
            onClick={() => {
              setImportMenuOpen(false);
              onImportExternalSessions?.([provider.id]);
            }}
            className="w-full flex items-center gap-2 px-3 py-2 text-body text-kin-secondary hover:bg-[var(--kin-fill-strong)] hover:text-kin-text disabled:opacity-50"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-kin-blue" />
            <span className="truncate">{provider.name || provider.id}</span>
            <span className="ml-auto text-micro text-kin-muted">{provider.id}</span>
          </button>
        ))
      ) : (
        <div className="px-3 py-2 text-caption text-kin-muted">{tr("nav.noSessionProviders")}</div>
      )}
    </>
  );

  const importBlock = (
    <div className="px-3 pb-2 relative" ref={importMenuRef}>
      <button
        type="button"
        disabled={importingExternalSessions || !onImportExternalSessions}
        aria-expanded={importMenuOpen}
        onClick={() => setImportMenuOpen((open) => !open)}
        className="w-full flex items-center gap-2 px-2.5 h-11 rounded-xl text-strong text-kin-secondary border border-[var(--kin-hairline-strong)] hover:bg-[var(--kin-fill-strong)] hover:text-kin-text disabled:opacity-50 transition-colors"
      >
        <IconDownload size={16} />
        <span className="flex-1 text-left">
          {importingExternalSessions
            ? tr("nav.importingAgentSessions")
            : tr("nav.importAgentSessions")}
        </span>
        <IconChevron
          size={13}
          className={importMenuOpen ? "rotate-90 transition-transform" : "transition-transform"}
        />
      </button>
      {importMenuOpen && (
        <div
          // A disclosure, not a menu: the rows are plain buttons reached by
          // Tab. Calling it a menu promises arrow-key navigation that this
          // popup does not implement, and a screen reader in menu mode
          // swallows the keys it would otherwise use.
          role="group"
          aria-label={tr("nav.importAgentSessions")}
          onKeyDown={onImportMenuKeyDown}
          className="absolute left-3 right-3 top-full mt-1 z-50 rounded-lg bg-kin-elevated shadow-e3 py-1"
        >
          {importMenuItems}
        </div>
      )}
    </div>
  );

  // On a Mac the same entry is one of the footer icons: the left column is one
  // piece — the list, then one row of destinations — and a full-width import
  // button above it was a second navigation block with the same weight as the
  // list it was supposed to serve.
  const importIcon = onImportExternalSessions ? (
    <div className="relative" ref={importMenuRef}>
      <button
        type="button"
        disabled={importingExternalSessions}
        aria-expanded={importMenuOpen}
        aria-label={
          importingExternalSessions
            ? tr("nav.importingAgentSessions")
            : tr("nav.importAgentSessions")
        }
        title={
          importingExternalSessions
            ? tr("nav.importingAgentSessions")
            : tr("nav.importAgentSessions")
        }
        onClick={() => setImportMenuOpen((open) => !open)}
        className={[
          "relative inline-flex h-8 w-8 flex-none items-center justify-center rounded-lg transition-colors",
          importMenuOpen
            ? "bg-[var(--kin-fill-strong)] text-kin-text"
            : "text-kin-muted hover:bg-[var(--kin-fill)] hover:text-kin-text",
          importingExternalSessions ? "opacity-50" : "",
        ].join(" ")}
      >
        <IconDownload size={16} />
      </button>
      {importMenuOpen && (
        <div
          role="group"
          aria-label={tr("nav.importAgentSessions")}
          onKeyDown={onImportMenuKeyDown}
          className="absolute bottom-full left-0 z-50 mb-1 w-60 rounded-lg bg-kin-elevated shadow-e3 py-1"
        >
          {importMenuItems}
        </div>
      )}
    </div>
  ) : null;

  const newChatBlock = (
    <div className="px-2.5 pb-2 max-md:px-3">
      <button
        type="button"
        onClick={() => {
          onNewChat();
          onCloseMobile();
        }}
        className={[
          "w-full flex items-center gap-2 px-2.5 h-9 max-md:h-11 max-md:rounded-xl max-md:font-semibold rounded-lg text-strong font-medium border transition-colors",
          "max-md:border-transparent max-md:bg-kin-blue max-md:text-kin-on-brand max-md:active:opacity-90",
          draftActive
            ? "border-kin-blue/40 bg-kin-blue/15 text-kin-text"
            : "border-[var(--kin-hairline-strong)] bg-[var(--kin-fill)] text-kin-text hover:bg-[var(--kin-fill-strong)]",
        ].join(" ")}
      >
        <IconPlus size={15} strokeWidth={1.9} className="max-md:h-[18px] max-md:w-[18px]" />
        {tr("nav.newChat")}
        <span className="ml-auto text-caption text-kin-muted font-medium hidden sm:inline">⌘N</span>
      </button>
    </div>
  );

  const searchBlock = (
    <div className="px-3 pb-2 max-md:px-3">
      <label className="relative flex items-center">
        <IconSearch
          size={13}
          className="absolute left-2.5 max-md:left-3 text-kin-muted pointer-events-none max-md:h-[17px] max-md:w-[17px]"
        />
        <input
          ref={searchRef}
          data-session-search
          type="search"
          value={searchQuery}
          onChange={(e) => onSearchQueryChange?.(e.target.value)}
          onKeyDown={onSearchKeyDown}
          placeholder={tr("nav.searchSessions")}
          aria-label={tr("nav.searchSessions")}
          className="w-full h-[32px] max-md:h-11 pl-8 max-md:pl-9 pr-2 rounded-lg max-md:rounded-xl bg-[var(--kin-fill)] border border-transparent focus:border-kin-blue/40 focus:bg-[var(--kin-fill-strong)] text-body max-md:text-subtitle text-kin-text placeholder:text-kin-muted outline-none transition-colors"
        />
      </label>
      {searchQuery.trim() && (
        <div className="mt-1 px-0.5 text-caption text-kin-muted">
          {searchLoading ? tr("common.loading") : tr("nav.searchHint")}
        </div>
      )}
    </div>
  );

  const listNav = (
    <nav
      ref={listRef}
      onKeyDown={onListKeyDown}
      className="flex-1 overflow-y-auto px-2 pb-2 max-md:px-3 space-y-3"
    >
      <button
        type="button"
        onClick={() => {
          navigate("/approvals");
          onCloseMobile();
        }}
        className={[
          "w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-strong min-h-9 max-md:min-h-11 max-md:rounded-xl max-md:px-2 max-md:text-body",
          pendingCount > 0
            ? "border border-kin-blue/40 bg-kin-blue/15 text-kin-text"
            : "text-kin-secondary hover:bg-[var(--kin-fill)] hover:text-kin-text",
        ].join(" ")}
      >
        <IconInbox size={15} />
        <span>{tr("nav.inbox")}</span>
        {pendingCount > 0 && (
          <span className="ml-auto min-w-[18px] h-[18px] px-1.5 rounded-full bg-kin-orange text-kin-on-status text-caption font-bold inline-flex items-center justify-center tabular-nums">
            {pendingCount > 99 ? "99+" : pendingCount}
          </span>
        )}
      </button>

      {groups.length === 0 && archivedGroups.length === 0 && (
        <div className="px-2 py-4 text-body text-kin-muted leading-prose">
          {searchQuery.trim()
            ? tr("nav.searchEmpty", { query: searchQuery.trim() })
            : tr("nav.emptyHint")}
        </div>
      )}

      {groups.map((device) => (
        <DeviceSection
          key={device.id || "__self__"}
          device={device}
          label={deviceLabel(device, tr)}
          count={device.count}
          mode="active"
        >
          {device.projects.map((g) => projectBlock(g, device, "active"))}
        </DeviceSection>
      ))}
      {showOrphanDraft && (
        <div>
          <div className="kin-section-label max-md:px-2 max-md:pb-1.5 max-md:normal-case max-md:tracking-normal max-md:text-strong text-kin-muted">
            {tr("nav.draft")}
          </div>
          <DraftRow
            active={Boolean(draftActive)}
            label={tr("nav.draftChat")}
            onClick={() => {
              navigate("/new");
              onCloseMobile();
            }}
          />
        </div>
      )}

      {archivedGroups.length > 0 && (
        <div ref={archivedSectionRef} className="pt-1 border-t border-kin-hairline">
          <button
            type="button"
            onClick={() => setArchivedOpen((o) => !o)}
            className="kin-section-label w-full flex items-center gap-1 pr-0.5 max-md:px-2 max-md:normal-case max-md:tracking-normal max-md:text-strong hover:text-kin-secondary transition-colors"
            aria-expanded={archivedOpen}
          >
            <IconArchive size={11} className="flex-none opacity-70" />
            <span className="truncate flex-1 min-w-0 text-left">{tr("nav.archivedProjects")}</span>
            <span className="text-caption tabular-nums opacity-70">
              {archivedGroups.reduce((n, device) => n + device.projects.length, 0)}
            </span>
            <span
              className={[
                "text-micro opacity-60 transition-transform",
                archivedOpen ? "rotate-90" : "",
              ].join(" ")}
            >
              ▸
            </span>
          </button>
          {archivedOpen && (
            <div className="space-y-3 mt-1">
              {archivedGroups.map((device) => (
                <DeviceSection
                  key={`arch-${device.id || "__self__"}`}
                  device={device}
                  label={deviceLabel(device, tr)}
                  count={device.count}
                  mode="archived"
                >
                  {device.projects.map((g) => projectBlock(g, device, "archived"))}
                </DeviceSection>
              ))}
            </div>
          )}
        </div>
      )}
    </nav>
  );

  // Every destination the sidebar can reach, as one icon row. The list above is
  // the work; the icons are the way out of it. The old footer printed the same
  // destinations as two labelled text groups, which made the rail a second,
  // shorter navigation under the list it was supposed to serve.
  const destinations = PLACES.filter((place) => place.section !== "work");
  const footerIcons = (
    <div data-sidebar-footer className="border-t border-kin-hairline px-1.5 py-2">
      <div className="flex items-center justify-between gap-0.5">
        <FooterIcon
          to="/inbox"
          label={tr("nav.inbox")}
          icon={<IconInbox size={16} />}
          badge={pendingCount > 0 ? (pendingCount > 99 ? "99+" : String(pendingCount)) : undefined}
          onClick={onCloseMobile}
        />
        {archivedGroups.length > 0 && (
          <button
            type="button"
            onClick={() => {
              const next = !archivedOpen;
              setArchivedOpen(next);
              // A long list can put the section below the fold, where the icon
              // highlight is the only feedback; bring it into view on open.
              if (next) {
                requestAnimationFrame(() =>
                  archivedSectionRef.current?.scrollIntoView?.({ block: "nearest" }),
                );
              }
            }}
            aria-label={tr("nav.archivedProjects")}
            aria-expanded={archivedOpen}
            title={tr("nav.archivedProjects")}
            className={[
              "inline-flex h-8 w-8 flex-none items-center justify-center rounded-lg transition-colors",
              archivedOpen
                ? "bg-[var(--kin-fill-strong)] text-kin-text"
                : "text-kin-muted hover:bg-[var(--kin-fill)] hover:text-kin-text",
            ].join(" ")}
          >
            <IconArchive size={16} />
          </button>
        )}
        {importIcon}
        {destinations.map((place) => (
          <FooterIcon
            key={place.id}
            to={place.path}
            label={tr(place.labelKey)}
            icon={(() => {
              const Icon = PLACE_ICONS[place.id];
              return <Icon size={16} />;
            })()}
            badge={
              place.id === "routines" && routineUnreadCount > 0
                ? routineUnreadCount > 99
                  ? "99+"
                  : String(routineUnreadCount)
                : undefined
            }
            title={
              place.id === "agents" && weekCost != null && weekCost > 0
                ? `${tr(place.labelKey)} · ${formatCost(weekCost)}`
                : undefined
            }
            onClick={onCloseMobile}
          />
        ))}
      </div>
    </div>
  );

  const desktopPanel = (
    <aside className="w-sidebar max-w-[85vw] max-md:w-[86vw] max-md:max-w-[22rem] h-full flex flex-col bg-kin-sidebar shrink-0">
      {header(false)}
      {newChatBlock}
      {searchBlock}
      {listNav}
      {footerIcons}
    </aside>
  );

  // The phone's K panel is entries only. A list here was a second copy of the
  // page behind it, with its own search box and its own idea of which row was
  // open; the list already has a home one tap away.
  const drawerEntries = [
    {
      key: "inbox",
      path: "/inbox",
      label: tr("nav.inbox"),
      icon: <IconInbox size={18} />,
      badge: pendingCount,
    },
    {
      key: "archived",
      path: "/sessions?scope=archived",
      label: tr("nav.archivedProjects"),
      icon: <IconArchive size={18} />,
      badge: 0,
    },
    ...["artifacts", "routines", "agents", "settings"].map((id) => {
      const place = placeById(id as PlaceId);
      const Icon = PLACE_ICONS[place.id];
      return {
        key: place.id,
        path: place.path,
        label: tr(place.labelKey),
        icon: <Icon size={18} />,
        badge: place.id === "routines" ? routineUnreadCount : 0,
      };
    }),
  ];
  // `NavLink` matches a path, not a query, so the archived entry's
  // `/sessions?scope=archived` looked active on the phone's plain list too.
  const archivedEntryActive =
    location.pathname === "/sessions" &&
    new URLSearchParams(location.search).get("scope") === "archived";

  const drawerPanel = (
    <aside className="w-sidebar max-w-[85vw] max-md:w-[86vw] max-md:max-w-[22rem] h-full flex flex-col bg-kin-sidebar shrink-0">
      {header(true)}
      {importBlock}
      {newChatBlock}
      <nav className="flex-1 overflow-y-auto px-3 pb-4 space-y-1">
        {drawerEntries.map((entry) => (
          <NavLink
            key={entry.key}
            to={entry.path}
            onClick={onCloseMobile}
            className={({ isActive }) =>
              [
                "flex min-h-11 items-center gap-3 rounded-xl px-3 text-strong font-medium transition-colors",
                (entry.key === "archived" ? archivedEntryActive : isActive)
                  ? "bg-[var(--kin-fill-strong)] text-kin-text"
                  : "text-kin-secondary hover:bg-[var(--kin-fill)] hover:text-kin-text",
              ].join(" ")
            }
          >
            {entry.icon}
            <span className="flex-1">{entry.label}</span>
            {entry.badge > 0 && (
              <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-kin-blue text-micro font-semibold text-kin-on-brand flex items-center justify-center tabular-nums">
                {entry.badge > 99 ? "99+" : entry.badge}
              </span>
            )}
          </NavLink>
        ))}
      </nav>
    </aside>
  );

  return (
    <>
      {/* Desktop */}
      {wide && <div className="hidden md:flex h-full shrink-0 kin-zen-hide">{desktopPanel}</div>}

      {/* Mobile drawer */}
      {!wide && mobileOpen && (
        <div className="md:hidden fixed inset-0 z-40 flex">
          <button
            type="button"
            className="absolute inset-0 bg-black/50"
            aria-label={tr("app.closeMenu")}
            onClick={onCloseMobile}
          />
          <div
            /*
              `fixed` means the viewport is this box's containing block, so the
              root's `.safe-pad` does not reach it: the drawer re-applies both
              top and bottom insets itself, or its first row sits inside the
              sensor housing and its last one under the home indicator. The
              insets go on this box rather than on the panel inside it because
              the panel's background is what has to stay edge to edge — with the
              padding on the panel, the inset strips showed the scrim instead of
              the sidebar.
            */
            className="kin-drawer-enter relative z-10 h-full shadow-e3 bg-kin-sidebar pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
          >
            {drawerPanel}
          </div>
        </div>
      )}

      {/*
        The touch project actions. One sheet serves every project row, so the
        three hover-only desktop controls have a touch home that costs the row
        no width. It is mounted below 768px (the phone shape) and on any coarse
        pointer, where the desktop layout's hover reveals cannot be reached.
        `role: "destructive"` is Ionic's, and the console's red ink is what it
        paints (index.css) — the default is 2.24:1 on this panel.
      */}
      {(!wide || coarse) && (
        <IonActionSheet
          isOpen={projectMenu !== null}
          onDidDismiss={() => setProjectMenu(null)}
          header={projectMenu?.group.label}
          cssClass="kin-sheet kin-sheet-named"
          buttons={
            projectMenu
              ? [
                  {
                    text: tr("nav.newSessionIn", { project: projectMenu.group.label }),
                    handler: () => {
                      if (projectMenu.mode === "archived") unarchiveProject(projectMenu.group.cwd);
                      touchProject(projectMenu.group.cwd);
                      if (onNewSessionInProject) onNewSessionInProject(projectMenu.group.cwd);
                      else onNewChat();
                      onCloseMobile();
                    },
                  },
                  ...(projectMenu.mode === "active"
                    ? [
                        {
                          text: projectMenu.group.pinned
                            ? tr("nav.unpinProject")
                            : tr("nav.pinProject"),
                          handler: () => toggleProjectPinned(projectMenu.group.cwd),
                        },
                      ]
                    : []),
                  {
                    text: tr("nav.openCover"),
                    handler: () => {
                      void ensureProject({
                        path: projectMenu.group.cwd,
                        name: projectMenu.group.label,
                      })
                        .then((p) => {
                          onCloseMobile();
                          navigate(`/projects/${p.id}`);
                        })
                        .catch(() => {
                          // The cover is optional; a project without one is not
                          // an error worth a dialog.
                        });
                    },
                  },
                  {
                    text:
                      projectMenu.mode === "archived"
                        ? tr("nav.unarchiveProject")
                        : tr("nav.archiveProject"),
                    role: "destructive",
                    handler: () => {
                      if (projectMenu.mode === "archived") unarchiveProject(projectMenu.group.cwd);
                      else onArchive(projectMenu.group);
                    },
                  },
                  { text: tr("common.cancel"), role: "cancel" },
                ]
              : []
          }
        />
      )}
    </>
  );
}

/** What to call a machine in the tree. The console's own machine is named by
 *  where you are looking from, not by whatever the daemon calls itself; any
 *  other group is either a machine the list named or a raw id it did not. */
function deviceLabel(device: DeviceGroup, tr: (key: string) => string): string {
  if (device.isSelf) return tr("nav.thisMachine");
  return device.label;
}

/**
 * One machine's projects, under a heading that says whether it can take work.
 *
 * @param mode      Active and archived render the same machine twice, and each
 *                  keeps its own collapsed state — sharing the key would make
 *                  collapsing one silently pre-collapse the other.
 */
function DeviceSection({
  device,
  label,
  count,
  mode,
  children,
}: {
  device: DeviceGroup;
  label: string;
  count: number;
  mode: "active" | "archived";
  children: ReactNode;
}) {
  const tr = useT();
  const [open, toggle] = useSidebarDisclosure(`device:${mode}:${device.id || "self"}`);
  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left text-body font-medium text-kin-secondary hover:text-kin-text transition-colors max-md:min-h-11 max-md:text-strong max-md:font-semibold max-md:text-kin-muted"
      >
        <IconChevron
          size={11}
          className={["flex-none transition-transform", open ? "rotate-90" : ""].join(" ")}
        />
        <span
          className={[
            "w-1.5 h-1.5 rounded-full flex-none",
            device.online ? "bg-kin-green" : "bg-kin-muted/40",
          ].join(" ")}
          title={device.online ? tr("nav.machineOnline") : tr("nav.machineOffline")}
        />
        <span className="truncate flex-1 min-w-0">{label}</span>
        <span className="tabular-nums text-caption opacity-70">{count}</span>
      </button>
      {open && <div className="space-y-3 pl-1">{children}</div>}
    </div>
  );
}

/** One destination in the sidebar's bottom icon row. */
function FooterIcon({
  to,
  label,
  icon,
  badge,
  title,
  onClick,
}: {
  to: string;
  label: string;
  icon: ReactNode;
  badge?: string;
  title?: string;
  onClick: () => void;
}) {
  const tr = useT();
  return (
    <NavLink
      to={to}
      onClick={onClick}
      // The badge is a number next to an icon; a name that leaves it out tells
      // a screen reader there is nothing waiting when the dot says otherwise.
      aria-label={badge ? tr("nav.withCount", { label, count: badge }) : label}
      title={title ?? label}
      className={({ isActive }) =>
        [
          "relative inline-flex h-8 w-8 flex-none items-center justify-center rounded-lg transition-colors",
          isActive
            ? "bg-[var(--kin-fill-strong)] text-kin-text"
            : "text-kin-muted hover:bg-[var(--kin-fill)] hover:text-kin-text",
        ].join(" ")
      }
    >
      {icon}
      {badge ? (
        <span className="absolute -right-0.5 -top-0.5 min-w-[15px] h-[15px] px-0.5 rounded-full bg-kin-orange text-kin-on-status text-micro font-bold inline-flex items-center justify-center tabular-nums">
          {badge}
        </span>
      ) : null}
    </NavLink>
  );
}

function ProjectBlock({
  group: g,
  nestDraft,
  draftRowActive,
  selectedTaskId,
  draftLabel,
  onDraftClick,
  onCloseMobile,
  onNewSession,
  onDeleteSession,
  externalSessions = [],
  onOpenExternalSession,
  onTogglePin,
  onArchive,
  onMenu,
  pinLabel,
  collapseLabel,
  expandLabel,
  archiveLabel,
  coverLabel,
  newSessionLabel,
  menuLabel,
  deleteLabel,
  coarse,
  mode,
}: {
  group: ProjectGroup;
  nestDraft: boolean;
  draftRowActive: boolean;
  selectedTaskId?: string | null;
  draftLabel: string;
  onDraftClick: () => void;
  onCloseMobile: () => void;
  onNewSession: () => void;
  onDeleteSession?: (task: Task) => void;
  externalSessions?: AgentSession[];
  onOpenExternalSession?: (session: AgentSession) => void;
  onTogglePin: () => void;
  onArchive: () => void;
  /** Opens the phone's project action sheet (cover / pin / archive / new). */
  onMenu: () => void;
  pinLabel: string;
  collapseLabel: string;
  expandLabel: string;
  archiveLabel: string;
  coverLabel: string;
  newSessionLabel: string;
  menuLabel: string;
  deleteLabel: string;
  /** The pointer is a finger: render the touch home, not hover-only controls. */
  coarse: boolean;
  mode: "active" | "archived";
}) {
  const navigate = useNavigate();
  const [open, toggle] = useSidebarDisclosure(`project:${mode}:${projectKey(g.cwd)}`);

  const openCover = async () => {
    try {
      const p = await ensureProject({ path: g.cwd, name: g.label });
      onCloseMobile();
      navigate(`/projects/${p.id}`);
    } catch {
      // cover is optional; ignore ensure failures
    }
  };
  return (
    <div className={mode === "archived" ? "opacity-80" : undefined}>
      <div className="kin-section-label group/proj flex items-center gap-1 pr-0.5 max-md:min-h-11 max-md:normal-case max-md:tracking-normal max-md:text-strong max-md:font-semibold">
        {/*
          The chevron and the name are one control, not two. They used to be a
          11px chevron button followed by a dead label, so on a phone the only
          way to fold a project was to hit an 11px glyph — and the label, the
          part a thumb actually aims at, did nothing. On the desktop it also
          makes the whole row's left half the disclosure, which is what the
          hover-revealed actions on the right assume.
        */}
        <button
          type="button"
          title={open ? collapseLabel : expandLabel}
          aria-label={open ? collapseLabel : expandLabel}
          aria-expanded={open}
          onClick={toggle}
          className={[
            "flex min-w-0 flex-1 items-center gap-1 text-left text-kin-muted transition-colors max-md:min-h-11",
            // A color change on hover is still a hover: iOS would spend the
            // first tap applying it instead of folding the project.
            coarse ? "" : "hover:text-kin-text",
          ].join(" ")}
        >
          <IconChevron
            size={11}
            className={["flex-none transition-transform", open ? "rotate-90" : ""].join(" ")}
          />
          {g.pinned && mode === "active" && (
            <IconPin size={11} className="flex-none text-kin-blue-ink opacity-90" />
          )}
          <span className="min-w-0 flex-1 truncate" title={g.cwd}>
            {g.label}
          </span>
        </button>
        {/*
          The three hover-only controls below are desktop-only. On a touch
          screen the tap that would reveal them is also the tap that expands
          the project — they were never reachable there — and on an iPad
          (desktop layout, coarse pointer) that first tap is spent on hover.
          The `⋯` below opens the same actions in a sheet, which is the one
          shape that fits a 44pt target beside a name. `touch-hide` still
          covers a narrow window with a mouse; `coarse` covers a wide one with
          a finger.
        */}
        {!coarse && (
          <button
            type="button"
            title={coverLabel}
            aria-label={coverLabel}
            onClick={(e) => {
              e.stopPropagation();
              void openCover();
            }}
            className="touch-hide inline-flex flex-none w-[22px] h-[22px] rounded-md items-center justify-center text-kin-muted hover:text-kin-text hover:bg-[var(--kin-fill-strong)] opacity-0 group-hover/proj:opacity-100 focus:opacity-100 transition-opacity"
          >
            <IconFile size={12} />
          </button>
        )}
        {mode === "active" && !coarse && (
          <button
            type="button"
            title={pinLabel}
            aria-label={pinLabel}
            onClick={(e) => {
              e.stopPropagation();
              onTogglePin();
            }}
            className={[
              "touch-hide inline-flex flex-none w-[22px] h-[22px] rounded-md items-center justify-center transition-opacity",
              g.pinned
                ? "text-kin-blue-ink opacity-100"
                : "text-kin-muted hover:text-kin-text hover:bg-[var(--kin-fill-strong)] opacity-0 group-hover/proj:opacity-100 focus:opacity-100",
            ].join(" ")}
          >
            <IconPin size={12} strokeWidth={g.pinned ? 2.2 : 1.7} />
          </button>
        )}
        {!coarse && (
          <button
            type="button"
            title={archiveLabel}
            aria-label={archiveLabel}
            onClick={(e) => {
              e.stopPropagation();
              onArchive();
            }}
            className={[
              "touch-hide inline-flex flex-none w-[22px] h-[22px] rounded-md items-center justify-center text-kin-muted hover:text-kin-text hover:bg-[var(--kin-fill-strong)] transition-opacity",
              mode === "archived"
                ? "opacity-100"
                : "opacity-0 group-hover/proj:opacity-100 focus:opacity-100",
            ].join(" ")}
          >
            <IconArchive size={12} />
          </button>
        )}
        <button
          type="button"
          title={newSessionLabel}
          aria-label={newSessionLabel}
          onClick={(e) => {
            e.stopPropagation();
            onNewSession();
          }}
          className={[
            "max-md:hidden flex-none w-[22px] h-[22px] rounded-md inline-flex items-center justify-center text-kin-muted transition-opacity",
            // A finger has no hover to finish the reveal; keep the + at full
            // strength so the first tap is the tap that opens the draft.
            coarse
              ? "opacity-100"
              : "hover:text-kin-text hover:bg-[var(--kin-fill-strong)] opacity-70 group-hover/proj:opacity-100",
          ].join(" ")}
        >
          <IconPlus size={13} strokeWidth={2.2} />
        </button>
        {/* The touch project action. 44pt, at the row's trailing edge, opening
            every hover action in an action sheet. Below `md` it is the phone's
            only shape; at ≥768px a coarse pointer keeps it, because the
            hover-revealed controls above are not reachable by finger. */}
        <button
          type="button"
          title={menuLabel}
          aria-label={menuLabel}
          aria-haspopup="dialog"
          onClick={(e) => {
            e.stopPropagation();
            onMenu();
          }}
          className={[
            "flex-none inline-flex h-11 w-11 -my-2 -mr-2 items-center justify-center rounded-full text-kin-muted active:bg-[var(--kin-fill)]",
            coarse ? "" : "md:hidden",
          ].join(" ")}
        >
          <IconMore size={18} />
        </button>
      </div>

      {open && (
        <>
          {nestDraft && (
            <DraftRow active={draftRowActive} label={draftLabel} onClick={onDraftClick} />
          )}

          <div className="space-y-0.5 max-h-[min(280px,40vh)] overflow-y-auto kin-scroll pr-0.5">
            <ProjectSessionRows
              tasks={g.items}
              sessions={externalSessions}
              selectedTaskId={selectedTaskId}
              onDeleteSession={onDeleteSession}
              deleteLabel={deleteLabel}
              onOpenExternalSession={onOpenExternalSession}
              onCloseMobile={onCloseMobile}
              coarse={coarse}
            />
          </div>
        </>
      )}
    </div>
  );
}

function ExternalSessionRow({
  session,
  label,
  sessionTitle,
  onOpen,
  onCloseMobile,
  coarse,
}: {
  session: AgentSession;
  label: string;
  sessionTitle: string;
  onOpen?: (session: AgentSession) => void;
  onCloseMobile: () => void;
  coarse: boolean;
}) {
  const tr = useT();
  const avatar = agentAvatarMeta(session.agent_id);
  const availability = agentSessionAvailability(session);
  const availabilityLabel =
    availability === "linked"
      ? tr("agentSession.connected")
      : availability === "resumable"
        ? tr("agentSession.available")
        : tr("agentSession.readOnly");
  return (
    <button
      type="button"
      data-session-row={session.id}
      onClick={() => {
        onOpen?.(session);
        onCloseMobile();
      }}
      className={[
        "w-full flex items-center gap-2 px-1.5 py-1.5 rounded-lg border text-left text-body min-h-9 max-md:min-h-11 max-md:text-strong transition-colors",
        externalSessionRowClass(availability, coarse),
      ].join(" ")}
      aria-label={`${label}, ${availabilityLabel}, ${sessionTitle}`}
      title={`${label}: ${availabilityLabel}: ${sessionTitle}`}
    >
      <span
        className={["h-7 w-1 flex-none rounded-full", externalSessionRailClass(availability)].join(
          " ",
        )}
        aria-hidden="true"
      />
      <span
        className={[
          "inline-flex h-5 w-5 items-center justify-center rounded-md text-micro font-semibold",
          avatar.className,
        ].join(" ")}
        role="img"
        aria-label={avatar.label}
      >
        {avatar.initials}
      </span>
      <span
        className={[
          "h-1.5 w-1.5 flex-none rounded-full",
          session.status === "active" ? "bg-kin-blue" : "bg-kin-muted",
        ].join(" ")}
        aria-hidden="true"
      />
      <span className="truncate flex-1 min-w-0">{sessionTitle}</span>
      <span
        className={[
          "shrink-0 rounded-md border px-1.5 py-0.5 text-micro font-medium",
          externalSessionBadgeClass(availability),
        ].join(" ")}
      >
        {availabilityLabel}
      </span>
    </button>
  );
}

function externalSessionRowClass(availability: AgentSessionAvailability, coarse: boolean): string {
  if (availability === "linked") {
    return [
      "border-kin-blue/25 bg-kin-blue/10 text-kin-text",
      coarse ? "" : "hover:bg-kin-blue/15",
    ].join(" ");
  }
  if (availability === "resumable") {
    return [
      "border-kin-green/25 bg-kin-green/10 text-kin-text",
      coarse ? "" : "hover:bg-kin-green/15",
    ].join(" ");
  }
  return [
    "border-kin-hairline border-dashed bg-[var(--kin-fill)] text-kin-secondary",
    // A conversation row is the same row on a finger; without the hover
    // change the first tap lands as a tap.
    coarse ? "" : "hover:bg-[var(--kin-fill-strong)] hover:text-kin-text",
  ].join(" ");
}

function externalSessionRailClass(availability: AgentSessionAvailability): string {
  if (availability === "linked") return "bg-kin-blue";
  if (availability === "resumable") return "bg-kin-green";
  return "bg-kin-muted";
}

function externalSessionBadgeClass(availability: AgentSessionAvailability): string {
  if (availability === "linked") return "border-kin-blue/30 text-kin-blue-ink";
  if (availability === "resumable") return "border-kin-green/30 text-kin-green-ink";
  return "border-kin-hairline text-kin-muted";
}

function ProjectSessionRows({
  tasks,
  sessions,
  selectedTaskId,
  onDeleteSession,
  deleteLabel,
  onOpenExternalSession,
  onCloseMobile,
  coarse,
}: {
  tasks: Task[];
  sessions: AgentSession[];
  selectedTaskId?: string | null;
  onDeleteSession?: (task: Task) => void;
  deleteLabel?: string;
  onOpenExternalSession?: (session: AgentSession) => void;
  onCloseMobile: () => void;
  /** The pointer is a finger: no hover reveal, no hover-only delete. */
  coarse: boolean;
}) {
  const tr = useT();
  const rows = useMemo(() => mergeProjectRows(tasks, sessions), [tasks, sessions]);
  return (
    <div className="space-y-0.5">
      {rows.map((row) => {
        if (row.session) {
          const session = row.session;
          return (
            <ExternalSessionRow
              key={session.id}
              session={session}
              label={tr("nav.externalSession")}
              sessionTitle={displayAgentSessionTitle(
                session,
                tr("agentSession.sessionFallback", {
                  agent: agentDisplayName(session.agent_id),
                }),
              )}
              onOpen={onOpenExternalSession}
              onCloseMobile={onCloseMobile}
              coarse={coarse}
            />
          );
        }
        const task = row.task!;
        const active = task.id === selectedTaskId;
        const dot = sessionStatusDotClass(task.status, isSessionViewed(task.id));
        return (
          <div
            key={task.id}
            className={[
              "group/session flex items-center gap-0.5 rounded-lg min-h-9 max-md:min-h-11",
              active
                ? "bg-[var(--kin-fill-strong)] text-kin-text"
                : [
                    "text-kin-secondary",
                    // iOS spends the first tap on a hover change; a finger
                    // must see the tap land as a tap, not as a hover.
                    coarse ? "" : "hover:bg-[var(--kin-fill)] hover:text-kin-text",
                  ].join(" "),
            ].join(" ")}
          >
            <NavLink
              to={`/tasks/${task.id}`}
              data-session-row={task.id}
              onClick={() => {
                touchProject(task.cwd);
                if (isTerminal(task.status)) markSessionViewed(task.id);
                onCloseMobile();
              }}
              className="flex flex-1 items-center gap-2 px-2 py-1.5 text-body max-md:px-2 max-md:text-strong min-w-0"
            >
              <span
                className={["w-1.5 h-1.5 rounded-full flex-none", dot ?? "bg-transparent"].join(
                  " ",
                )}
              />
              <span className="truncate flex-1 min-w-0">{taskDisplayTitle(task)}</span>
            </NavLink>
            {onDeleteSession && deleteLabel && !coarse && (
              <button
                type="button"
                title={deleteLabel}
                aria-label={deleteLabel}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onDeleteSession(task);
                }}
                className="touch-hide flex-none w-[22px] h-[22px] mr-1 rounded-md inline-flex items-center justify-center text-kin-muted hover:text-kin-red-ink hover:bg-kin-red/10 opacity-0 group-hover/session:opacity-100 focus:opacity-100 transition-opacity"
              >
                <IconTrash size={12} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

type ProjectRow = {
  key: string;
  at: number;
  active: boolean;
  task?: Task;
  session?: AgentSession;
};

/**
 * One list per project: a session Kin ran and a session an agent ran are both
 * just sessions in this project, so they share a timeline. A task still running
 * stays on top of it.
 */
function mergeProjectRows(tasks: Task[], sessions: AgentSession[]): ProjectRow[] {
  const rows: ProjectRow[] = [
    ...tasks.map((task) => ({
      key: task.id,
      at: task.finished_at ?? task.started_at ?? task.created_at ?? 0,
      active: !isTerminal(task.status),
      task,
    })),
    ...sessions.map((session) => ({
      key: session.id,
      at: session.updated_at ?? 0,
      active: false,
      session,
    })),
  ];
  return rows.sort(
    (a, b) => Number(b.active) - Number(a.active) || b.at - a.at || a.key.localeCompare(b.key),
  );
}

function DraftRow({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-strong min-h-9 text-left",
        active
          ? "bg-[var(--kin-fill-strong)] text-kin-text"
          : "text-kin-secondary hover:bg-[var(--kin-fill)] hover:text-kin-text",
      ].join(" ")}
    >
      <span
        className={[
          "w-1.5 h-1.5 rounded-full flex-none",
          active ? "bg-kin-blue" : "bg-transparent border border-kin-muted",
        ].join(" ")}
      />
      <span className="truncate">{label}</span>
    </button>
  );
}
