import { useEffect, useState } from "react";
import { ApiError, listTasks, type Task, getToken } from "../api/client";

type State =
  | { status: "loading" }
  | { status: "ready"; tasks: Task[] }
  | { status: "error"; message: string };

export default function TasksPage() {
  const [state, setState] = useState<State>({ status: "loading" });

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
        const tasks = await listTasks();
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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-zinc-50">Tasks</h1>
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
            Dispatch will land in a later milestone. The list is live against the daemon.
          </p>
        </div>
      )}

      {state.status === "ready" && state.tasks.length > 0 && (
        <ul className="space-y-2">
          {state.tasks.map((t) => (
            <li
              key={t.id}
              className="rounded-xl border border-surface-border bg-surface-raised px-4 py-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-medium text-zinc-100">{t.title}</p>
                  <p className="text-xs text-zinc-500 mt-0.5">
                    {t.agent} · {t.status}
                  </p>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
