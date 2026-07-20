import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ApiError,
  formatCost,
  formatElapsed,
  getToken,
  isTerminal,
  deleteTask,
  listTasks,
  type Task,
} from "../api/client";
import { SlowConnectHint, TaskListSkeleton } from "../components/Skeleton";
import { useSlowHint } from "../hooks/useSlowHint";
import { t } from "../i18n";
import { useT } from "../i18n/react";
import { DRAFT_PATH } from "../lib/draftChat";
import { subscribeWS, useAppStore } from "../store/appStore";

type Filter = "all" | "running" | "done";

/**
 * Tasks overview (design 2e) — secondary list for “see everything”.
 */
export default function TasksPage() {
  const navigate = useNavigate();
  const tr = useT();
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [now, setNow] = useState(Date.now());
  const reconnectGen = useAppStore((s) => s.reconnectGen);
  const slow = useSlowHint(tasks === null && !error);
  const pushToast = useAppStore((s) => s.pushToast);

  const load = useCallback(async () => {
    if (!getToken()) return;
    try {
      const list = await listTasks({ limit: 100 });
      setTasks(list);
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setError(e instanceof Error ? e.message : tr("tasks.loadFailed"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (reconnectGen === 0) return;
    void load();
  }, [reconnectGen, load]);

  useEffect(() => {
    return subscribeWS((msg) => {
      if (msg.kind === "task_deleted") {
        const data = msg.data as { id?: string };
        if (!data?.id) return;
        setTasks((prev) => (prev ? prev.filter((t) => t.id !== data.id) : prev));
        return;
      }
      if (msg.kind !== "task_update") return;
      const task = msg.data as Task;
      setTasks((prev) => {
        if (!prev) return [task];
        const rest = prev.filter((t) => t.id !== task.id);
        return [task, ...rest].sort((a, b) => b.created_at - a.created_at);
      });
    });
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const filtered = useMemo(() => {
    const list = tasks ?? [];
    if (filter === "running") return list.filter((t) => !isTerminal(t.status));
    if (filter === "done") return list.filter((t) => isTerminal(t.status));
    return list;
  }, [tasks, filter]);

  const todayCost = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const ms = start.getTime();
    return (tasks ?? [])
      .filter((t) => t.created_at >= ms)
      .reduce((s, t) => s + (t.cost_usd ?? 0), 0);
  }, [tasks]);

  async function handleDelete(task: Task) {
    const title = (task.title || task.prompt || task.id).trim();
    const ok = window.confirm(
      tr("tasks.deleteConfirm") + (title ? `\n\n${title}` : ""),
    );
    if (!ok) return;
    try {
      await deleteTask(task.id);
      setTasks((prev) => (prev ? prev.filter((t) => t.id !== task.id) : prev));
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
            <h1 className="text-[22px] font-semibold tracking-tight">{tr("tasks.title")}</h1>
            <p className="text-[13px] text-kin-tertiary mt-0.5">
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
                "px-3 py-1.5 rounded-lg text-[13px] font-medium min-h-[36px]",
                filter === k
                  ? "bg-kin-blue text-white"
                  : "text-kin-secondary hover:bg-[var(--kin-fill)]",
              ].join(" ")}
            >
              {label}
            </button>
          ))}
        </div>

        {tasks === null && !error && (
          <div className="mt-6 space-y-3">
            <SlowConnectHint show={slow} />
            <TaskListSkeleton />
          </div>
        )}

        {error && (
          <div
            className="mt-6 rounded-xl border border-kin-red/40 bg-[rgba(255,69,58,.08)] px-4 py-3 text-sm text-[#ff8a80]"
            role="alert"
          >
            {error}
          </div>
        )}

        {tasks && filtered.length === 0 && (
          <p className="mt-10 text-center text-sm text-kin-muted">{tr("tasks.empty")}</p>
        )}

        {tasks && filtered.length > 0 && (
          <div className="mt-5 overflow-x-auto rounded-xl border border-[var(--kin-hairline)]">
            <table className="w-full text-left text-[13px]">
              <thead className="text-[11px] uppercase tracking-wide text-kin-muted border-b border-[var(--kin-hairline)]">
                <tr>
                  <th className="px-3 py-2.5 font-semibold">{tr("tasks.colTask")}</th>
                  <th className="px-3 py-2.5 font-semibold hidden sm:table-cell">{tr("tasks.colAgent")}</th>
                  <th className="px-3 py-2.5 font-semibold">{tr("tasks.colStatus")}</th>
                  <th className="px-3 py-2.5 font-semibold hidden md:table-cell">{tr("tasks.colElapsed")}</th>
                  <th className="px-3 py-2.5 font-semibold text-right">{tr("tasks.colCost")}</th>
                  <th className="px-3 py-2.5 font-semibold text-right w-[1%]">
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
                    <td className="px-3 py-3">
                      <Link
                        to={`/tasks/${t.id}`}
                        className="font-medium text-kin-text hover:text-kin-blue"
                      >
                        {t.title || t.prompt}
                      </Link>
                    </td>
                    <td className="px-3 py-3 text-kin-secondary hidden sm:table-cell">
                      {t.agent}
                    </td>
                    <td className="px-3 py-3">
                      <StatusChip status={t.status} />
                    </td>
                    <td className="px-3 py-3 text-kin-secondary tabular-nums hidden md:table-cell">
                      {formatElapsed(t, now)}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums text-kin-secondary">
                      {formatCost(t.cost_usd)}
                    </td>
                    <td className="px-3 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => void handleDelete(t)}
                        className="text-[12px] text-kin-muted hover:text-[#ff8a80]"
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
      ? "text-kin-orange bg-kin-orange-soft"
      : status === "running" || status === "queued"
        ? "text-kin-blue bg-kin-blue-soft"
        : status === "succeeded"
          ? "text-kin-green bg-[rgba(48,209,88,.12)]"
          : "text-kin-secondary bg-[var(--kin-fill)]";
  const label =
    status === "waiting_approval"
      ? t("tasks.needsApproval")
      : status === "succeeded"
        ? t("tasks.statusDone")
        : status;
  return (
    <span className={`inline-flex px-2 py-0.5 rounded text-[11.5px] font-semibold ${color}`}>
      {label}
    </span>
  );
}
