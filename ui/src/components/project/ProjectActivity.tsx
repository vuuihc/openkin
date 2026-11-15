/* eslint-disable kin/no-raw-button -- markup moved unchanged from ProjectDetailPage; new controls should use a shared primitive. */
import type { ReactNode } from "react";
import type { ProjectChatRow } from "../../lib/projectChats";
import { agentAvatarMeta, agentDisplayName } from "../../lib/agentMention";
import { formatRelativeTime } from "../../lib/relativeTime";
import { sessionStatusDotClass } from "../../lib/sessionViewed";
import { taskCardStatusView } from "../../lib/taskCardStatus";
import { IconMachine } from "../icons";
import { SkeletonLine } from "../Skeleton";
import { useT } from "../../i18n/react";

/**
 * "Recent activity" on the project cover: the newest conversation only.
 *
 * The list lives in the sidebar; this section answers "where do I continue"
 * with one row and says so. The last-commit and last-import stamps sit with
 * it because they describe the same window of work.
 */
type Props = {
  titleId: string;
  /** The newest conversation, or `null` when the feed has none to show. */
  activity: ProjectChatRow | null;
  loading: boolean;
  /** The feed has answered for this project; before that it is a skeleton. */
  ready: boolean;
  error: string | null;
  /** One of the feeds behind the row failed, so the list may be short. */
  partial: boolean;
  lastCommit: number | null;
  importAt: number | null;
  windowDays: number;
  now: number;
  onRetry: () => void;
  onOpen: (row: ProjectChatRow) => void;
  /** The continue affordance, placed with the row on wide layouts. */
  continueControl?: ReactNode;
  showContinue?: boolean;
};

export default function ProjectActivity({
  titleId,
  activity,
  loading,
  ready,
  error,
  partial,
  lastCommit,
  importAt,
  windowDays,
  now,
  onRetry,
  onOpen,
  continueControl,
  showContinue = false,
}: Props) {
  const tr = useT();

  return (
    <section aria-labelledby={titleId} className="rounded-xl bg-kin-panel p-4">
      <h2
        id={titleId}
        className="mb-2 text-body font-medium uppercase tracking-label text-kin-secondary"
      >
        {tr("projects.recentTitle")}
      </h2>

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-kin-red/30 bg-kin-red/10 px-3 py-2 text-strong text-kin-red-ink"
        >
          <p>{error}</p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-2 min-h-11 rounded-lg border border-kin-red/40 px-3 text-strong text-kin-red-ink"
          >
            {tr("common.retry")}
          </button>
        </div>
      )}

      {activity ? (
        <div className={error ? "mt-3" : ""}>
          <div className="text-caption font-medium text-kin-muted">
            {tr("projects.recentLastConversation")}
          </div>
          <RecentConversationRow row={activity} now={now} onOpen={() => onOpen(activity)} />
        </div>
      ) : (loading || !ready) && !error ? (
        <div className="space-y-3 py-2">
          <SkeletonLine />
          <SkeletonLine />
        </div>
      ) : !error ? (
        <div className="py-1 text-body text-kin-secondary">
          <p>{tr("projects.recentEmpty")}</p>
          <p className="mt-1 text-kin-muted">{tr("projects.recentEmptyHint")}</p>
        </div>
      ) : null}

      {partial && !error && (
        <p role="status" className="mt-2 text-caption text-kin-muted">
          {tr("projects.chatsPartial")}
        </p>
      )}

      <dl className="mt-2 space-y-1 text-caption text-kin-muted">
        {lastCommit !== null && (
          <div className="flex gap-1">
            <dt>{tr("projects.lastCommitWindow", { days: windowDays })}</dt>
            <dd aria-hidden>{tr("common.labelSeparator")}</dd>
            <dd className="tabular-nums">{formatRelativeTime(lastCommit, now)}</dd>
          </div>
        )}
        {importAt !== null && (
          <div className="flex gap-1">
            <dt>{tr("projects.lastImport")}</dt>
            <dd aria-hidden>{tr("common.labelSeparator")}</dd>
            <dd className="tabular-nums">{formatRelativeTime(importAt, now)}</dd>
          </div>
        )}
      </dl>

      <p className="mt-2 text-caption text-kin-muted">{tr("projects.recentOnlyLatest")}</p>

      {showContinue && continueControl ? <div className="mt-3">{continueControl}</div> : null}
    </section>
  );
}

function RecentConversationRow({
  row,
  now,
  onOpen,
}: {
  row: ProjectChatRow;
  now: number;
  onOpen: () => void;
}) {
  const tr = useT();
  const avatar = agentAvatarMeta(row.agentId);
  const status = row.task ? taskCardStatusView(row.task.status) : null;
  // The same dot rule as the list, so a row means the same thing in both
  // places: green for a finished chat not yet seen, pulsing while it runs.
  const dot = row.task ? sessionStatusDotClass(row.task.status, false) : null;
  const label = [
    row.title,
    agentDisplayName(row.agentId),
    formatRelativeTime(row.at, now),
    status ? tr(status.labelKey) : "",
    row.remote ? tr("machine.remote") : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={label}
      className="kin-row-press flex min-h-11 w-full items-center gap-2.5 px-1 py-2 text-left"
    >
      <span className="flex w-2 flex-none justify-center">
        {dot ? <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden /> : null}
      </span>
      <span
        className={`flex h-5 w-5 flex-none items-center justify-center rounded-full text-micro font-semibold ${avatar.className}`}
        title={agentDisplayName(row.agentId)}
        aria-hidden
      >
        {avatar.initials}
      </span>
      <span className="min-w-0 flex-1 truncate text-subtitle font-medium leading-ui text-kin-text">
        {row.title}
      </span>
      {row.remote && (
        <span className="flex-none text-kin-muted" title={tr("machine.remote")} aria-hidden>
          <IconMachine size={12} />
        </span>
      )}
      <span className="flex-none text-caption leading-ui text-kin-muted tabular-nums">
        {formatRelativeTime(row.at, now)}
      </span>
      <span className="flex-none text-caption text-kin-secondary">
        {tr("projects.recentContinue")} <span aria-hidden>→</span>
      </span>
    </button>
  );
}
