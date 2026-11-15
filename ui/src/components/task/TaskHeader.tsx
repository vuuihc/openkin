import type { CSSProperties } from "react";
import { Link } from "react-router-dom";
import type { Task } from "../../api/client";
import { displayUserPrompt } from "../../lib/attachments";
import { useT } from "../../i18n/react";
import {
  IconArchive,
  IconBack,
  IconMore,
  IconPanel,
  IconRestore,
  IconShare,
  IconTrash,
} from "../icons";
import MobileHeader, { MobileHeaderButton } from "../mobile/MobileHeader";

/*
 * The desktop bar's five controls are moved verbatim from `TaskDetailPage`,
 * not re-implemented: this slice is an extraction with zero behaviour change.
 * Migrating them to the shared `Button` is the facade work this extraction
 * unblocks, and belongs in its own reviewed change rather than here. The
 * suppression is per control, so a sixth raw button added here later is still
 * reported.
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
  filesOpen: boolean;
  archiving: boolean;
  deleting: boolean;
  stopping: boolean;
  onToggleWorkspace: () => void;
  onShare: () => void;
  onToggleArchive: () => void | Promise<void>;
  onDelete: () => void | Promise<void>;
  onStop: () => void | Promise<void>;
  onBack: () => void;
  onOpenActions: () => void;
};

export default function TaskHeader({
  task,
  hostAgentName,
  hostAgentAvatar,
  project,
  terminal,
  degraded,
  filesOpen,
  archiving,
  deleting,
  stopping,
  onToggleWorkspace,
  onShare,
  onToggleArchive,
  onDelete,
  onStop,
  onBack,
  onOpenActions,
}: TaskHeaderProps) {
  const tr = useT();
  const title = task.title || displayUserPrompt(task.prompt || "");
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
          // The project is what the session belongs to; the round's state is
          // appended while it is live rather than replacing the project, so
          // the second line still answers "which session is this" when a run
          // is in flight.
          [
            task.cwd ? project : undefined,
            !terminal ? (degraded ? tr("task.reconnect") : tr("task.running")) : undefined,
          ]
            .filter(Boolean)
            .join(" · ") || undefined
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
        <div className="min-w-0 flex-1">
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
            <span>{tr("newChat.hostAgent", { name: hostAgentName })}</span>
          </span>
          {/* eslint-disable-next-line kin/no-raw-button -- moved unchanged from
              TaskDetailPage; the facade migration is the next slice. */}
          <button
            type="button"
            onClick={onToggleWorkspace}
            className={[
              "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-body transition-colors",
              filesOpen
                ? "border-kin-blue/50 bg-kin-blue/15 text-kin-text"
                : "border-[var(--kin-hairline-strong)] bg-[var(--kin-fill)] text-kin-secondary hover:text-kin-text",
            ].join(" ")}
            title={tr("workspace.toggle")}
          >
            <IconPanel size={13} />
            <span>{tr("workspace.title")}</span>
          </button>
          {/* eslint-disable-next-line kin/no-raw-button -- moved unchanged from
              TaskDetailPage; the facade migration is the next slice. */}
          <button
            type="button"
            onClick={onShare}
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--kin-hairline-strong)] bg-[var(--kin-fill)] px-2 py-1 text-body text-kin-secondary transition-colors hover:text-kin-text"
            title={tr("task.shareTitle")}
          >
            <IconShare size={13} />
            <span>{tr("task.share")}</span>
          </button>
          {/* eslint-disable-next-line kin/no-raw-button -- moved unchanged from
              TaskDetailPage; the facade migration is the next slice. */}
          <button
            type="button"
            onClick={() => void onToggleArchive()}
            disabled={archiving}
            className="inline-flex items-center gap-1 rounded-md border border-[var(--kin-hairline-strong)] bg-[var(--kin-fill)] px-2 py-1 text-body text-kin-secondary transition-colors hover:text-kin-text disabled:opacity-40"
            title={archiveLabel}
            aria-label={archiveLabel}
          >
            {task.archived_at ? <IconRestore size={13} /> : <IconArchive size={13} />}
          </button>
          {/* eslint-disable-next-line kin/no-raw-button -- moved unchanged from
              TaskDetailPage; the facade migration is the next slice. */}
          <button
            type="button"
            onClick={() => void onDelete()}
            disabled={deleting}
            className="inline-flex items-center gap-1 rounded-md border border-[var(--kin-hairline-strong)] bg-[var(--kin-fill)] px-2 py-1 text-body text-kin-secondary hover:text-kin-red-ink hover:border-kin-red/35 disabled:opacity-40"
            title={tr("task.deleteSession")}
            aria-label={tr("task.deleteSession")}
          >
            <IconTrash size={13} />
          </button>
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
              <span className="text-kin-blue-ink tabular-nums">
                {degraded ? tr("task.reconnect") : tr("task.running")}
              </span>
              {/* eslint-disable-next-line kin/no-raw-button -- moved unchanged
                  from TaskDetailPage; the facade migration is the next slice. */}
              <button
                type="button"
                onClick={() => void onStop()}
                disabled={stopping}
                className="text-body font-semibold text-kin-red-ink hover:bg-kin-red/15 disabled:opacity-40 px-1.5 py-0.5 rounded-md border border-kin-red/30 bg-kin-red/10"
              >
                {stopping ? tr("task.stopping") : tr("composer.stop")}
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}
