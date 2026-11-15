import type { MouseEvent as ReactMouseEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { Routine, Task } from "../../api/client";
import { onGuardedLinkClick } from "../../lib/phoneNavigation";
import { ROUTINE_HISTORY_MAX } from "../../lib/routineHistory";
import { formatWhen } from "../../lib/routineTime";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

function statusLabel(status: string, tr: Translate): string {
  switch (status) {
    case "queued":
      return tr("routines.statusQueued");
    case "running":
      return tr("routines.statusRunning");
    case "succeeded":
      return tr("routines.statusSucceeded");
    case "failed":
      return tr("routines.statusFailed");
    case "canceled":
      return tr("routines.statusCanceled");
    case "waiting_approval":
    case "waiting_input":
      return tr("routines.statusWaiting");
    default:
      return status;
  }
}

/**
 * One routine's run records: when it ran, what came of it, and how long it
 * took. The conversation itself stays in its project; this panel never renders
 * messages, only the record and the way to open the conversation that owns
 * them.
 */
export function RunHistoryPanel({
  routine,
  runs,
  loading,
  error,
  hasMore,
  loadingOlder,
  remote,
  device,
  onLoadOlder,
  onRetry,
  onMarkRead,
  tr,
}: {
  routine: Routine;
  runs: Task[];
  loading: boolean;
  error?: string;
  hasMore: boolean;
  loadingOlder: boolean;
  /** A remote machine's runs come from the relayed feed; there is no older page. */
  remote: boolean;
  /** The remote machine whose task route owns this run. */
  device?: string;
  onLoadOlder: () => void;
  onRetry: () => void;
  onMarkRead: (id: string) => void;
  tr: Translate;
}) {
  const title = routine.title || routine.prompt.slice(0, 48);
  return (
    <section
      aria-labelledby={`runs-${routine.id}`}
      className="rounded-2xl border border-[var(--kin-hairline)] bg-[var(--kin-fill)] p-3"
    >
      <h2 id={`runs-${routine.id}`} className="truncate text-strong font-medium text-kin-text">
        {tr("routines.runsPanelTitle", { title })}
      </h2>
      <p className="mt-0.5 text-caption leading-5 text-kin-muted">{tr("routines.runsPanelHint")}</p>
      {loading ? (
        <p className="mt-2 text-body text-kin-muted">{tr("routines.historyLoading")}</p>
      ) : error ? (
        <div className="mt-2">
          <p className="text-body text-kin-red-ink">{error}</p>
          {/* eslint-disable-next-line kin/no-raw-button -- moved unchanged from RoutinesPage. */}
          <button
            type="button"
            onClick={onRetry}
            className="mt-1 min-h-11 text-body text-kin-blue-ink hover:underline md:min-h-8"
          >
            {tr("routines.retry")}
          </button>
        </div>
      ) : runs.length === 0 ? (
        <p className="mt-2 text-body text-kin-secondary">
          {remote ? tr("routines.historyEmptyRemote") : tr("routines.historyEmpty")}
        </p>
      ) : (
        <ul className="mt-2 max-h-[min(420px,50vh)] space-y-2 overflow-y-auto kin-scroll">
          {runs.map((run) => (
            <RunCard
              key={run.id}
              run={run}
              onMarkRead={onMarkRead}
              tr={tr}
              quiet
              ownRoutine
              device={device}
            />
          ))}
          {/* Inside the scroll box: the click happens at the bottom, and the
              rows it fetches appear just above the button, in view. */}
          {hasMore && !remote && runs.length < ROUTINE_HISTORY_MAX && (
            <li>
              {/* eslint-disable-next-line kin/no-raw-button -- moved unchanged from RoutinesPage. */}
              <button
                type="button"
                disabled={loadingOlder}
                onClick={onLoadOlder}
                className="min-h-11 text-body text-kin-secondary hover:text-kin-text disabled:opacity-50 sm:min-h-8"
              >
                {loadingOlder
                  ? tr("routines.historyLoadingOlder")
                  : tr("routines.historyLoadOlder")}
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

export function RunCard({
  run,
  onMarkRead,
  tr,
  quiet,
  ownRoutine,
  device,
}: {
  run: Task;
  onMarkRead: (id: string) => void;
  tr: Translate;
  quiet?: boolean;
  /** The card already sits under its own routine; the id prefix is noise. */
  ownRoutine?: boolean;
  /** The machine whose task store owns the run, for a remote routine. */
  device?: string;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const title = run.title || run.id.slice(0, 8);
  const href = device
    ? `/machines/${encodeURIComponent(device)}/tasks/${encodeURIComponent(run.id)}`
    : `/tasks/${encodeURIComponent(run.id)}`;
  const openRun = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    const modifier =
      event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
    if (modifier) {
      // Keep Cmd/Ctrl/Shift-click's browser behavior. The click still marks a
      // remote run read because its detail page cannot compensate later.
      if (!event.defaultPrevented && run.routine_unread) onMarkRead(run.id);
      return;
    }
    if (onGuardedLinkClick(event, navigate, location, href) && run.routine_unread) {
      onMarkRead(run.id);
    }
  };
  return (
    <li
      className={[
        "rounded-2xl border px-4 py-3",
        run.routine_unread
          ? "border-kin-blue/40 bg-kin-blue/5"
          : "border-transparent bg-kin-panel/80",
        quiet ? "opacity-90" : "",
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to={href}
              className="truncate text-strong font-medium text-kin-text hover:underline"
              onClick={openRun}
            >
              {title}
            </Link>
            {run.routine_noteworthy && (
              <span className="rounded-full bg-kin-orange/15 px-2 py-0.5 text-caption font-medium text-kin-orange-ink">
                {tr("routines.noteworthy")}
              </span>
            )}
            <span className="text-caption text-kin-muted">{statusLabel(run.status, tr)}</span>
          </div>
          {run.routine_tldr && (
            <p className="mt-1 text-strong text-kin-secondary">{run.routine_tldr}</p>
          )}
          <div className="mt-1 text-caption text-kin-muted">
            {formatWhen(run.finished_at ?? run.created_at)}
            {!ownRoutine && run.routine_id ? ` · ${run.routine_id.slice(0, 8)}` : ""}
          </div>
          <Link
            to={href}
            onClick={openRun}
            className="mt-1 inline-flex min-h-11 items-center text-body text-kin-blue-ink hover:underline md:min-h-0"
          >
            {tr("routines.openConversation")} →
          </Link>
        </div>
        {run.routine_unread && (
          // eslint-disable-next-line kin/no-raw-button -- moved unchanged from RoutinesPage.
          <button
            type="button"
            onClick={() => onMarkRead(run.id)}
            className="shrink-0 text-body text-kin-blue-ink hover:underline"
          >
            {tr("routines.markRead")}
          </button>
        )}
      </div>
    </li>
  );
}
