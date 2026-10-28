import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { formatCost, formatElapsed, isTerminal, deleteTask, type Task } from "../api/client";
import { liveResources } from "../api/liveResources";
import { useTaskList } from "../api/useLiveResources";
import { SlowConnectHint, TaskTableSkeleton } from "../components/Skeleton";
import { useSlowHint } from "../hooks/useSlowHint";
import { t } from "../i18n";
import { useT } from "../i18n/react";
import { DRAFT_PATH } from "../lib/draftChat";
import { startOfDay } from "../lib/relativeTime";
import { useAppStore } from "../store/appStore";
import { displayUserPrompt } from "../lib/attachments";

type Filter = "all" | "running" | "done";

/**
 * Tasks overview (design 2e) — secondary list for “see everything”.
 */
export default function TasksPage() {
  const navigate = useNavigate();
  const tr = useT();
  const resource = useTaskList({ limit: 100 });
  const tasks = resource.data;
  const error =
    resource.error instanceof Error
      ? resource.error.message
      : resource.error
        ? tr("tasks.loadFailed")
        : null;
  const [filter, setFilter] = useState<Filter>("all");
  const [now, setNow] = useState(Date.now());
  const slow = useSlowHint(!resource.loaded && resource.loading && !error);
  const pushToast = useAppStore((s) => s.pushToast);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const filtered = useMemo(() => {
    if (filter === "running") return tasks.filter((t) => !isTerminal(t.status));
    if (filter === "done") return tasks.filter((t) => isTerminal(t.status));
    return tasks;
  }, [tasks, filter]);

  const todayCost = useMemo(() => {
    const ms = startOfDay(Date.now());
    return tasks.filter((t) => t.created_at >= ms).reduce((s, t) => s + (t.cost_usd ?? 0), 0);
  }, [tasks]);

  async function handleDelete(task: Task) {
    const title = (task.title || displayUserPrompt(task.prompt || "") || task.id).trim();
    const ok = window.confirm(tr("tasks.deleteConfirm") + (title ? `\n\n${title}` : ""));
    if (!ok) return;
    try {
      await deleteTask(task.id);
      liveResources.applyMessage({ kind: "task_deleted", data: { id: task.id } });
      pushToast(tr("task.deleted"), "info");
    } catch (e) {
      pushToast(e instanceof Error ? e.message : tr("task.deleteFailed"), "error");
    }
  }

  return (
    <div className="flex-1 overflow-y-auto kin-scroll">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="hidden text-hero font-bold tracking-tight md:block">
              {tr("tasks.title")}
            </h1>
            <p className="text-strong text-kin-muted mt-0.5">
              {tr("tasks.today", { cost: formatCost(todayCost) })}
            </p>
          </div>
          <button type="button" onClick={() => navigate(DRAFT_PATH)} className="kin-btn-primary">
            {tr("tasks.newChat")}
          </button>
        </div>

        <div className="mt-5 flex gap-1.5">
          {(
            [
              ["all", tr("tasks.all")],
              ["running", tr("tasks.running")],
              ["done", tr("tasks.done")],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setFilter(k)}
              className={[
                "inline-flex items-center px-3 py-1.5 rounded-lg text-strong font-medium min-h-11 sm:min-h-9",
                filter === k
                  ? "bg-kin-blue text-kin-on-brand"
                  : "text-kin-secondary hover:bg-[var(--kin-fill)]",
              ].join(" ")}
            >
              {label}
            </button>
          ))}
        </div>

        {!resource.loaded && !error && (
          <div className="mt-6 space-y-3">
            <SlowConnectHint show={slow} />
            <TaskTableSkeleton />
          </div>
        )}

        {error && (
          <div
            className="mt-6 rounded-xl border border-kin-red/40 bg-kin-red/10 px-4 py-3 text-strong leading-5 text-kin-red-ink"
            role="alert"
          >
            {error}
          </div>
        )}

        {resource.loaded && filtered.length === 0 && (
          <p className="mt-10 text-center text-strong leading-5 text-kin-muted">
            {tr("tasks.empty")}
          </p>
        )}

        {resource.loaded && filtered.length > 0 && (
          <div className="mt-5 overflow-x-auto rounded-xl border border-[var(--kin-hairline)]">
            <table className="w-full text-left text-strong">
              {/* A phone does not need a header row for a two-column list: the
                  status column explains itself, and the header cost 38px at the
                  top of every visit. */}
              <thead className="text-caption uppercase tracking-label text-kin-muted border-b border-[var(--kin-hairline)] max-md:hidden">
                <tr>
                  <th className="px-3 py-2.5 font-semibold">{tr("tasks.colTask")}</th>
                  <th className="px-3 py-2.5 font-semibold hidden sm:table-cell">
                    {tr("tasks.colAgent")}
                  </th>
                  <th className="px-3 py-2.5 font-semibold max-md:w-[1%] max-md:whitespace-nowrap">
                    {tr("tasks.colStatus")}
                  </th>
                  <th className="px-3 py-2.5 font-semibold hidden md:table-cell">
                    {tr("tasks.colElapsed")}
                  </th>
                  <th className="px-3 py-2.5 font-semibold text-right hidden sm:table-cell">
                    {tr("tasks.colCost")}
                  </th>
                  <th className="px-3 py-2.5 font-semibold text-right w-[1%] whitespace-nowrap hidden sm:table-cell">
                    <span className="sr-only">{tr("tasks.delete")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((t) => (
                  <tr
                    key={t.id}
                    className="border-b border-[var(--kin-hairline)] last:border-0 hover:bg-[var(--kin-fill)]"
                  >
                    {/* The padding lives on the link, not the cell: a title is
                        one line of text, and a text-height link is a 19px tap
                        target inside a 48px row — the row is what a thumb aims
                        at, so the link has to be the row's whole first cell.

                        `anywhere` rather than `break-words`: a title that
                        quotes an id or a path is one 26-character token, and
                        `break-word` does not shrink the cell's intrinsic width,
                        so the status column was pushed 23px off a 390 screen
                        by `01KYE2WB…` alone. `anywhere` is the value that lets
                        the table give way. */}
                    <td className="p-0">
                      <Link
                        to={`/tasks/${t.id}`}
                        className="block px-3 py-3 max-md:py-3.5 font-medium max-md:text-subtitle text-kin-text hover:text-kin-blue-ink [overflow-wrap:anywhere]"
                      >
                        {t.title || displayUserPrompt(t.prompt || "")}
                      </Link>
                    </td>
                    <td className="px-3 py-3 text-kin-secondary whitespace-nowrap hidden sm:table-cell">
                      {t.agent}
                    </td>
                    <td className="px-3 py-3 max-md:w-[1%] max-md:whitespace-nowrap max-md:text-right">
                      <StatusChip status={t.status} />
                    </td>
                    <td className="px-3 py-3 text-kin-secondary tabular-nums whitespace-nowrap hidden md:table-cell">
                      {formatElapsed(t, now)}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums text-kin-secondary hidden sm:table-cell">
                      {formatCost(t.cost_usd)}
                    </td>
                    <td className="px-3 py-3 text-right whitespace-nowrap hidden sm:table-cell">
                      <button
                        type="button"
                        onClick={() => void handleDelete(t)}
                        className="text-body text-kin-muted hover:text-kin-red-ink"
                      >
                        {tr("tasks.delete")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  const color =
    status === "waiting_approval"
      ? "text-kin-orange-ink bg-kin-orange/15"
      : status === "failed"
        ? "text-kin-red-ink bg-kin-red/10"
        : status === "running" || status === "queued"
          ? "text-kin-blue-ink bg-kin-blue/15"
          : status === "succeeded"
            ? "text-kin-green-ink bg-kin-green/10"
            : "text-kin-secondary bg-[var(--kin-fill)]";
  // A status is part of the API's vocabulary, not the reader's. Every value the
  // daemon can write has a label here; an unknown one still shows as itself,
  // which is better than a blank chip when a newer Hub adds one.
  const label =
    {
      waiting_approval: t("tasks.needsApproval"),
      queued: t("tasks.statusQueued"),
      running: t("tasks.statusRunning"),
      succeeded: t("tasks.statusDone"),
      failed: t("tasks.statusFailed"),
      canceled: t("tasks.statusCanceled"),
    }[status] ?? status;
  return (
    <span
      className={`inline-flex whitespace-nowrap px-2 py-0.5 rounded text-caption font-semibold ${color}`}
    >
      {label}
    </span>
  );
}
