import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { NavLink, useNavigate } from "react-router-dom";
import {
  ensureProject,
  formatCost,
  isTerminal,
  type AgentInfo,
  type AgentSession,
  type Task,
} from "../../api/client";
import { useT } from "../../i18n/react";
import { getDraftCwd, getDraftPrompt, subscribeDraft } from "../../lib/draftChat";
import {
  archiveProject,
  getProjectSortMode,
  groupByProject,
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
  getViewedSessionIds,
  isSessionViewed,
  markSessionViewed,
  sessionStatusDotClass,
  subscribeSessionViewed,
} from "../../lib/sessionViewed";
import { displayUserPrompt } from "../../lib/attachments";
import {
  IconArchive,
  IconFile,
  IconArtifacts,
  IconChevron,
  IconDownload,
  IconInbox,
  IconPin,
  IconPlus,
  IconSearch,
  IconSettings,
  IconSort,
  IconTrash,
  IconAgents,
  IconRoutines,
} from "../icons";

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

const footLink =
  "flex items-center gap-2.5 px-2 py-1.5 rounded-[7px] text-[12.5px] text-kin-secondary hover:bg-[var(--kin-fill-strong)] hover:text-kin-text transition-colors min-h-[40px]";

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

function SidebarDisclosure({
  storageKey,
  label,
  count,
  children,
  className = "",
}: {
  storageKey: string;
  label: string;
  count?: number;
  children: ReactNode;
  className?: string;
}) {
  const [open, toggle] = useSidebarDisclosure(storageKey);
  return (
    <div className={className}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="w-full flex items-center gap-1 px-2 py-1 text-left text-[10px] text-kin-muted hover:text-kin-secondary transition-colors"
      >
        <IconChevron
          size={11}
          className={[
            "flex-none transition-transform",
            open ? "rotate-90" : "",
          ].join(" ")}
        />
        <span className="truncate flex-1">{label}</span>
        {count != null && <span className="tabular-nums opacity-70">{count}</span>}
      </button>
      {open && children}
    </div>
  );
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
  // prefsTick invalidates after localStorage updates (sort / pin / archive / interact).
  const archivedGroups = useMemo(
    () => groupByProject(tasks, null, false, true),
    [tasks, prefsTick],
  );
  const archivedProjectKeys = useMemo(
    () => new Set(archivedGroups.map((group) => projectKey(group.cwd))),
    [archivedGroups],
  );
  const groups = useMemo(
    () =>
      mergeExternalProjectGroups(
        groupByProject(tasks),
        externalSessions.filter(
          (session) => !archivedProjectKeys.has(projectKey(session.cwd)),
        ),
      ),
    [tasks, externalSessions, archivedProjectKeys, prefsTick],
  );
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const sortMenuRef = useRef<HTMLDivElement>(null);
  const [groupMode, setGroupMode] = useState<"project" | "agent">(() => {
    try {
      return localStorage.getItem("kin_session_group_mode") === "agent"
        ? "agent"
        : "project";
    } catch {
      return "project";
    }
  });
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

  const draftGroupCwd =
    hasDraft && draftCwd
      ? [...groups, ...archivedGroups].find((g) => normCwd(g.cwd) === normCwd(draftCwd))
          ?.cwd ?? null
      : null;
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

  const panel = (
    <aside className="w-[248px] max-w-[85vw] h-full flex flex-col bg-kin-sidebar border-r border-kin-hairline shrink-0">
      <div className="px-3 pt-3 pb-2 flex items-center gap-2">
        <div className="w-7 h-7 rounded-[8px] bg-gradient-to-br from-[#5b8def] to-[#7aa2f7] flex items-center justify-center text-white text-[13px] font-semibold shadow-sm">
          K
        </div>
        <span className="text-[14px] font-semibold tracking-tight">{tr("app.name")}</span>
        <div
          role="group"
          aria-label={tr("nav.groupSessions")}
          className="ml-auto flex items-center rounded-md border border-kin-border overflow-hidden"
        >
          {(["project", "agent"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={groupMode === mode}
              title={tr(`nav.groupBy${mode === "project" ? "Project" : "Agent"}`)}
              onClick={() => {
                setGroupMode(mode);
                try {
                  localStorage.setItem("kin_session_group_mode", mode);
                } catch {
                  // ignore unavailable local storage
                }
              }}
              className={[
                "px-1.5 h-6 text-[10px] transition-colors",
                groupMode === mode
                  ? "bg-kin-blue-soft text-kin-blue"
                  : "text-kin-muted hover:bg-[var(--kin-fill-strong)]",
              ].join(" ")}
            >
              {mode === "project" ? tr("nav.groupProjectShort") : tr("nav.groupAgentShort")}
            </button>
          ))}
        </div>
        <div className="ml-auto relative" ref={sortMenuRef}>
          <button
            type="button"
            title={tr("nav.sortProjects")}
            aria-label={tr("nav.sortProjects")}
            aria-expanded={sortMenuOpen}
            aria-haspopup="menu"
            onClick={() => setSortMenuOpen((o) => !o)}
            className="w-7 h-7 rounded-md inline-flex items-center justify-center text-kin-muted hover:text-kin-text hover:bg-[var(--kin-fill-strong)] transition-colors"
          >
            <IconSort size={15} />
          </button>
          {sortMenuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-full mt-1 z-50 min-w-[148px] rounded-lg border border-kin-border bg-kin-elevated shadow-window py-1"
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
                      "w-full text-left px-3 py-1.5 text-[12.5px] transition-colors",
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
      </div>

      <div className="px-2.5 pb-2 relative" ref={importMenuRef}>
        <button
          type="button"
          disabled={importingExternalSessions || !onImportExternalSessions}
          aria-haspopup="menu"
          aria-expanded={importMenuOpen}
          onClick={() => setImportMenuOpen((open) => !open)}
          className="w-full flex items-center gap-2 px-2.5 h-8 rounded-[8px] text-[12.5px] text-kin-secondary border border-[var(--kin-hairline-strong)] hover:bg-[var(--kin-fill-strong)] hover:text-kin-text disabled:opacity-50 transition-colors"
        >
          <IconDownload size={14} />
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
            role="menu"
            aria-label={tr("nav.importAgentSessions")}
            className="absolute left-2.5 right-2.5 top-full mt-1 z-50 rounded-lg border border-kin-border bg-kin-elevated shadow-window py-1"
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setImportMenuOpen(false);
                onImportExternalSessions?.();
              }}
              className="w-full text-left px-3 py-2 text-[12px] text-kin-text hover:bg-[var(--kin-fill-strong)]"
            >
              {tr("nav.importAllAgents")}
            </button>
            <div className="my-1 border-t border-kin-border" />
            {sessionProviders.length > 0 ? (
              sessionProviders.map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setImportMenuOpen(false);
                    onImportExternalSessions?.([provider.id]);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-kin-secondary hover:bg-[var(--kin-fill-strong)] hover:text-kin-text"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-kin-blue" />
                  <span className="truncate">{provider.name || provider.id}</span>
                  <span className="ml-auto text-[10px] text-kin-muted">{provider.id}</span>
                </button>
              ))
            ) : (
              <div className="px-3 py-2 text-[11px] text-kin-muted">
                {tr("nav.noSessionProviders")}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="px-2.5 pb-2">
        <button
          type="button"
          onClick={() => {
            onNewChat();
            onCloseMobile();
          }}
          className={[
            "w-full flex items-center gap-2 px-2.5 h-9 rounded-[8px] text-[13px] font-medium border transition-colors",
            draftActive
              ? "border-kin-blue/40 bg-kin-blue-soft text-kin-text"
              : "border-[var(--kin-hairline-strong)] bg-[var(--kin-fill)] text-kin-text hover:bg-[var(--kin-fill-strong)]",
          ].join(" ")}
        >
          <IconPlus size={15} strokeWidth={1.9} />
          {tr("nav.newChat")}
          <span className="ml-auto text-[11.5px] text-kin-muted font-medium hidden sm:inline">
            ⌘N
          </span>
        </button>
      </div>

      <div className="px-3 pb-2">
        <label className="relative flex items-center">
          <IconSearch
            size={13}
            className="absolute left-2.5 text-kin-muted pointer-events-none"
          />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => onSearchQueryChange?.(e.target.value)}
            placeholder={tr("nav.searchSessions")}
            aria-label={tr("nav.searchSessions")}
            className="w-full h-[32px] pl-8 pr-2 rounded-[8px] bg-[var(--kin-fill)] border border-transparent focus:border-kin-blue/40 focus:bg-[var(--kin-fill-strong)] text-[12.5px] text-kin-text placeholder:text-kin-muted outline-none transition-colors"
          />
        </label>
        {searchQuery.trim() && (
          <div className="mt-1 px-0.5 text-[11px] text-kin-muted">
            {searchLoading
              ? tr("common.loading")
              : tr("nav.searchHint")}
          </div>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-2 space-y-3">
        <button
          type="button"
          onClick={() => {
            navigate("/approvals");
            onCloseMobile();
          }}
          className={[
            "w-full flex items-center gap-2 px-2 py-1.5 rounded-[7px] text-[13px] min-h-[34px]",
            pendingCount > 0
              ? "border border-kin-blue/40 bg-kin-blue-soft text-kin-text"
              : "text-kin-secondary hover:bg-[var(--kin-fill)] hover:text-kin-text",
          ].join(" ")}
        >
          <IconInbox size={15} />
          <span>{tr("nav.inbox")}</span>
          {pendingCount > 0 && (
            <span className="ml-auto min-w-[18px] h-[18px] px-1.5 rounded-full bg-kin-orange text-[#1a1a1c] text-[11px] font-bold inline-flex items-center justify-center tabular-nums">
              {pendingCount > 99 ? "99+" : pendingCount}
            </span>
          )}
        </button>

        {groupMode === "agent" && (
          <AgentGroupedTree
            tasks={tasks}
            sessions={externalSessions}
            selectedTaskId={selectedTaskId}
            onOpenExternalSession={onOpenExternalSession}
            onCloseMobile={onCloseMobile}
          />
        )}
        <div className={groupMode === "agent" ? "hidden" : undefined}>
        {groups.length === 0 && archivedGroups.length === 0 && (
          <div className="px-2 py-4 text-[12.5px] text-kin-muted leading-relaxed">
            {searchQuery.trim()
              ? tr("nav.searchEmpty", { query: searchQuery.trim() })
              : tr("nav.emptyHint")}
          </div>
        )}

        {groups.map((g) => {
          const nestDraft = Boolean(hasDraft && draftGroupCwd === g.cwd);
          return (
            <ProjectBlock
              key={g.cwd}
              group={g}
              nestDraft={nestDraft}
              draftRowActive={Boolean(draftActive)}
              selectedTaskId={selectedTaskId}
              draftLabel={tr("nav.draftChat")}
              onDraftClick={() => {
                navigate("/new");
                onCloseMobile();
              }}
              onCloseMobile={onCloseMobile}
              onNewSession={() => {
                touchProject(g.cwd);
                if (onNewSessionInProject) onNewSessionInProject(g.cwd);
                else onNewChat();
                onCloseMobile();
              }}
              onTogglePin={() => toggleProjectPinned(g.cwd)}
              onArchive={() => onArchive(g)}
              pinLabel={g.pinned ? tr("nav.unpinProject") : tr("nav.pinProject")}
              collapseLabel={tr("nav.collapseProject")}
              expandLabel={tr("nav.expandProject")}
              coverLabel={tr("nav.openCover")}
              archiveLabel={tr("nav.archiveProject")}
              newSessionLabel={tr("nav.newSessionIn", { project: g.label })}
              onDeleteSession={onDeleteSession}
              deleteLabel={tr("task.deleteSession")}
              externalSessions={sessionsForProject(externalSessions, g)}
              onOpenExternalSession={onOpenExternalSession}
              mode="active"
            />
          );
        })}

        {showOrphanDraft && (
          <div>
            <div className="kin-section-label">{tr("nav.draft")}</div>
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
          <div className="pt-1 border-t border-kin-border">
            <button
              type="button"
              onClick={() => setArchivedOpen((o) => !o)}
              className="kin-section-label w-full flex items-center gap-1 pr-0.5 hover:text-kin-secondary transition-colors"
              aria-expanded={archivedOpen}
            >
              <IconArchive size={11} className="flex-none opacity-70" />
              <span className="truncate flex-1 min-w-0 text-left">
                {tr("nav.archivedProjects")}
              </span>
              <span className="text-[11px] tabular-nums opacity-70">
                {archivedGroups.length}
              </span>
              <span
                className={[
                  "text-[10px] opacity-60 transition-transform",
                  archivedOpen ? "rotate-90" : "",
                ].join(" ")}
              >
                ▸
              </span>
            </button>
            {archivedOpen && (
              <div className="space-y-3 mt-1">
                {archivedGroups.map((g) => {
                  const nestDraft = Boolean(hasDraft && draftGroupCwd === g.cwd);
                  return (
                    <ProjectBlock
                      key={`arch-${g.cwd}`}
                      group={g}
                      nestDraft={nestDraft}
                      draftRowActive={Boolean(draftActive)}
                      selectedTaskId={selectedTaskId}
                      draftLabel={tr("nav.draftChat")}
                      onDraftClick={() => {
                        navigate("/new");
                        onCloseMobile();
                      }}
                      onCloseMobile={onCloseMobile}
                      onNewSession={() => {
                        unarchiveProject(g.cwd);
                        touchProject(g.cwd);
                        if (onNewSessionInProject) onNewSessionInProject(g.cwd);
                        else onNewChat();
                        onCloseMobile();
                      }}
                      onTogglePin={() => toggleProjectPinned(g.cwd)}
                      onArchive={() => unarchiveProject(g.cwd)}
                      pinLabel={tr("nav.pinProject")}
                      collapseLabel={tr("nav.collapseProject")}
                      expandLabel={tr("nav.expandProject")}
                      coverLabel={tr("nav.openCover")}
                      archiveLabel={tr("nav.unarchiveProject")}
                      newSessionLabel={tr("nav.newSessionIn", { project: g.label })}
                      onDeleteSession={onDeleteSession}
                      deleteLabel={tr("task.deleteSession")}
                      externalSessions={sessionsForProject(externalSessions, g)}
                      onOpenExternalSession={onOpenExternalSession}
                      mode="archived"
                    />
                  );
                })}
              </div>
            )}
          </div>
        )}
        </div>
      </nav>

      <div className="border-t border-kin-border px-2 py-2 space-y-0.5">        <NavLink
          to="/artifacts"
          onClick={onCloseMobile}
          className={({ isActive }) =>
            [footLink, isActive ? "bg-[var(--kin-fill-strong)] text-kin-text" : ""].join(" ")
          }
        >
          <IconArtifacts size={15} />
          {tr("nav.artifacts")}
        </NavLink>                <NavLink
          to="/routines"
          onClick={onCloseMobile}
          className={({ isActive }) =>
            [footLink, isActive ? "bg-[var(--kin-fill-strong)] text-kin-text" : ""].join(" ")
          }
        >
          <IconRoutines size={15} />
          <span className="flex-1">{tr("nav.routines")}</span>
          {routineUnreadCount > 0 && (
            <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-kin-blue text-[10px] font-semibold text-white flex items-center justify-center tabular-nums">
              {routineUnreadCount > 99 ? "99+" : routineUnreadCount}
            </span>
          )}
        </NavLink>
<NavLink
          to="/agents"
          onClick={onCloseMobile}
          className={({ isActive }) =>
            [footLink, isActive ? "bg-[var(--kin-fill-strong)] text-kin-text" : ""].join(" ")
          }
        >
          <IconAgents size={15} />
          <span className="flex-1">{tr("nav.agents")}</span>
          {weekCost != null && weekCost > 0 && (
            <span className="text-[11px] text-kin-muted tabular-nums">
              {formatCost(weekCost)}
            </span>
          )}
        </NavLink>
        <NavLink
          to="/settings"
          onClick={onCloseMobile}
          className={({ isActive }) =>
            [footLink, isActive ? "bg-[var(--kin-fill-strong)] text-kin-text" : ""].join(" ")
          }
        >
          <IconSettings size={15} />
          {tr("nav.settings")}
        </NavLink>
      </div>
    </aside>
  );

  return (
    <>
      {/* Desktop */}
      <div className="hidden md:flex h-full shrink-0">{panel}</div>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="md:hidden fixed inset-0 z-40 flex">
          <button
            type="button"
            className="absolute inset-0 bg-black/50"
            aria-label={tr("app.closeMenu")}
            onClick={onCloseMobile}
          />
          <div className="relative z-10 h-full shadow-window">{panel}</div>
        </div>
      )}
    </>
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
  pinLabel,
  collapseLabel,
  expandLabel,
  archiveLabel,
  coverLabel,
  newSessionLabel,
  deleteLabel,
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
  pinLabel: string;
  collapseLabel: string;
  expandLabel: string;
  archiveLabel: string;
  coverLabel: string;
  newSessionLabel: string;
  deleteLabel: string;
  mode: "active" | "archived";
}) {
  const navigate = useNavigate();
  const [open, toggle] = useSidebarDisclosure(
    `project:${mode}:${projectKey(g.cwd)}`,
  );

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
      <div className="kin-section-label group/proj flex items-center gap-1 pr-0.5">
        <button
          type="button"
          title={open ? collapseLabel : expandLabel}
          aria-label={open ? collapseLabel : expandLabel}
          aria-expanded={open}
          onClick={toggle}
          className="flex-none text-kin-muted hover:text-kin-text transition-colors"
        >
          <IconChevron
            size={11}
            className={["transition-transform", open ? "rotate-90" : ""].join(" ")}
          />
        </button>
        {g.pinned && mode === "active" && (
          <IconPin size={11} className="flex-none text-kin-blue opacity-90" />
        )}
        <span className="truncate flex-1 min-w-0" title={g.cwd}>
          {g.label}
        </span>
        <button
          type="button"
          title={coverLabel}
          aria-label={coverLabel}
          onClick={(e) => {
            e.stopPropagation();
            void openCover();
          }}
          className="flex-none w-[22px] h-[22px] rounded-md inline-flex items-center justify-center text-kin-muted hover:text-kin-text hover:bg-[var(--kin-fill-strong)] opacity-0 group-hover/proj:opacity-100 transition-opacity"
        >
          <IconFile size={12} />
        </button>
        {mode === "active" && (
          <button
            type="button"
            title={pinLabel}
            aria-label={pinLabel}
            onClick={(e) => {
              e.stopPropagation();
              onTogglePin();
            }}
            className={[
              "flex-none w-[22px] h-[22px] rounded-md inline-flex items-center justify-center transition-opacity",
              g.pinned
                ? "text-kin-blue opacity-100"
                : "text-kin-muted hover:text-kin-text hover:bg-[var(--kin-fill-strong)] opacity-0 group-hover/proj:opacity-100",
            ].join(" ")}
          >
            <IconPin size={12} strokeWidth={g.pinned ? 2.2 : 1.7} />
          </button>
        )}
        <button
          type="button"
          title={archiveLabel}
          aria-label={archiveLabel}
          onClick={(e) => {
            e.stopPropagation();
            onArchive();
          }}
          className={[
            "flex-none w-[22px] h-[22px] rounded-md inline-flex items-center justify-center text-kin-muted hover:text-kin-text hover:bg-[var(--kin-fill-strong)] transition-opacity",
            mode === "archived"
              ? "opacity-100"
              : "opacity-0 group-hover/proj:opacity-100",
          ].join(" ")}
        >
          <IconArchive size={12} />
        </button>
        <button
          type="button"
          title={newSessionLabel}
          aria-label={newSessionLabel}
          onClick={(e) => {
            e.stopPropagation();
            onNewSession();
          }}
          className="flex-none w-[22px] h-[22px] rounded-md inline-flex items-center justify-center text-kin-muted hover:text-kin-text hover:bg-[var(--kin-fill-strong)] opacity-70 group-hover/proj:opacity-100 transition-opacity"
        >
          <IconPlus size={13} strokeWidth={2.2} />
        </button>
      </div>

      {open && (
        <>
          {nestDraft && (
            <DraftRow active={draftRowActive} label={draftLabel} onClick={onDraftClick} />
          )}

          <div className="space-y-0.5 max-h-[min(280px,40vh)] overflow-y-auto kin-scroll pr-0.5">
            <ProjectAgentTree
              tasks={g.items}
              sessions={externalSessions}
              storagePrefix={`project:${projectKey(g.cwd)}`}
              selectedTaskId={selectedTaskId}
              onDeleteSession={onDeleteSession}
              deleteLabel={deleteLabel}
              onOpenExternalSession={onOpenExternalSession}
              onCloseMobile={onCloseMobile}
            />
          </div>
        </>
      )}

    </div>
  );
}

function projectKey(cwd: string): string {
  return normCwd(cwd) || "__unassigned__";
}

function projectLabelForSession(session: AgentSession): string {
  return session.project_label || (session.cwd ? session.cwd.split("/").filter(Boolean).pop() : "") || "Unassigned";
}

function sessionsForProject(sessions: AgentSession[], group: ProjectGroup): AgentSession[] {
  return sessions.filter((session) => projectKey(session.cwd) === projectKey(group.cwd));
}

function mergeExternalProjectGroups(
  groups: ProjectGroup[],
  sessions: AgentSession[],
): ProjectGroup[] {
  const out = [...groups];
  const known = new Set(out.map((group) => projectKey(group.cwd)));
  for (const session of sessions) {
    const key = projectKey(session.cwd);
    if (known.has(key)) continue;
    known.add(key);
    out.push({
      label: projectLabelForSession(session),
      cwd: session.cwd,
      items: [],
      pinned: false,
      archived: false,
      lastInteractedAt: session.updated_at,
      createdAt: session.first_seen_at,
      hasActiveTask: false,
    });
  }
  return out;
}

function ExternalSessionRow({
  session,
  label,
  onOpen,
  onCloseMobile,
}: {
  session: AgentSession;
  label: string;
  onOpen?: (session: AgentSession) => void;
  onCloseMobile: () => void;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        onOpen?.(session);
        onCloseMobile();
      }}
      className="w-full flex items-center gap-2 px-2 py-1.5 rounded-[7px] text-left text-[12.5px] text-kin-secondary hover:bg-[var(--kin-fill)] hover:text-kin-text min-h-[34px]"
      title={`${label}: ${session.title}`}
    >
      <span
        className={[
          "w-1.5 h-1.5 rounded-full flex-none",
          session.status === "active" ? "bg-kin-blue" : "bg-kin-muted",
        ].join(" ")}
      />
      <span className="truncate flex-1 min-w-0">{session.title}</span>
      {!session.linked && (
        <span className="text-[9px] text-kin-muted border border-kin-border rounded px-1">
          {label}
        </span>
      )}
    </button>
  );
}

function AgentGroupedTree({
  tasks,
  sessions,
  selectedTaskId,
  onOpenExternalSession,
  onCloseMobile,
}: {
  tasks: Task[];
  sessions: AgentSession[];
  selectedTaskId?: string | null;
  onOpenExternalSession?: (session: AgentSession) => void;
  onCloseMobile: () => void;
}) {
  const tr = useT();
  const groups = useMemo(() => {
    const ids = new Set<string>();
    for (const task of tasks) ids.add(task.agent || "kin");
    for (const session of sessions) ids.add(session.agent_id);
    return [...ids].sort().map((agentID) => ({
      agentID,
      tasks: tasks.filter((task) => (task.agent || "kin") === agentID),
      sessions: sessions.filter((session) => session.agent_id === agentID),
    }));
  }, [sessions, tasks]);
  if (groups.length === 0) {
    return <div className="px-2 py-4 text-[12.5px] text-kin-muted">{tr("nav.emptyHint")}</div>;
  }
  return (
    <div className="space-y-2">
      {groups.map((group) => (
        <SidebarDisclosure
          key={group.agentID}
          storageKey={`agent:${group.agentID}`}
          label={group.agentID}
          count={group.tasks.length + group.sessions.length}
        >
          <div className="pl-2 border-l border-kin-border ml-1">
            <AgentProjectTree
              tasks={group.tasks}
              sessions={group.sessions}
              storagePrefix={`agent:${group.agentID}`}
              selectedTaskId={selectedTaskId}
              onOpenExternalSession={onOpenExternalSession}
              onCloseMobile={onCloseMobile}
            />
          </div>
        </SidebarDisclosure>
      ))}
    </div>
  );
}

function AgentProjectTree({
  tasks,
  sessions,
  storagePrefix,
  selectedTaskId,
  onDeleteSession,
  deleteLabel,
  onOpenExternalSession,
  onCloseMobile,
}: {
  tasks: Task[];
  sessions: AgentSession[];
  storagePrefix?: string;
  selectedTaskId?: string | null;
  onDeleteSession?: (task: Task) => void;
  deleteLabel?: string;
  onOpenExternalSession?: (session: AgentSession) => void;
  onCloseMobile: () => void;
}) {
  const projects = useMemo(() => {
    const map = new Map<
      string,
      { label: string; tasks: Task[]; sessions: AgentSession[] }
    >();
    for (const task of tasks) {
      const key = projectKey(task.cwd);
      const project = map.get(key) ?? {
        label: task.cwd ? task.cwd.split("/").filter(Boolean).pop() || "Unassigned" : "Unassigned",
        tasks: [],
        sessions: [],
      };
      project.tasks.push(task);
      map.set(key, project);
    }
    for (const session of sessions) {
      const key = projectKey(session.cwd);
      const project = map.get(key) ?? {
        label: projectLabelForSession(session),
        tasks: [],
        sessions: [],
      };
      project.sessions.push(session);
      map.set(key, project);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [sessions, tasks]);

  return (
    <div className="space-y-1">
      {projects.map(([key, project]) => (
        <SidebarDisclosure
          key={key}
          storageKey={`${storagePrefix ?? "agent"}:project:${key}`}
          label={project.label}
          count={project.tasks.length + project.sessions.length}
          className="ml-1"
        >
          <AgentSessionRows
            tasks={project.tasks}
            sessions={project.sessions}
            selectedTaskId={selectedTaskId}
            onDeleteSession={onDeleteSession}
            deleteLabel={deleteLabel}
            onOpenExternalSession={onOpenExternalSession}
            onCloseMobile={onCloseMobile}
          />
        </SidebarDisclosure>
      ))}
    </div>
  );
}

function ProjectAgentTree({
  tasks,
  sessions,
  storagePrefix,
  selectedTaskId,
  onDeleteSession,
  deleteLabel,
  onOpenExternalSession,
  onCloseMobile,
}: {
  tasks: Task[];
  sessions: AgentSession[];
  storagePrefix?: string;
  selectedTaskId?: string | null;
  onDeleteSession?: (task: Task) => void;
  deleteLabel: string;
  onOpenExternalSession?: (session: AgentSession) => void;
  onCloseMobile: () => void;
}) {
  const groups = useMemo(() => {
    const map = new Map<string, { tasks: Task[]; sessions: AgentSession[] }>();
    for (const task of tasks) {
      const key = task.agent || "kin";
      const group = map.get(key) ?? { tasks: [], sessions: [] };
      group.tasks.push(task);
      map.set(key, group);
    }
    for (const session of sessions) {
      const group = map.get(session.agent_id) ?? { tasks: [], sessions: [] };
      group.sessions.push(session);
      map.set(session.agent_id, group);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [sessions, tasks]);

  return (
    <div className="space-y-1">
      {groups.map(([agentID, group]) => (
        <SidebarDisclosure
          key={agentID}
          storageKey={`${storagePrefix ?? "project"}:agent:${agentID}`}
          label={agentID}
          count={group.tasks.length + group.sessions.length}
          className="ml-1"
        >
          <AgentSessionRows
            tasks={group.tasks}
            sessions={group.sessions}
            selectedTaskId={selectedTaskId}
            onDeleteSession={onDeleteSession}
            deleteLabel={deleteLabel}
            onOpenExternalSession={onOpenExternalSession}
            onCloseMobile={onCloseMobile}
          />
        </SidebarDisclosure>
      ))}
    </div>
  );
}

function AgentSessionRows({
  tasks,
  sessions,
  selectedTaskId,
  onDeleteSession,
  deleteLabel,
  onOpenExternalSession,
  onCloseMobile,
}: {
  tasks: Task[];
  sessions: AgentSession[];
  selectedTaskId?: string | null;
  onDeleteSession?: (task: Task) => void;
  deleteLabel?: string;
  onOpenExternalSession?: (session: AgentSession) => void;
  onCloseMobile: () => void;
}) {
  const tr = useT();
  return (
    <div className="space-y-0.5">
      {tasks.map((task) => {
        const active = task.id === selectedTaskId;
        const dot = sessionStatusDotClass(task.status, isSessionViewed(task.id));
        return (
          <div
            key={task.id}
            className={[
              "group/session flex items-center gap-0.5 rounded-[7px] min-h-[34px]",
              active
                ? "bg-[var(--kin-fill-strong)] text-kin-text"
                : "text-kin-secondary hover:bg-[var(--kin-fill)] hover:text-kin-text",
            ].join(" ")}
          >
            <NavLink
              to={`/tasks/${task.id}`}
              onClick={() => {
                touchProject(task.cwd);
                if (isTerminal(task.status)) markSessionViewed(task.id);
                onCloseMobile();
              }}
              className="flex flex-1 items-center gap-2 px-2 py-1.5 text-[12.5px] min-w-0"
            >
              <span className={["w-1.5 h-1.5 rounded-full flex-none", dot ?? "bg-transparent"].join(" ")} />
              <span className="truncate flex-1 min-w-0">
                {task.title || displayUserPrompt(task.prompt || "")}
              </span>
            </NavLink>
            {onDeleteSession && deleteLabel && (
              <button
                type="button"
                title={deleteLabel}
                aria-label={deleteLabel}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onDeleteSession(task);
                }}
                className="flex-none w-[22px] h-[22px] mr-1 rounded-md inline-flex items-center justify-center text-kin-muted hover:text-[#ff8a80] hover:bg-[rgba(255,69,58,.12)] opacity-0 group-hover/session:opacity-100 focus:opacity-100 transition-opacity"
              >
                <IconTrash size={12} />
              </button>
            )}
          </div>
        );
      })}
      {sessions.map((session) => (
        <ExternalSessionRow
          key={session.id}
          session={session}
          label={tr("nav.externalSession")}
          onOpen={onOpenExternalSession}
          onCloseMobile={onCloseMobile}
        />
      ))}
    </div>
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
        "w-full flex items-center gap-2 px-2 py-1.5 rounded-[7px] text-[13px] min-h-[34px] text-left",
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
