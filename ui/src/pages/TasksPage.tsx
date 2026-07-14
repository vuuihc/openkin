import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  ApiError,
  formatCost,
  formatElapsed,
  getToken,
  isTerminal,
  listTasks,
  type Task,
} from "../api/client";
import NewTaskModal from "../components/NewTaskModal";
import { SlowConnectHint, TaskListSkeleton } from "../components/Skeleton";
import StatusBadge from "../components/StatusBadge";
import Truncated from "../components/Truncated";
import { useSlowHint } from "../hooks/useSlowHint";
import { subscribeWS, useAppStore } from "../store/appStore";

type State =
  | { status: "loading" }
  | { status: "ready"; tasks: Task[] }
  | { status: "error"; message: string };

export default function TasksPage() {
  const [state, setState] = useState<State>({ status: "loading" });
  const [modalOpen, setModalOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const reconnectGen = useAppStore((s) => s.reconnectGen);
  const slow = useSlowHint(state.status === "loading");

  const upsert = useCallback((task: Task) => {
    setState((prev) => {
      if (prev.status !== "ready") {
        return { status: "ready", tasks: [task] };
      }
      // Replace optimistic temp ids (opt_*) when server task matches by content heuristics,
      // or when ids match.
      let rest = prev.tasks.filter((t) => t.id !== task.id);
      if (!task.id.startsWith("opt_")) {
        rest = rest.filter(
          (t) =>
            !(
              t.id.startsWith("opt_") &&
              t.prompt === task.prompt &&
              t.cwd === task.cwd &&
              t.agent === task.agent
            ),
        );
      }
      return {
        status: "ready",
        tasks: [task, ...rest].sort((a, b) => b.id.localeCompare(a.id)),
      };
    });
  }, []);

  const load = useCallback(async () => {
    if (!getToken()) return;
    try {
      const tasks = await listTasks({ limit: 100 });
      setState({ status: "ready", tasks });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        // Global connect screen handles 401.
        return;
      }
      setState({
        status: "error",
        message: e instanceof Error ? e.message : "Failed to load tasks",
      });
    }
  }, []);

  useEffect(() => {
    setState({ status: "loading" });
    void load();
  }, [load]);

  // Self-heal after WS reconnect without manual refresh.
  useEffect(() => {
    if (reconnectGen === 0) return;
    void load();
  }, [reconnectGen, load]);

  useEffect(() => {
    return subscribeWS((msg) => {
      if (msg.kind === "task_update") upsert(msg.data as Task);
    });
  }, [upsert]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-zinc-50">Tasks</h1>
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          className="min-h-[44px] rounded-lg bg-accent px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-accent-muted"
        >
          New task
        </button>
      </div>

      {state.status === "loading" && (
        <div className="space-y-3">
          <SlowConnectHint show={slow} />
          <TaskListSkeleton />
        </div>
      )}

      {state.status === "error" && (
        <div
          className="rounded-xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-200"
          role="alert"
        >
          {state.message}
        </div>
      )}

      {state.status === "ready" && state.tasks.length === 0 && (
        <div className="rounded-xl border border-dashed border-surface-border bg-surface-raised/40 px-6 py-16 text-center">
          <p className="text-base font-medium text-zinc-200">No tasks yet</p>
          <p className="mt-1 text-sm text-zinc-500">
            Dispatch a Claude Code task to stream its transcript here.
          </p>
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            className="mt-4 min-h-[44px] rounded-lg border border-surface-border px-4 py-2 text-sm text-zinc-200 hover:bg-surface-raised"
          >
            New task
          </button>
        </div>
      )}

      {state.status === "ready" && state.tasks.length > 0 && (
        <ul className="space-y-2">
          {state.tasks.map((t) => (
            <li key={t.id}>
              <Link
                to={t.id.startsWith("opt_") ? "#" : `/tasks/${t.id}`}
                onClick={(e) => {
                  if (t.id.startsWith("opt_")) e.preventDefault();
                }}
                className="block rounded-xl border border-surface-border bg-surface-raised px-4 py-3 hover:border-accent/40 transition-colors min-h-[44px]"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-zinc-100 truncate" title={t.title}>
                      {t.title}
                    </p>
                    <p className="text-xs text-zinc-500 mt-0.5 flex items-center gap-1.5 min-w-0">
                      <span className="rounded bg-surface px-1.5 py-0.5 font-mono text-[10px] text-zinc-400 shrink-0">
                        {t.agent}
                      </span>
                      <span className="shrink-0">·</span>
                      <Truncated text={t.cwd} className="font-mono" />
                    </p>
                  </div>
                  <StatusBadge status={t.status} />
                </div>
                <div className="mt-2 flex flex-wrap gap-3 text-xs text-zinc-500">
                  <span>{formatElapsed(t, now)}</span>
                  <span>{formatCost(t.cost_usd)}</span>
                  {!isTerminal(t.status) && t.status === "running" && (
                    <span className="text-sky-400">live</span>
                  )}
                  {t.id.startsWith("opt_") && (
                    <span className="text-zinc-400">dispatching…</span>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <NewTaskModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={upsert}
        onOptimistic={(task) => upsert(task)}
        onOptimisticFail={(tempId) => {
          setState((prev) => {
            if (prev.status !== "ready") return prev;
            return {
              status: "ready",
              tasks: prev.tasks.filter((t) => t.id !== tempId),
            };
          });
        }}
      />
    </div>
  );
}
