import { useState } from "react";
import { useT } from "../../i18n/react";
import ToolStepRow from "../chat/ToolStepRow";
import { WORKER_STATUS_UNPLANNED, type WorkerRow } from "./workerActivity";

function statusKey(status: string): string {
  switch (status) {
    case "planned":
      return "task.workerStatusPlanned";
    case "running":
      return "task.workerStatusRunning";
    case "succeeded":
      return "task.workerStatusSucceeded";
    case "failed":
      return "task.workerStatusFailed";
    case "canceled":
      return "task.workerStatusCanceled";
    case WORKER_STATUS_UNPLANNED:
      return "task.workerStatusUnplanned";
    default:
      return "task.workerStatusUnknown";
  }
}

/**
 * The plan, with what each worker is doing under it.
 *
 * The rows come from `workerActivity`, which is where the two fact sources meet;
 * this file only draws them. One row of the plan is open at a time, and the one
 * that opens on its own is whichever is still working — a panel whose whole
 * point is answering "what is happening now" cannot put that behind a tap. A
 * settled row folds to its one line, so a finished plan stays the height it
 * always was.
 *
 * The width is the chat column's (`max-w-conversation`, 720px) with the chat
 * column's own padding, because that is what this is: the first thing inside the
 * transcript's scroll area, not a page-level panel. It used to carry a
 * `max-w-[760px]` of its own, which put its border 20px outside every bubble
 * above and below it.
 */
export default function WorkerTimeline({
  rows,
  onOpenPath,
}: {
  rows: WorkerRow[];
  onOpenPath?: (path: string) => void;
}) {
  const tr = useT();
  // undefined = the reader has not touched the list, so the live row shows;
  // null = every row folded shut on purpose; a key = that row is pinned open.
  const [pinned, setPinned] = useState<string | null | undefined>(undefined);
  const [openStep, setOpenStep] = useState<string | null>(null);
  if (rows.length === 0) return null;

  const live = rows.find(
    (row) => row.status === "running" || row.status === WORKER_STATUS_UNPLANNED,
  );
  const liveKey = live ? `${live.executionId}-${live.stepIndex}` : null;
  const activeKey = pinned === undefined ? liveKey : pinned;

  return (
    <section
      aria-label={tr("task.workerTimeline")}
      className="mx-auto mb-5 w-full max-w-conversation px-4 sm:px-7"
    >
      <div className="rounded-lg border border-[var(--kin-hairline)] bg-kin-fill px-3 py-3">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-body font-semibold text-[var(--kin-text)]">
            {tr("task.workerTimeline")}
          </h2>
          <span className="text-caption text-kin-muted">
            {tr("task.workerStepCount", { n: rows.length })}
          </span>
        </div>
        <ol className="grid gap-1.5">
          {rows.map((row) => {
            const key = `${row.executionId}-${row.stepIndex}`;
            const expanded = activeKey === key;
            const hidden = Math.max(0, row.total - row.activity.length);
            return (
              <li key={key} className="rounded-md px-2 py-1.5 hover:bg-kin-fill">
                <button
                  type="button"
                  onClick={() => setPinned(expanded ? null : key)}
                  aria-expanded={expanded}
                  className="grid w-full grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-2 text-left text-body"
                >
                  <span className="text-center font-mono text-caption text-kin-muted">
                    {row.stepIndex + 1}
                  </span>
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-medium text-[var(--kin-text)]">
                        {row.agent || tr("task.workerUnnamed")}
                      </span>
                      {row.access && (
                        <span className="shrink-0 text-micro uppercase tracking-label text-kin-muted">
                          {row.access === "write"
                            ? tr("task.workerAccessWrite")
                            : tr("task.workerAccessRead")}
                        </span>
                      )}
                    </div>
                    <div className="truncate text-caption text-kin-muted">
                      {row.role ?? tr("task.workerUnplanned")}
                      {row.resultSummary ? ` · ${row.resultSummary}` : ""}
                    </div>
                  </div>
                  <span className="flex shrink-0 items-center gap-2 text-caption text-kin-muted">
                    {row.total > 0 && tr("task.workerActivity", { n: row.total })}
                    <span className="tabular-nums">{tr(statusKey(row.status))}</span>
                  </span>
                </button>

                {expanded && (
                  <div className="mt-1 divide-y divide-[var(--kin-hairline)] border-t border-[var(--kin-hairline)]">
                    {row.activity.map((tool, idx) => (
                      <ToolStepRow
                        key={tool.key}
                        tool={tool}
                        index={idx + 1}
                        open={openStep === tool.key}
                        onToggle={() => setOpenStep((cur) => (cur === tool.key ? null : tool.key))}
                        onOpenPath={onOpenPath}
                      />
                    ))}
                    {hidden > 0 && (
                      <p className="px-3 py-1.5 text-caption text-kin-muted">
                        {tr("task.workerActivityMore", { n: hidden })}
                      </p>
                    )}
                    {row.error && (
                      <p className="px-3 py-1.5 text-caption text-kin-red-ink">{row.error}</p>
                    )}
                    {row.total === 0 && !row.error && (
                      <p className="px-3 py-1.5 text-caption text-kin-muted">
                        {tr("task.workerNoActivity")}
                      </p>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
