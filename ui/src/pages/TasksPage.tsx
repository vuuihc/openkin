import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  ApiError,
  connectWS,
  formatCost,
  formatElapsed,
  getToken,
  isTerminal,
  listTasks,
  type Task,
} from "../api/client";
import NewTaskModal from "../components/NewTaskModal";
import StatusBadge from "../components/StatusBadge";

type State =
  | { status: "loading" }
  | { status: "ready"; tasks: Task[] }
  | { status: "error"; message: string };

export default function TasksPage() {
  const [state, setState] = useState<State>({ status: "loading" });
  const [modalOpen, setModalOpen] = useState(false);
  const [now, setNow] = useState(Date.now());

  const upsert = useCallback((task: Task) => {
    setState((prev) => {
      if (prev.status !== "ready") return prev;
      const rest = prev.tasks.filter((t) => t.id !== task.id);
      return { status: "ready", tasks: [task, ...rest].sort((a, b) => b.id.localeCompare(a.id)) };
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!getToken()) {
        if (!cancelled) {
          setState({
            status: "error",
            message: "No auth token. Open the URL printed by `kin serve` (includes ?token=).",
          });
        }
        return;
      }
      try {
        const tasks = await listTasks({ limit: 100 });
        if (!cancelled) setState({ status: "ready", tasks });
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 401) {
          setState({
            status: "error",
            message: "Unauthorized. Re-open with the token from ~/.kin/token.",
          });
          return;
        }
        setState({
          status: "error",
          message: e instanceof Error ? e.message : "Failed to load tasks",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return connectWS((msg) => {
      if (msg.kind === "task_update") upsert(msg.data);
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
          className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-zinc-900 hover:bg-accent-muted"
        >
          New task
        </button>
      </div>

      {state.status === "loading" && (
        <p className="text-sm text-zinc-400" role="status">
          Loading tasks…
        </p>
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
            className="mt-4 rounded-lg border border-surface-border px-3 py-2 text-sm text-zinc-200 hover:bg-surface-raised"
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
                to={`/tasks/${t.id}`}
                className="block rounded-xl border border-surface-border bg-surface-raised px-4 py-3 hover:border-accent/40 transition-colors"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium text-zinc-100 truncate">{t.title}</p>
                    <p className="text-xs text-zinc-500 mt-0.5 truncate">
                      <span className="rounded bg-surface px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
                        {t.agent}
                      </span>
                      <span className="mx-1.5">·</span>
                      <span className="font-mono">{t.cwd}</span>
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
      />
    </div>
  );
}
