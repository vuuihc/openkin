import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
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
  showMachineLabels,
  type DeviceGroup,
} from "../../lib/deviceSidebar";
import { useMachines } from "../../hooks/useMachines";
import { sidebarNavSections, type SidebarNavItemId } from "../../lib/sidebarNavigation";
import {
  getViewedSessionIds,
  isSessionViewed,
  markSessionViewed,
  sessionStatusDotClass,
  subscribeSessionViewed,
} from "../../lib/sessionViewed";
import { displayUserPrompt } from "../../lib/attachments";
import { agentAvatarMeta, agentDisplayName } from "../../lib/agentMention";
import {
  agentSessionAvailability,
  displayAgentSessionTitle,
  type AgentSessionAvailability,
} from "../../lib/agentSessionTitle";
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
  "flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-body text-kin-secondary hover:bg-[var(--kin-fill-strong)] hover:text-kin-text transition-colors min-h-10";

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
  /** A lone machine needs no heading: the tree is already all of it. A machine
   *  with both live and archived rows is still one machine. */
  const machineLabels = showMachineLabels(groups, archivedGroups);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
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
        pinLabel={g.pinned && !archived ? tr("nav.unpinProject") : tr("nav.pinProject")}
        collapseLabel={tr("nav.collapseProject")}
        expandLabel={tr("nav.expandProject")}
        coverLabel={tr("nav.openCover")}
        archiveLabel={archived ? tr("nav.unarchiveProject") : tr("nav.archiveProject")}
        newSessionLabel={tr("nav.newSessionIn", { project: g.label })}
        onDeleteSession={onDeleteSession}
        deleteLabel={tr("task.deleteSession")}
        externalSessions={sessionsForProject(device.sessions, g)}
        onOpenExternalSession={onOpenExternalSession}
        mode={mode}
      />
    );
  };

  const panel = (
    <aside className="w-sidebar max-w-[85vw] h-full flex flex-col bg-kin-sidebar shrink-0">
      <div className="px-3 pt-3 pb-2 flex items-center gap-2">
        {/* The mark, flat: the accent fill every primary action already uses.
            There were two different gradients for this same "K" in the tree —
            this one and the chat avatar's — which is two brand palettes, not
            one. The gradient also could not carry white initials at 4.5:1 at
            both of its ends. */}
        <div className="w-7 h-7 rounded-lg bg-kin-blue flex items-center justify-center text-kin-on-brand text-strong font-semibold shadow-e1">
          K
        </div>
        <span className="text-strong font-semibold tracking-tight">{tr("app.name")}</span>
        <div className="ml-auto flex items-center gap-1">
          <div className="relative" ref={sortMenuRef}>
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
                className="absolute right-0 top-full mt-1 z-50 min-w-[148px] rounded-lg bg-kin-elevated shadow-e3 py-1"
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
        </div>
      </div>

      <div className="px-2.5 pb-2 relative" ref={importMenuRef}>
        <button
          type="button"
          disabled={importingExternalSessions || !onImportExternalSessions}
          aria-haspopup="menu"
          aria-expanded={importMenuOpen}
          onClick={() => setImportMenuOpen((open) => !open)}
          className="w-full flex items-center gap-2 px-2.5 h-8 rounded-lg text-body text-kin-secondary border border-[var(--kin-hairline-strong)] hover:bg-[var(--kin-fill-strong)] hover:text-kin-text disabled:opacity-50 transition-colors"
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
            className="absolute left-2.5 right-2.5 top-full mt-1 z-50 rounded-lg bg-kin-elevated shadow-e3 py-1"
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setImportMenuOpen(false);
                onImportExternalSessions?.();
              }}
              className="w-full text-left px-3 py-2 text-body text-kin-text hover:bg-[var(--kin-fill-strong)]"
            >
              {tr("nav.importAllAgents")}
            </button>
            <div className="my-1 border-t border-kin-hairline" />
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
                  className="w-full flex items-center gap-2 px-3 py-2 text-body text-kin-secondary hover:bg-[var(--kin-fill-strong)] hover:text-kin-text"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-kin-blue" />
                  <span className="truncate">{provider.name || provider.id}</span>
                  <span className="ml-auto text-micro text-kin-muted">{provider.id}</span>
                </button>
              ))
            ) : (
              <div className="px-3 py-2 text-caption text-kin-muted">
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
            "w-full flex items-center gap-2 px-2.5 h-9 rounded-lg text-strong font-medium border transition-colors",
            draftActive
              ? "border-kin-blue/40 bg-kin-blue/15 text-kin-text"
              : "border-[var(--kin-hairline-strong)] bg-[var(--kin-fill)] text-kin-text hover:bg-[var(--kin-fill-strong)]",
          ].join(" ")}
        >
          <IconPlus size={15} strokeWidth={1.9} />
          {tr("nav.newChat")}
          <span className="ml-auto text-caption text-kin-muted font-medium hidden sm:inline">
            ⌘N
          </span>
        </button>
      </div>

      <div className="px-3 pb-2">
        <label className="relative flex items-center">
          <IconSearch size={13} className="absolute left-2.5 text-kin-muted pointer-events-none" />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => onSearchQueryChange?.(e.target.value)}
            placeholder={tr("nav.searchSessions")}
            aria-label={tr("nav.searchSessions")}
            className="w-full h-[32px] pl-8 pr-2 rounded-lg bg-[var(--kin-fill)] border border-transparent focus:border-kin-blue/40 focus:bg-[var(--kin-fill-strong)] text-body text-kin-text placeholder:text-kin-muted outline-none transition-colors"
          />
        </label>
        {searchQuery.trim() && (
          <div className="mt-1 px-0.5 text-caption text-kin-muted">
            {searchLoading ? tr("common.loading") : tr("nav.searchHint")}
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
            "w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-strong min-h-9",
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
            showLabel={machineLabels}
            mode="active"
          >
            {device.projects.map((g) => projectBlock(g, device, "active"))}
          </DeviceSection>
        ))}
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
          <div className="pt-1 border-t border-kin-hairline">
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
                    showLabel={machineLabels}
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

      <div className="border-t border-kin-hairline px-2 py-2 space-y-2">
        {sidebarNavSections().map((section) => (
          <div key={section.id} className="space-y-0.5">
            <div className="px-2 pt-1 text-micro font-semibold uppercase tracking-label text-kin-muted">
              {tr(section.labelKey)}
            </div>
            {section.items.map((item) => (
              <NavLink
                key={item.id}
                to={item.path}
                onClick={onCloseMobile}
                className={({ isActive }) =>
                  [footLink, isActive ? "bg-[var(--kin-fill-strong)] text-kin-text" : ""].join(" ")
                }
              >
                {sidebarNavIcon(item.id)}
                <span className="flex-1">{tr(item.labelKey)}</span>
                {item.id === "routines" && routineUnreadCount > 0 && (
                  <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-kin-blue text-micro font-semibold text-kin-on-brand flex items-center justify-center tabular-nums">
                    {routineUnreadCount > 99 ? "99+" : routineUnreadCount}
                  </span>
                )}
                {item.id === "agents" && weekCost != null && weekCost > 0 && (
                  <span className="text-caption text-kin-muted tabular-nums">
                    {formatCost(weekCost)}
                  </span>
                )}
              </NavLink>
            ))}
          </div>
        ))}
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
            className="relative z-10 h-full shadow-e3 bg-kin-sidebar pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
          >
            {panel}
          </div>
        </div>
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
 * @param showLabel When there is only one machine in the tree a heading would
 *                  name the obvious, so the section renders as a plain group.
 * @param mode      Active and archived render the same machine twice, and each
 *                  keeps its own collapsed state — sharing the key would make
 *                  collapsing one silently pre-collapse the other.
 */
function DeviceSection({
  device,
  label,
  count,
  showLabel,
  mode,
  children,
}: {
  device: DeviceGroup;
  label: string;
  count: number;
  showLabel: boolean;
  mode: "active" | "archived";
  children: ReactNode;
}) {
  const tr = useT();
  const [open, toggle] = useSidebarDisclosure(`device:${mode}:${device.id || "self"}`);
  if (!showLabel) return <div className="space-y-3">{children}</div>;
  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left text-body font-medium text-kin-secondary hover:text-kin-text transition-colors"
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

function sidebarNavIcon(id: SidebarNavItemId): ReactNode {
  switch (id) {
    case "artifacts":
      return <IconArtifacts size={15} />;
    case "routines":
      return <IconRoutines size={15} />;
    case "agents":
      return <IconAgents size={15} />;
    case "settings":
      return <IconSettings size={15} />;
  }
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
          <IconPin size={11} className="flex-none text-kin-blue-ink opacity-90" />
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
          /*
            Hidden on phones. These three are hover-revealed (`opacity-0
            group-hover/proj:opacity-100`), so on a touch screen the tap that
            would reveal them is also the tap that expands the project — they
            were never reachable. Keeping them also squeezed the project name to
            0px wide in the 240px drawer once the phone's 44pt floor widened
            every button in this row. The expanded body carries the same three
            actions for touch, behind `.touch-only`.
          */
          className="touch-hide inline-flex flex-none w-[22px] h-[22px] rounded-md items-center justify-center text-kin-muted hover:text-kin-text hover:bg-[var(--kin-fill-strong)] opacity-0 group-hover/proj:opacity-100 focus:opacity-100 transition-opacity"
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
              "touch-hide inline-flex flex-none w-[22px] h-[22px] rounded-md items-center justify-center transition-opacity",
              g.pinned
                ? "text-kin-blue-ink opacity-100"
                : "text-kin-muted hover:text-kin-text hover:bg-[var(--kin-fill-strong)] opacity-0 group-hover/proj:opacity-100 focus:opacity-100",
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
            "touch-hide inline-flex flex-none w-[22px] h-[22px] rounded-md items-center justify-center text-kin-muted hover:text-kin-text hover:bg-[var(--kin-fill-strong)] transition-opacity",
            mode === "archived"
              ? "opacity-100"
              : "opacity-0 group-hover/proj:opacity-100 focus:opacity-100",
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
            <ProjectSessionRows
              tasks={g.items}
              sessions={externalSessions}
              selectedTaskId={selectedTaskId}
              onDeleteSession={onDeleteSession}
              deleteLabel={deleteLabel}
              onOpenExternalSession={onOpenExternalSession}
              onCloseMobile={onCloseMobile}
            />
          </div>

          {/*
            Cover, pin and archive are revealed by `group-hover/proj` in the row
            above, which a touch screen cannot produce — and once the phone's
            44pt floor widened them, four of them also squeezed the project name
            to 0px in the 240px drawer. They are dropped from the row there; the
            same three actions live here instead, in the expanded body, where a
            full-width control costs no room. Unpinning a pinned project and
            unarchiving an archived one were reachable before (they are drawn
            `opacity-100` in those states); pinning a fresh project and
            archiving an active one never were.
          */}
          <div className="touch-only flex-col gap-1.5 px-0.5 pt-1.5">
            <button
              type="button"
              onClick={() => void openCover()}
              className="w-full truncate rounded-lg border border-[var(--kin-hairline-strong)] bg-[var(--kin-fill)] px-2 text-body text-kin-secondary"
            >
              {coverLabel}
            </button>
            <div className="flex items-center gap-1.5">
              {mode === "active" && (
                <button
                  type="button"
                  onClick={onTogglePin}
                  className={[
                    "flex-1 min-w-0 truncate rounded-lg border px-2 text-body",
                    g.pinned
                      ? "border-kin-blue/40 bg-kin-blue/15 text-kin-blue-ink"
                      : "border-[var(--kin-hairline-strong)] bg-[var(--kin-fill)] text-kin-secondary",
                  ].join(" ")}
                >
                  {pinLabel}
                </button>
              )}
              <button
                type="button"
                onClick={onArchive}
                className="flex-1 min-w-0 truncate rounded-lg border border-[var(--kin-hairline-strong)] bg-[var(--kin-fill)] px-2 text-body text-kin-secondary"
              >
                {archiveLabel}
              </button>
            </div>
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
}: {
  session: AgentSession;
  label: string;
  sessionTitle: string;
  onOpen?: (session: AgentSession) => void;
  onCloseMobile: () => void;
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
      onClick={() => {
        onOpen?.(session);
        onCloseMobile();
      }}
      className={[
        "w-full flex items-center gap-2 px-1.5 py-1.5 rounded-lg border text-left text-body min-h-9 transition-colors",
        externalSessionRowClass(availability),
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

function externalSessionRowClass(availability: AgentSessionAvailability): string {
  if (availability === "linked") {
    return "border-kin-blue/25 bg-kin-blue/10 text-kin-text hover:bg-kin-blue/15";
  }
  if (availability === "resumable") {
    return "border-kin-green/25 bg-kin-green/10 text-kin-text hover:bg-kin-green/15";
  }
  return "border-kin-hairline border-dashed bg-[var(--kin-fill)] text-kin-secondary hover:bg-[var(--kin-fill-strong)] hover:text-kin-text";
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
              "group/session flex items-center gap-0.5 rounded-lg min-h-9",
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
              className="flex flex-1 items-center gap-2 px-2 py-1.5 text-body min-w-0"
            >
              <span
                className={["w-1.5 h-1.5 rounded-full flex-none", dot ?? "bg-transparent"].join(
                  " ",
                )}
              />
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
