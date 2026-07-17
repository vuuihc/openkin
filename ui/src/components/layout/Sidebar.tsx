import { useSyncExternalStore } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { formatCost, isTerminal, type Task } from "../../api/client";
import { useT } from "../../i18n/react";
import { getDraftCwd, subscribeDraft } from "../../lib/draftChat";
import { projectLabel } from "../../lib/paths";
import {
  IconInbox,
  IconPlus,
  IconSettings,
  IconTasks,
  IconUsage,
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
  /** Mobile drawer open. Desktop always visible. */
  mobileOpen: boolean;
  onCloseMobile: () => void;
};

function groupByProject(tasks: Task[]): { label: string; cwd: string; items: Task[] }[] {
  const map = new Map<string, Task[]>();
  for (const t of tasks) {
    const key = t.cwd || "unknown";
    const list = map.get(key) ?? [];
    list.push(t);
    map.set(key, list);
  }
  return [...map.entries()]
    .map(([cwd, items]) => ({
      cwd,
      label: projectLabel(cwd),
      items: items
        .slice()
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, 8),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

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
  mobileOpen,
  onCloseMobile,
}: Props) {
  const navigate = useNavigate();
  const tr = useT();
  const groups = groupByProject(tasks);
  const liveDraftCwd = useSyncExternalStore(subscribeDraft, getDraftCwd, getDraftCwd);

  // When draft has a project cwd that matches an existing group, nest it there.
  const draftCwd = draftActive ? liveDraftCwd : "";
  const draftGroupCwd = draftCwd
    ? groups.find((g) => normCwd(g.cwd) === normCwd(draftCwd))?.cwd ?? null
    : null;

  const panel = (
    <aside className="kin-surface-sidebar flex flex-col h-full w-[min(248px,85vw)] flex-none border-r border-[var(--kin-hairline-strong)]">
      {/* Mobile-only brand strip; desktop uses native window chrome (no fake traffic lights). */}
      <div className="md:hidden h-11 flex items-center px-4 flex-none">
        <span className="text-[15px] font-semibold text-kin-text">Kin</span>
      </div>

      <div className="px-3 pt-3 md:pt-3 pb-2.5 flex-none">
        <button
          type="button"
          onClick={() => {
            onNewChat();
            onCloseMobile();
          }}
          className={[
            "w-full flex items-center gap-2 px-2.5 py-[7px] rounded-lg border text-[13.5px] font-medium min-h-[40px]",
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

      <div className="flex-1 overflow-y-auto kin-scroll px-2">
        <button
          type="button"
          onClick={() => {
            navigate("/inbox");
            onCloseMobile();
          }}
          className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-[7px] text-[13px] text-kin-secondary hover:bg-[var(--kin-fill-strong)] hover:text-kin-text min-h-[36px]"
        >
          <IconInbox size={15} className="text-kin-orange" />
          {tr("nav.inbox")}
          {pendingCount > 0 && (
            <span className="ml-auto min-w-[18px] h-[18px] px-1.5 rounded-full bg-kin-orange text-[#1a1a1c] text-[11px] font-bold inline-flex items-center justify-center tabular-nums">
              {pendingCount > 99 ? "99+" : pendingCount}
            </span>
          )}
        </button>

        {groups.length === 0 && (
          <div className="px-2 py-4 text-[12.5px] text-kin-muted leading-relaxed">
            {tr("nav.emptyHint")}
          </div>
        )}

        {groups.map((g) => {
          const nestDraft = Boolean(draftActive && draftGroupCwd === g.cwd);
          return (
            <div key={g.cwd}>
              <div className="kin-section-label group/proj flex items-center gap-1 pr-0.5">
                <span className="truncate flex-1 min-w-0" title={g.cwd}>
                  {g.label}
                </span>
                <button
                  type="button"
                  title={tr("nav.newSessionIn", { project: g.label })}
                  aria-label={tr("nav.newSessionIn", { project: g.label })}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (onNewSessionInProject) onNewSessionInProject(g.cwd);
                    else onNewChat();
                    onCloseMobile();
                  }}
                  className="flex-none w-[22px] h-[22px] rounded-md inline-flex items-center justify-center text-kin-muted hover:text-kin-text hover:bg-[var(--kin-fill-strong)] opacity-70 group-hover/proj:opacity-100 transition-opacity"
                >
                  <IconPlus size={13} strokeWidth={2.2} />
                </button>
              </div>

              {/* Draft nested under its project when cwd matches. */}
              {nestDraft && (
                <DraftRow
                  active
                  label={tr("nav.draftChat")}
                  onClick={() => {
                    onNewChat();
                    onCloseMobile();
                  }}
                />
              )}

              {g.items.map((task) => {
                const active = task.id === selectedTaskId;
                const running = !isTerminal(task.status);
                return (
                  <button
                    key={task.id}
                    type="button"
                    onClick={() => {
                      navigate(`/tasks/${task.id}`);
                      onCloseMobile();
                    }}
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
                        running
                          ? task.status === "waiting_approval"
                            ? "bg-kin-orange"
                            : "bg-kin-blue"
                          : "bg-transparent",
                      ].join(" ")}
                    />
                    <span className="truncate">{task.title || task.prompt}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>

      <div className="border-t border-[var(--kin-hairline)] px-2 py-2 flex flex-col gap-0.5 flex-none">
        <NavLink
          to="/tasks"
          onClick={onCloseMobile}
          className={({ isActive }) =>
            `${footLink} ${isActive ? "bg-[var(--kin-fill-strong)] text-kin-text" : ""}`
          }
        >
          <IconTasks size={14} />
          {tr("nav.tasks")}
          <span className="ml-auto text-kin-muted tabular-nums">{tasks.length}</span>
        </NavLink>
        <NavLink
          to="/usage"
          onClick={onCloseMobile}
          className={({ isActive }) =>
            `${footLink} ${isActive ? "bg-[var(--kin-fill-strong)] text-kin-text" : ""}`
          }
        >
          <IconUsage size={14} />
          {tr("nav.usage")}
          <span className="ml-auto text-kin-muted tabular-nums">
            {weekCost != null ? formatCost(weekCost) : "—"}
          </span>
        </NavLink>
        <NavLink
          to="/settings"
          onClick={onCloseMobile}
          className={({ isActive }) =>
            `${footLink} ${isActive ? "bg-[var(--kin-fill-strong)] text-kin-text" : ""}`
          }
        >
          <IconSettings size={14} />
          {tr("nav.settings")}
        </NavLink>
      </div>
    </aside>
  );

  return (
    <>
      <div className="hidden md:flex h-full shrink-0">{panel}</div>
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
