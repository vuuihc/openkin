import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ApiError,
  createRoutine,
  deleteRoutine,
  getToken,
  isTerminal,
  listAgents,
  listRoutineRuns,
  listRoutines,
  markAllRoutineRunsRead,
  markRoutineRunRead,
  patchRoutine,
  runRoutineNow,
  type AgentInfo,
  type Routine,
  type Task,
} from "../api/client";
import CwdPicker from "../components/chat/CwdPicker";
import PermissionModePicker from "../components/chat/PermissionModePicker";
import RoutineScheduleFields, {
  defaultNextRunLocal,
  parseLocalDateTime,
} from "../components/routine/RoutineScheduleFields";
import { SlowConnectHint } from "../components/Skeleton";
import { useSlowHint } from "../hooks/useSlowHint";
import { useT } from "../i18n/react";
import {
  getDraftPermissionMode,
  type PermissionMode,
} from "../lib/permissionMode";
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

function statusLabel(
  status: string,
  tr: (key: string, vars?: Record<string, string | number>) => string,
): string {
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
 * Global Routines inbox — create + reverse-chron runs feed + controls.
 * Create reuses New-chat controls (cwd / permission / schedule).
 */
export default function RoutinesPage() {
  const tr = useT();
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [runs, setRuns] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showSilent, setShowSilent] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const pushToast = useAppStore((s) => s.pushToast);
  const reconnectGen = useAppStore((s) => s.reconnectGen);
  const slow = useSlowHint(loading);

  // Create form (mirrors New chat footer controls)
  const [cwd, setCwd] = useState("");
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(() =>
    getDraftPermissionMode(),
  );
  const [intervalSecs, setIntervalSecs] = useState(86400);
  const [nextRunLocal, setNextRunLocal] = useState(() => defaultNextRunLocal());
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agentId, setAgentId] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    if (!getToken()) return;
    try {
      const [rs, feed, agentList] = await Promise.all([
        listRoutines({ limit: 100 }) as Promise<Routine[]>,
        listRoutineRuns(80),
        listAgents().catch(() => [] as AgentInfo[]),
      ]);
      setRoutines(Array.isArray(rs) ? rs : []);
      setRuns(feed);
      setAgents(agentList);
      setAgentId((cur) => {
        if (cur) return cur;
        const available = agentList.filter((a) => a.available);
        const def = available.find((a) => a.default) ?? available[0];
        return def?.id ?? "";
      });
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

  const availableAgents = useMemo(
    () => agents.filter((a) => a.available),
    [agents],
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
      // Explicit false: API used to omit false bools via omitempty.
      setRuns((prev) =>
        prev.map((x) =>
          x.id === taskId ? { ...x, ...t, routine_unread: false } : x,
        ),
      );
      window.dispatchEvent(new Event("kin:routine-unread-changed"));
    } catch {
      /* best-effort */
    }
  };

  const onMarkAllRead = async () => {
    try {
      await markAllRoutineRunsRead();
      setRuns((prev) => prev.map((x) => ({ ...x, routine_unread: false })));
      // Nudge App badge (mark-all has no per-task WS storm).
      window.dispatchEvent(new Event("kin:routine-unread-changed"));
    } catch (e) {
      pushToast(e instanceof Error ? e.message : tr("routines.actionFailed"), "error");
    }
  };

  const onCreate = async () => {
    const p = prompt.trim();
    if (!p) {
      pushToast(tr("routines.needPrompt"), "error");
      return;
    }
    if (!cwd.trim()) {
      pushToast(tr("routines.needCwd"), "error");
      return;
    }
    setCreating(true);
    try {
      const nextMs = parseLocalDateTime(nextRunLocal);
      const titleRunes = Array.from(title.trim() || p);
      const resolvedTitle =
        titleRunes.length > 48 ? titleRunes.slice(0, 48).join("") + "…" : titleRunes.join("");
      const r = await createRoutine({
        title: resolvedTitle,
        cwd: cwd.trim(),
        prompt: p,
        interval_secs: intervalSecs,
        agent: agentId || undefined,
        permission_mode: permissionMode,
        ...(nextMs != null ? { next_due_at: nextMs } : {}),
      });
      setRoutines((list) => [r, ...list]);
      setShowCreate(false);
      setPrompt("");
      setTitle("");
      setNextRunLocal(defaultNextRunLocal());
      pushToast(tr("routines.created"), "info");
    } catch (e) {
      pushToast(e instanceof Error ? e.message : tr("routines.actionFailed"), "error");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto kin-scroll">
    <div className="mx-auto max-w-3xl px-4 py-6 md:px-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight text-kin-text">
            {tr("routines.title")}
          </h1>
          <p className="mt-1 text-[13px] text-kin-secondary">{tr("routines.subtitle")}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setShowCreate((v) => !v)}
            className={[
              "rounded-lg px-3 py-1.5 text-[12.5px] font-medium",
              showCreate
                ? "border border-[var(--kin-hairline)] text-kin-secondary"
                : "bg-kin-accent text-white",
            ].join(" ")}
          >
            {showCreate ? tr("routines.cancel") : tr("routines.createEntry")}
          </button>
          <button
            type="button"
            onClick={() => void onMarkAllRead()}
            className="rounded-lg border border-[var(--kin-hairline)] px-3 py-1.5 text-[12.5px] text-kin-secondary hover:bg-[var(--kin-fill)]"
          >
            {tr("routines.markAllRead")}
          </button>
        </div>
      </div>

      {showCreate && (
        <section className="mt-5 rounded-2xl border border-kin-blue/30 bg-kin-blue/[0.04] p-4">
          <div className="text-[14px] font-medium text-kin-text">
            {tr("routines.createPanelTitle")}
          </div>
          <p className="mt-1 text-[12.5px] text-kin-secondary">
            {tr("routines.createPanelHint")}
          </p>

          <label className="mt-4 block text-[12px] text-kin-secondary">
            {tr("routines.titleLabel")}
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={tr("routines.titlePlaceholder")}
              disabled={creating}
              className="mt-1 w-full rounded-lg border border-[var(--kin-hairline)] bg-[var(--kin-fill)] px-3 py-2 text-[13px] text-kin-text outline-none focus:border-kin-blue/40"
            />
          </label>

          <label className="mt-3 block text-[12px] text-kin-secondary">
            {tr("routines.promptLabel")}
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={tr("routines.promptPlaceholder")}
              rows={4}
              disabled={creating}
              className="mt-1 w-full resize-y rounded-xl border border-[var(--kin-hairline)] bg-kin-panel px-3 py-2.5 text-[13.5px] text-kin-text outline-none focus:border-kin-blue/40"
            />
          </label>

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
            <PermissionModePicker
              value={permissionMode}
              disabled={creating}
              onChange={setPermissionMode}
            />
            {availableAgents.length > 0 && (
              <label className="inline-flex items-center gap-2 text-[12px] text-kin-secondary">
                <span className="text-kin-muted">agent</span>
                <select
                  value={agentId}
                  disabled={creating}
                  onChange={(e) => setAgentId(e.target.value)}
                  className="rounded-lg border border-[var(--kin-hairline)] bg-[var(--kin-fill)] px-2 py-1 text-[12.5px] text-kin-text"
                >
                  {availableAgents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          <div className="mt-3">
            <CwdPicker
              className="w-full"
              cwd={cwd}
              locked={false}
              onChange={setCwd}
            />
          </div>

          <div className="mt-3 rounded-xl border border-[var(--kin-hairline)] bg-[var(--kin-fill)]/50 px-3 py-2.5">
            <RoutineScheduleFields
              intervalSecs={intervalSecs}
              onIntervalChange={setIntervalSecs}
              nextRunLocal={nextRunLocal}
              onNextRunLocalChange={setNextRunLocal}
              disabled={creating}
            />
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              className="rounded-lg px-3 py-1.5 text-[13px] text-kin-secondary"
              onClick={() => setShowCreate(false)}
            >
              {tr("routines.cancel")}
            </button>
            <button
              type="button"
              disabled={creating || !prompt.trim() || !cwd.trim()}
              className="rounded-lg bg-kin-accent px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
              onClick={() => void onCreate()}
            >
              {tr("routines.createAndOpen")}
            </button>
          </div>
        </section>
      )}

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
                {!showCreate && (
                  <button
                    type="button"
                    className="mt-4 rounded-lg bg-kin-accent px-3 py-1.5 text-[13px] font-medium text-white"
                    onClick={() => setShowCreate(true)}
                  >
                    {tr("routines.createEntry")}
                  </button>
                )}
              </div>
            ) : (
              <div className="max-h-[min(360px,42vh)] overflow-y-auto kin-scroll rounded-2xl border border-[var(--kin-hairline)] bg-[var(--kin-fill)]/30 p-2.5 sm:p-3">
                {noteworthy.length > 0 && (
                  <ul className="space-y-2.5">
                    {noteworthy.map((run) => (
                      <RunCard key={run.id} run={run} onMarkRead={onMarkRead} tr={tr} />
                    ))}
                  </ul>
                )}
                {silent.length > 0 && (
                  <div className={noteworthy.length > 0 ? "mt-3" : undefined}>
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
            <span className="text-[11px] text-kin-muted">{statusLabel(run.status, tr)}</span>
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
