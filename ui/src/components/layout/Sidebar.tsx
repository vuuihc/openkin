import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { ensureProject, formatCost, isTerminal, type Task } from "../../api/client";
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
import {
  IconArchive,
  IconFile,
  IconArtifacts,
  IconInbox,
  IconPin,
  IconPlus,
  IconSettings,
  IconSort,
  IconTrash,
  IconAgents,
} from "../icons";

type Props = {
  tasks: Task[];
  selectedTaskId?: string | null;
  /** Highlight the draft / New chat entry. */
  draftActive?: boolean;
  pendingCount: number;
  weekCost?: number | null;
  onNewChat: () => void;
  /** New session scoped to a project cwd (Claude/Codex style). */
  onNewSessionInProject?: (cwd: string) => void;
  /** Permanently delete a session/task. */
  onDeleteSession?: (task: Task) => void;
  /** Mobile drawer open. Desktop always visible. */
  mobileOpen: boolean;
  onCloseMobile: () => void;
};

/** Normalize path for cwd comparison across platforms. */
function normCwd(cwd: string): string {
  return cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

const footLink =
  "flex items-center gap-2.5 px-2 py-1.5 rounded-[7px] text-[12.5px] text-kin-secondary hover:bg-[var(--kin-fill-strong)] hover:text-kin-text transition-colors min-h-[40px]";

export default function Sidebar({
  tasks,
  selectedTaskId,
  draftActive,
  pendingCount,
  weekCost,
  onNewChat,
  onNewSessionInProject,
  onDeleteSession,
  mobileOpen,
  onCloseMobile,
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
  const groups = useMemo(() => groupByProject(tasks), [tasks, prefsTick]);
  const archivedGroups = useMemo(
    () => groupByProject(tasks, { onlyArchived: true }),
    [tasks, prefsTick],
  );
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const sortMenuRef = useRef<HTMLDivElement>(null);

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

  // When the user opens a task, bump its project last-interact so "recent" stays fresh.
  // Also restores the project if it was archived (open ⇒ unarchive).
  // Terminal success: mark viewed so the green "done" dot clears.
  useEffect(() => {
    if (!selectedTaskId) return;
    const t = tasks.find((x) => x.id === selectedTaskId);
    if (t?.cwd) touchProject(t.cwd);
    if (t && isTerminal(t.status)) markSessionViewed(t.id);
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
                  ["recent", "nav.sortByRecent"],
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

        {groups.length === 0 && archivedGroups.length === 0 && (
          <div className="px-2 py-4 text-[12.5px] text-kin-muted leading-relaxed">
            {tr("nav.emptyHint")}
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
              coverLabel={tr("nav.openCover")}
              archiveLabel={tr("nav.archiveProject")}
              newSessionLabel={tr("nav.newSessionIn", { project: g.label })}
              onDeleteSession={onDeleteSession}
              deleteLabel={tr("task.deleteSession")}
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
          <div className="pt-1 border-t border-kin-border/60">
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
                      coverLabel={tr("nav.openCover")}
                      archiveLabel={tr("nav.unarchiveProject")}
                      newSessionLabel={tr("nav.newSessionIn", { project: g.label })}
                      onDeleteSession={onDeleteSession}
                      deleteLabel={tr("task.deleteSession")}
                      mode="archived"
                    />
                  );
                })}
              </div>
            )}
          </div>
        )}
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
        </NavLink>        <NavLink
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
  onTogglePin,
  onArchive,
  pinLabel,
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
  onTogglePin: () => void;
  onArchive: () => void;
  pinLabel: string;
  archiveLabel: string;
  coverLabel: string;
  newSessionLabel: string;
  deleteLabel: string;
  mode: "active" | "archived";
}) {
  const navigate = useNavigate();
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

      {nestDraft && (
        <DraftRow active={draftRowActive} label={draftLabel} onClick={onDraftClick} />
      )}

      <div className="space-y-0.5">
        {g.items.map((t) => {
          const active = t.id === selectedTaskId;
          const dot = sessionStatusDotClass(t.status, isSessionViewed(t.id));
          return (
            <div
              key={t.id}
              className={[
                "group/session flex items-center gap-0.5 rounded-[7px] min-h-[34px]",
                active
                  ? "bg-[var(--kin-fill-strong)] text-kin-text"
                  : "text-kin-secondary hover:bg-[var(--kin-fill)] hover:text-kin-text",
              ].join(" ")}
            >
              <NavLink
                to={`/tasks/${t.id}`}
                onClick={() => {
                  touchProject(t.cwd || g.cwd);
                  if (isTerminal(t.status)) markSessionViewed(t.id);
                  onCloseMobile();
                }}
                className="flex flex-1 items-center gap-2 px-2 py-1.5 text-[13px] min-w-0"
              >
                <span
                  className={[
                    "w-1.5 h-1.5 rounded-full flex-none",
                    dot ?? "bg-transparent",
                  ].join(" ")}
                />
                <span className="truncate flex-1 min-w-0">{t.title || t.prompt}</span>
              </NavLink>
              {onDeleteSession && (
                <button
                  type="button"
                  title={deleteLabel}
                  aria-label={deleteLabel}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onDeleteSession(t);
                  }}
                  className="flex-none w-[22px] h-[22px] mr-1 rounded-md inline-flex items-center justify-center text-kin-muted hover:text-[#ff8a80] hover:bg-[rgba(255,69,58,.12)] opacity-0 group-hover/session:opacity-100 focus:opacity-100 transition-opacity"
                >
                  <IconTrash size={12} />
                </button>
              )}
            </div>
          );
        })}
      </div>
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
