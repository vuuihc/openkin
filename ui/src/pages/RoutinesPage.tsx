import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ApiError,
  deleteRoutine,
  getToken,
  isTerminal,
  listRoutineRuns,
  listRoutines,
  markAllRoutineRunsRead,
  markRoutineRunRead,
  patchRoutine,
  runRoutineNow,
  type Routine,
  type Task,
} from "../api/client";
import { SlowConnectHint } from "../components/Skeleton";
import { useSlowHint } from "../hooks/useSlowHint";
import { useT } from "../i18n/react";
import { subscribeWS, useAppStore } from "../store/appStore";

function formatWhen(ms?: number | null): string {
  if (!ms) return "—";
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return "—";
  }
}

function formatInterval(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h`;
  return `${Math.round(secs / 86400)}d`;
}

/**
 * Global Routines inbox — reverse-chron runs feed + per-routine controls.
 * Read surface of ADR 0011 (write lives on ProjectDetail).
 */
export default function RoutinesPage() {
  const tr = useT();
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [runs, setRuns] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showSilent, setShowSilent] = useState(false);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const pushToast = useAppStore((s) => s.pushToast);
  const reconnectGen = useAppStore((s) => s.reconnectGen);
  const slow = useSlowHint(loading);

  const load = useCallback(async () => {
    if (!getToken()) return;
    try {
      const [rs, feed] = await Promise.all([
        listRoutines({ limit: 100 }) as Promise<Routine[]>,
        listRoutineRuns(80),
      ]);
      setRoutines(Array.isArray(rs) ? rs : []);
      setRuns(feed);
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setError(e instanceof Error ? e.message : tr("routines.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [tr]);

  useEffect(() => {
    void load();
  }, [load, reconnectGen]);

  useEffect(() => {
    return subscribeWS((msg) => {
      if (msg.kind !== "task_update") return;
      const t = msg.data as Task;
      if (!t.routine_id) return;
      setRuns((prev) => {
        const idx = prev.findIndex((x) => x.id === t.id);
        if (idx >= 0) {
          const next = prev.slice();
          next[idx] = { ...next[idx], ...t };
          return next;
        }
        return [t, ...prev].slice(0, 80);
      });
    });
  }, []);

  const noteworthy = useMemo(
    () => runs.filter((r) => r.routine_noteworthy || !isTerminal(r.status)),
    [runs],
  );
  const silent = useMemo(
    () => runs.filter((r) => isTerminal(r.status) && !r.routine_noteworthy),
    [runs],
  );

  const onToggle = async (r: Routine) => {
    setBusy((b) => ({ ...b, [r.id]: true }));
    try {
      const updated = await patchRoutine(r.id, { enabled: !r.enabled });
      setRoutines((list) => list.map((x) => (x.id === r.id ? updated : x)));
    } catch (e) {
      pushToast(e instanceof Error ? e.message : tr("routines.actionFailed"), "error");
    } finally {
      setBusy((b) => ({ ...b, [r.id]: false }));
    }
  };

  const onDelete = async (r: Routine) => {
    if (!window.confirm(tr("routines.deleteConfirm", { title: r.title || r.id }))) return;
    setBusy((b) => ({ ...b, [r.id]: true }));
    try {
      await deleteRoutine(r.id);
      setRoutines((list) => list.filter((x) => x.id !== r.id));
    } catch (e) {
      pushToast(e instanceof Error ? e.message : tr("routines.actionFailed"), "error");
    } finally {
      setBusy((b) => ({ ...b, [r.id]: false }));
    }
  };

  const onRunNow = async (r: Routine) => {
    setBusy((b) => ({ ...b, [r.id]: true }));
    try {
      const t = await runRoutineNow(r.id);
      setRuns((prev) => [t, ...prev].slice(0, 80));
      pushToast(tr("routines.runStarted"), "info");
    } catch (e) {
      pushToast(e instanceof Error ? e.message : tr("routines.actionFailed"), "error");
    } finally {
      setBusy((b) => ({ ...b, [r.id]: false }));
    }
  };

  const onMarkRead = async (taskId: string) => {
    try {
      const t = await markRoutineRunRead(taskId);
      setRuns((prev) => prev.map((x) => (x.id === taskId ? { ...x, ...t } : x)));
    } catch {
      /* best-effort */
    }
  };

  const onMarkAllRead = async () => {
    try {
      await markAllRoutineRunsRead();
      setRuns((prev) => prev.map((x) => ({ ...x, routine_unread: false })));
    } catch (e) {
      pushToast(e instanceof Error ? e.message : tr("routines.actionFailed"), "error");
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 md:px-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight text-kin-text">
            {tr("routines.title")}
          </h1>
          <p className="mt-1 text-[13px] text-kin-secondary">{tr("routines.subtitle")}</p>
        </div>
        <button
          type="button"
          onClick={() => void onMarkAllRead()}
          className="shrink-0 rounded-lg border border-[var(--kin-hairline)] px-3 py-1.5 text-[12.5px] text-kin-secondary hover:bg-[var(--kin-fill)]"
        >
          {tr("routines.markAllRead")}
        </button>
      </div>

      {loading && (
        <div className="mt-8">
          <SlowConnectHint show={slow} />
          <div className="mt-4 h-24 animate-pulse rounded-2xl bg-[var(--kin-fill)]" />
        </div>
      )}

      {!loading && error && (
        <div className="mt-6 rounded-xl border border-kin-red/40 bg-[rgba(255,69,58,.08)] px-4 py-3 text-sm text-[#ff8a80]">
          {error}
        </div>
      )}

      {!loading && !error && (
        <>
          <section className="mt-8">
            <div className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-kin-muted">
              {tr("routines.feedSection")}
            </div>
            {noteworthy.length === 0 && silent.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-[var(--kin-hairline-strong)] px-6 py-12 text-center">
                <p className="text-base font-medium text-kin-text">{tr("routines.emptyFeed")}</p>
                <p className="mt-1 text-sm text-kin-secondary">{tr("routines.emptyFeedHint")}</p>
              </div>
            ) : (
              <ul className="space-y-3">
                {noteworthy.map((run) => (
                  <RunCard key={run.id} run={run} onMarkRead={onMarkRead} tr={tr} />
                ))}
              </ul>
            )}

            {silent.length > 0 && (
              <div className="mt-4">
                <button
                  type="button"
                  className="text-[12.5px] text-kin-secondary hover:text-kin-text"
                  onClick={() => setShowSilent((v) => !v)}
                >
                  {showSilent
                    ? tr("routines.hideSilent", { count: silent.length })
                    : tr("routines.showSilent", { count: silent.length })}
                </button>
                {showSilent && (
                  <ul className="mt-3 space-y-2 opacity-80">
                    {silent.map((run) => (
                      <RunCard key={run.id} run={run} onMarkRead={onMarkRead} tr={tr} quiet />
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>

          <section className="mt-10">
            <div className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-kin-muted">
              {tr("routines.listSection")}
            </div>
            {routines.length === 0 ? (
              <p className="text-[13px] text-kin-secondary">{tr("routines.emptyList")}</p>
            ) : (
              <ul className="space-y-2.5">
                {routines.map((r) => (
                  <li
                    key={r.id}
                    className="rounded-2xl border border-[var(--kin-hairline)] bg-kin-panel/80 px-4 py-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-[14px] font-medium text-kin-text">
                            {r.title || r.prompt.slice(0, 48)}
                          </span>
                          <span
                            className={
                              r.enabled
                                ? "rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10.5px] font-medium text-emerald-400"
                                : "rounded-full bg-[var(--kin-fill)] px-2 py-0.5 text-[10.5px] text-kin-muted"
                            }
                          >
                            {r.enabled ? tr("routines.enabled") : tr("routines.paused")}
                          </span>
                        </div>
                        <div className="mt-1 truncate text-[12px] text-kin-secondary">
                          {r.agent} · {formatInterval(r.interval_secs)} · {r.cwd}
                        </div>
                        <div className="mt-0.5 text-[11.5px] text-kin-muted">
                          {tr("routines.nextDue")}: {formatWhen(r.next_due_at)}
                          {r.consec_failures > 0
                            ? ` · ${tr("routines.failures", { n: r.consec_failures })}`
                            : ""}
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                        <button
                          type="button"
                          disabled={!!busy[r.id]}
                          onClick={() => void onRunNow(r)}
                          className="rounded-lg bg-kin-accent px-2.5 py-1 text-[12px] font-medium text-white disabled:opacity-50"
                        >
                          {tr("routines.runNow")}
                        </button>
                        <button
                          type="button"
                          disabled={!!busy[r.id]}
                          onClick={() => void onToggle(r)}
                          className="rounded-lg border border-[var(--kin-hairline)] px-2.5 py-1 text-[12px] text-kin-secondary disabled:opacity-50"
                        >
                          {r.enabled ? tr("routines.pause") : tr("routines.resume")}
                        </button>
                        <button
                          type="button"
                          disabled={!!busy[r.id]}
                          onClick={() => void onDelete(r)}
                          className="rounded-lg px-2.5 py-1 text-[12px] text-kin-red/90 disabled:opacity-50"
                        >
                          {tr("routines.delete")}
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function RunCard({
  run,
  onMarkRead,
  tr,
  quiet,
}: {
  run: Task;
  onMarkRead: (id: string) => void;
  tr: (key: string, vars?: Record<string, string | number>) => string;
  quiet?: boolean;
}) {
  return (
    <li
      className={[
        "rounded-2xl border px-4 py-3",
        run.routine_unread
          ? "border-kin-blue/40 bg-kin-blue/5"
          : "border-[var(--kin-hairline)] bg-kin-panel/80",
        quiet ? "opacity-90" : "",
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to={`/tasks/${run.id}`}
              className="truncate text-[14px] font-medium text-kin-text hover:underline"
              onClick={() => {
                if (run.routine_unread) onMarkRead(run.id);
              }}
            >
              {run.title || run.id.slice(0, 8)}
            </Link>
            {run.routine_noteworthy && (
              <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10.5px] font-medium text-amber-300">
                {tr("routines.noteworthy")}
              </span>
            )}
            <span className="text-[11px] text-kin-muted">{run.status}</span>
          </div>
          {run.routine_tldr && (
            <p className="mt-1 text-[13px] text-kin-secondary">{run.routine_tldr}</p>
          )}
          <div className="mt-1 text-[11.5px] text-kin-muted">
            {formatWhen(run.finished_at ?? run.created_at)}
            {run.routine_id ? ` · ${run.routine_id.slice(0, 8)}` : ""}
          </div>
        </div>
        {run.routine_unread && (
          <button
            type="button"
            onClick={() => onMarkRead(run.id)}
            className="shrink-0 text-[12px] text-kin-blue hover:underline"
          >
            {tr("routines.markRead")}
          </button>
        )}
      </div>
    </li>
  );
}
