import type { CSSProperties } from "react";
import { Link } from "react-router-dom";
import type { Task } from "../../api/client";
import { taskDisplayTitle } from "../../lib/taskTitle";
import { useLocalTaskTitles } from "../../lib/taskTitles";
import { useT } from "../../i18n/react";
import {
  IconArchive,
  IconBack,
  IconMore,
  IconPanel,
  IconPullRequest,
  IconRestore,
  IconSessions,
  IconShare,
  IconTrash,
} from "../icons";
import MobileHeader, { MobileHeaderButton } from "../mobile/MobileHeader";
import Button from "../ui/Button";

/**
 * The session's live state, as one fixed-size pill.
 *
 * Both bars draw the same pill: on the phone it leads the subtitle row beside
 * the project and branch, and on the desktop it sits beside Stop. It never
 * wraps and never shrinks, so a long project or branch truncates instead of
 * pushing the state out of view — the state is the one thing on the row that
 * has to stay readable at every width.
 */
function StatusPill({ degraded }: { degraded: boolean }) {
  const tr = useT();
  return (
    <span
      data-task-status={degraded ? "reconnect" : "running"}
      className={[
        "inline-flex flex-none items-center whitespace-nowrap rounded-full px-2 py-0.5",
        "text-micro font-semibold leading-flush tabular-nums",
        degraded ? "bg-kin-orange/10 text-kin-orange-ink" : "bg-kin-blue/10 text-kin-blue-ink",
      ].join(" ")}
    >
      {degraded ? tr("task.reconnect") : tr("task.running")}
    </span>
  );
}

/**
 * How many subagent calls the live turn still has running, beside the pill.
 *
 * A count, not a control: no button, no panel, no per-subagent stop — the
 * existing Stop interrupts the turn, which is the only cancellation a
 * subagent has. It is text in the same fixed-size, non-shrinking spirit as
 * the pill, so it reads as part of the state the header already shows and
 * never pushes the title around. At zero it is absent rather than "0".
 */
function SubagentCount({ count }: { count: number }) {
  const tr = useT();
  return (
    <span className="inline-flex flex-none items-center whitespace-nowrap text-micro text-kin-muted tabular-nums">
      {tr("task.subagentCount", { count })}
    </span>
  );
}

/*
 * The desktop bar's five verbs are the shared `Button` facade (Astryx behind
 * `.kin-btn-*`), not hand-rolled `<button>`s. Every callback, accessible name
 * and disabled state is the page's own and unchanged; the only thing that
 * moved is the control surface. `MobileHeaderButton` stays the phone header's
 * own primitive, because it is the 44pt square the bar is built around.
 */

/**
 * The conversation's header, at both widths.
 *
 * The phone gets one bar: back, the session title, and the ⋯ that opens the
 * action sheet. The sheet itself stays on the page — it also names the machine
 * the session runs on, which is page state — but its trigger lives here.
 * From `md` up the bar carries the host chip, the workspace/share/archive/
 * delete verbs, the project and, while the session is live, its status and
 * Stop.
 *
 * Extracted from `TaskDetailPage` unchanged so later facade work can find the
 * header without reading the whole page. None of these controls is
 * re-implemented: every callback is the page's own.
 */
export type TaskHeaderProps = {
  task: Task;
  hostAgentName: string;
  hostAgentAvatar: { initials: string; className: string };
  project: string;
  /** The session's turn has ended; Stop is hidden and no status is shown. */
  terminal: boolean;
  /** Connected to the daemon's live stream but not receiving it. */
  degraded: boolean;
  /**
   * Subagent calls this turn still has in flight. Absent or 0 draws nothing —
   * zero is the empty state, and an agent with no subagent concept never
   * reports one.
   */
  subagentsRunning?: number;
  filesOpen: boolean;
  /** The read-only pull-request panel is the surface in front. */
  prOpen: boolean;
  /**
   * A panel (files, pull request or publish) is open for this conversation.
   *
   * The shell hides the conversation list while that is true, so this is what
   * draws the one control that brings it back. `filesOpen` is the workspace
   * toggle's pressed state and cannot stand in: the publish sheet counts too.
   */
  panelOpen: boolean;
  archiving: boolean;
  deleting: boolean;
  stopping: boolean;
  onToggleWorkspace: () => void;
  onTogglePr: () => void;
  onShare: () => void;
  onToggleArchive: () => void | Promise<void>;
  onDelete: () => void | Promise<void>;
  onStop: () => void | Promise<void>;
  onBack: () => void;
  onOpenActions: () => void;
  /**
   * Bring the conversation list back. It closes the panel rather than
   * revealing the list beside it: one surface at a time is the rule the
   * widths are built on (TASTE 17).
   */
  onShowList: () => void;
};

export default function TaskHeader({
  task,
  hostAgentName,
  hostAgentAvatar,
  project,
  terminal,
  degraded,
  subagentsRunning = 0,
  filesOpen,
  prOpen,
  panelOpen,
  archiving,
  deleting,
  stopping,
  onToggleWorkspace,
  onTogglePr,
  onShare,
  onToggleArchive,
  onDelete,
  onStop,
  onBack,
  onOpenActions,
  onShowList,
}: TaskHeaderProps) {
  const tr = useT();
  // This browser's renames, the same map the list's row menu writes
  // (`taskTitles.ts`). The header is open when a rename happens in the sidebar
  // or another tab, so it subscribes and re-reads rather than trusting the
  // title it mounted with — that stale copy was the whole bug.
  const [localTitles] = useLocalTaskTitles();
  const title = taskDisplayTitle(task, localTitles);
  const archiveLabel = task.archived_at ? tr("task.unarchiveSession") : tr("task.archiveSession");

  return (
    <>
      {/*
        The phone's one bar: back, the session's title, and the ⋯ that opens
        the same action sheet the chip row used to. The chip row was a second
        44px line holding a host badge, a project link, a status word and the
        overflow trigger — on a 390px screen it took two rows and its own
        horizontal scroll, and the title above it was truncated to make room.
        The status survives as the subtitle; everything else is one tap away.
      */}
      <MobileHeader
        title={title}
        subtitle={
          // The project and branch are what the session belongs to; the round's
          // state is a pill that leads the row while it is live rather than
          // replacing them, so the second line still answers "which session is
          // this" when a run is in flight. The text truncates, the pill does
          // not: a long project can no longer squeeze the state out of view.
          task.cwd || !terminal ? (
            <span className="flex min-w-0 items-center justify-center gap-1.5">
              {!terminal && <StatusPill degraded={degraded} />}
              {!terminal && subagentsRunning > 0 && <SubagentCount count={subagentsRunning} />}
              {task.cwd && (
                <span className="min-w-0 truncate">
                  {[project, task.workspace_branch].filter(Boolean).join(" · ")}
                </span>
              )}
            </span>
          ) : undefined
        }
        leading={
          <MobileHeaderButton label={tr("app.back")} onClick={onBack}>
            <IconBack size={20} strokeWidth={2} />
          </MobileHeaderButton>
        }
        trailing={
          <MobileHeaderButton
            label={tr("task.sessionActions")}
            onClick={onOpenActions}
            tone="muted"
          >
            <IconMore size={19} />
          </MobileHeaderButton>
        }
      />

      {/* Desktop's bar. Same content as before; the phone branch above owns
          the small widths now, so the mobile-only controls are gone. */}
      <div
        className="hidden md:flex min-h-11 flex-none items-center px-5 border-b border-[var(--kin-hairline)]"
        style={{ WebkitAppRegion: "drag" } as CSSProperties}
      >
        {/* The title keeps a readable floor rather than yielding to the verbs:
            with a panel open at 1100px the row is ~700px wide, and a `flex-1`
            title with no floor collapsed to its first character. The action
            cluster is the one that scrolls when space runs out. */}
        <div className="min-w-cell flex-1">
          <div className="text-strong font-semibold text-kin-text truncate">{title}</div>
        </div>
        <div
          /* `min-w-0`, not `flex-none`: the row is desktop-only now, and a
             non-shrinking cluster whose natural width passes the window edge
             was clipped there instead of scrolling inside its own box. */
          className="ml-2 flex min-w-0 items-center gap-2 overflow-x-auto kin-scroll whitespace-nowrap text-body text-kin-muted"
          style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
        >
          <span
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--kin-hairline-strong)] bg-[var(--kin-fill)] px-2 py-1"
            title={tr("newChat.hostAgent", { name: hostAgentName })}
          >
            <span
              className={`w-4 h-4 rounded-md inline-flex items-center justify-center text-micro font-semibold ${hostAgentAvatar.className}`}
            >
              {hostAgentAvatar.initials}
            </span>
            <span className="hidden xl:inline">
              {tr("newChat.hostAgent", { name: hostAgentName })}
            </span>
          </span>
          {/* The list column yielded to an open panel; this is its way back.
              It is desktop-only because the phone has no list column to
              reveal — its list is a page, not a column (TASTE 3). */}
          {panelOpen && (
            <Button
              variant="secondary"
              onClick={onShowList}
              aria-label={tr("nav.showList")}
              className="gap-1.5 rounded-md px-2 py-1 text-body font-normal text-kin-secondary hover:text-kin-text"
              title={tr("nav.showList")}
            >
              <IconSessions size={13} />
              <span>{tr("nav.showList")}</span>
            </Button>
          )}
          <Button
            variant="secondary"
            onClick={onToggleWorkspace}
            aria-pressed={filesOpen}
            aria-label={tr("workspace.title")}
            className={[
              "gap-1.5 rounded-md px-2 py-1 text-body font-normal",
              filesOpen
                ? "border-kin-blue/50 bg-kin-blue/15 text-kin-text"
                : "text-kin-secondary hover:text-kin-text",
            ].join(" ")}
            title={tr("workspace.toggle")}
          >
            <IconPanel size={13} />
            {/* Below `xl` the verbs keep their icon, accessible name and
                tooltip but give up the word, so the title and the primary
                surfaces stay readable when a panel narrows the row. */}
            <span className="hidden xl:inline">{tr("workspace.title")}</span>
          </Button>
          {/* The pull request is a sibling surface to the workspace, in the
              same right-side container (TASTE 17), so its toggle is that
              toggle's peer rather than a row inside the file tree. */}
          <Button
            variant="secondary"
            onClick={onTogglePr}
            aria-pressed={prOpen}
            aria-label={tr("pr.title")}
            className={[
              "gap-1.5 rounded-md px-2 py-1 text-body font-normal",
              prOpen
                ? "border-kin-blue/50 bg-kin-blue/15 text-kin-text"
                : "text-kin-secondary hover:text-kin-text",
            ].join(" ")}
            title={tr("pr.title")}
          >
            <IconPullRequest size={13} />
            <span>{tr("pr.title")}</span>
          </Button>
          <Button
            variant="secondary"
            onClick={onShare}
            aria-label={tr("task.share")}
            className="gap-1.5 rounded-md px-2 py-1 text-body font-normal text-kin-secondary hover:text-kin-text"
            title={tr("task.shareTitle")}
          >
            <IconShare size={13} />
            <span className="hidden xl:inline">{tr("task.share")}</span>
          </Button>
          <Button
            variant="secondary"
            onClick={() => void onToggleArchive()}
            disabled={archiving}
            className="gap-1 rounded-md px-2 py-1 text-body font-normal text-kin-secondary hover:text-kin-text disabled:opacity-40"
            title={archiveLabel}
            aria-label={archiveLabel}
          >
            {task.archived_at ? <IconRestore size={13} /> : <IconArchive size={13} />}
          </Button>
          <Button
            variant="secondary"
            onClick={() => void onDelete()}
            disabled={deleting}
            className="gap-1 rounded-md px-2 py-1 text-body font-normal text-kin-secondary hover:text-kin-red-ink hover:border-kin-red/35 disabled:opacity-40"
            title={tr("task.deleteSession")}
            aria-label={tr("task.deleteSession")}
          >
            <IconTrash size={13} />
          </Button>
          {task.project_id ? (
            <Link
              to={`/projects/${encodeURIComponent(task.project_id)}`}
              title={project}
              className="max-w-[10rem] md:max-w-none truncate text-kin-secondary hover:text-kin-text hover:underline"
            >
              {project}
            </Link>
          ) : (
            <span className="max-w-[10rem] md:max-w-none truncate" title={project}>
              {project}
            </span>
          )}
          {!terminal && (
            <>
              {/* The count merges into the live-state cluster the pill already
                  leads: same row, same moment, no new container. */}
              {subagentsRunning > 0 && <SubagentCount count={subagentsRunning} />}
              <StatusPill degraded={degraded} />
              <Button
                variant="secondary"
                onClick={() => void onStop()}
                disabled={stopping}
                className="text-body font-semibold text-kin-red-ink hover:bg-kin-red/15 disabled:opacity-40 px-1.5 py-0.5 rounded-md border-kin-red/30 bg-kin-red/10"
              >
                {stopping ? tr("task.stopping") : tr("composer.stop")}
              </Button>
            </>
          )}
        </div>
      </div>
    </>
  );
}
