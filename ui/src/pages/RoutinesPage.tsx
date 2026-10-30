import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  ApiError,
  createRoutine,
  deleteRoutine,
  isAuthenticated,
  isTerminal,
  listAgents,
  listRoutineRuns,
  listRoutines,
  listTasks,
  markAllRoutineRunsRead,
  markRoutineRunRead,
  patchRoutine,
  runRoutineNow,
  type AgentInfo,
  type Routine,
  type Task,
} from "../api/client";
import CwdPicker from "../components/chat/CwdPicker";
import ModelPicker from "../components/chat/ModelPicker";
import PermissionModePicker from "../components/chat/PermissionModePicker";
import RoutineScheduleFields, {
  defaultNextRunLocal,
  parseLocalDateTime,
  toLocalInputValue,
} from "../components/routine/RoutineScheduleFields";
import {
  describeRoutineRule,
  parseRoutineRule,
  serializeRoutineRule,
  type RoutineRule,
} from "../lib/routineRecurrence";
import { SlowConnectHint } from "../components/Skeleton";
import { useSlowHint } from "../hooks/useSlowHint";
import { useT } from "../i18n/react";
import {
  getDraftPermissionMode,
  normalizePermissionMode,
  type PermissionMode,
} from "../lib/permissionMode";
import { modelsForAgent } from "../lib/agentModels";
import { routineForm, routinePatch, routineTitle } from "../lib/routineEdit";
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
 * The form's fields as one value, so the create draft can be handed back
 * untouched after an edit borrowed the form.
 */
type FormDraft = {
  title: string;
  prompt: string;
  cwd: string;
  agentId: string;
  model: string;
  permissionMode: PermissionMode;
  intervalSecs: number;
  rule: RoutineRule | null;
  ruleZone: string | null;
  nextRunLocal: string;
};

/**
 * Global Routines inbox — create + reverse-chron runs feed + controls.
 * Create reuses New-chat controls (cwd / permission / schedule).
 */
export default function RoutinesPage() {
  const tr = useT();
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [routineQuery, setRoutineQuery] = useState("");
  const [routineCursor, setRoutineCursor] = useState("");
  const [routineHasMore, setRoutineHasMore] = useState(false);
  const [loadingMoreRoutines, setLoadingMoreRoutines] = useState(false);
  const [runs, setRuns] = useState<Task[]>([]);
  // One routine's own recent runs, keyed by routine id; loaded when it is opened.
  const [history, setHistory] = useState<Record<string, Task[]>>({});
  // Keyed too: opening a second routine while the first is still loading must
  // not put the first one's spinner or failure under the second one's name.
  const [historyLoading, setHistoryLoading] = useState<Record<string, boolean>>({});
  const [historyError, setHistoryError] = useState<Record<string, string>>({});
  // The newest fetch per routine; an older one that lands late is discarded.
  const historySeq = useRef<Record<string, number>>({});
  // Unread only ever goes true -> false, so a write that landed while a fetch
  // was out must beat that fetch's older snapshot: the history would otherwise
  // show unread rows on a screen whose feed and badge say read.
  const knownRead = useRef<Set<string>>(new Set());
  const readAllEpoch = useRef(0);
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
  const [routineRule, setRoutineRule] = useState<RoutineRule | null>(null);
  // The zone the rule's time is expressed in; null = the browser's zone.
  const [ruleZone, setRuleZone] = useState<string | null>(null);
  const [nextRunLocal, setNextRunLocal] = useState(() => defaultNextRunLocal());
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agentId, setAgentId] = useState("");
  // The model its runs start with; "" means the agent's own default, which is
  // what every routine ran with before the field existed.
  const [model, setModel] = useState("");
  const [creating, setCreating] = useState(false);
  // The routine the form is editing; null means it is creating a new one.
  const [editing, setEditing] = useState<Routine | null>(null);
  const formRef = useRef<HTMLElement | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  // The create draft an edit temporarily took over (see `closeForm`).
  const createDraftRef = useRef<FormDraft | null>(null);

  const load = useCallback(async () => {
    if (!isAuthenticated()) return;
    try {
      const [rs, feed, agentList] = await Promise.all([
        listRoutines({ limit: 100, q: routineQuery.trim() || undefined }),
        listRoutineRuns(80),
        listAgents().catch(() => [] as AgentInfo[]),
      ]);
      setRoutines(rs.routines ?? []);
      setRoutineCursor(rs.next_cursor ?? "");
      setRoutineHasMore(rs.has_more);
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
  }, [tr, routineQuery]);

  const loadMoreRoutines = async () => {
    if (!routineCursor || !routineHasMore || loadingMoreRoutines) return;
    setLoadingMoreRoutines(true);
    try {
      const page = await listRoutines({
        limit: 100,
        cursor: routineCursor,
        q: routineQuery.trim() || undefined,
      });
      setRoutines((current) => [...current, ...(page.routines ?? [])]);
      setRoutineCursor(page.next_cursor ?? "");
      setRoutineHasMore(page.has_more);
    } catch (e) {
      pushToast(e instanceof Error ? e.message : tr("routines.actionFailed"), "error");
    } finally {
      setLoadingMoreRoutines(false);
    }
  };

  useEffect(() => {
    void load();
  }, [load, reconnectGen]);

  useEffect(() => {
    return subscribeWS((msg) => {
      if (msg.kind !== "task_update") return;
      const t = msg.data;
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

  const availableAgents = useMemo(() => agents.filter((a) => a.available), [agents]);
  // The agent whose catalog the model picker lists. It is read from all agents,
  // not just the available ones: a routine keeps its agent when that agent goes
  // offline, and the catalog it last reported is still the best list to offer.
  const modelAgent = agents.find((a) => a.id === agentId);

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
      // Deleting the routine the form is editing would leave Save pointed at a
      // row that no longer exists.
      if (editing?.id === r.id) closeForm();
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
      knownRead.current.add(taskId);
      // Explicit false: API used to omit false bools via omitempty.
      setRuns((prev) =>
        prev.map((x) => (x.id === taskId ? { ...x, ...t, routine_unread: false } : x)),
      );
      setHistory((prev) => {
        let touched = false;
        const next: Record<string, Task[]> = {};
        for (const [id, list] of Object.entries(prev)) {
          next[id] = list.map((x) => {
            if (x.id !== taskId) return x;
            touched = true;
            return { ...x, ...t, routine_unread: false };
          });
        }
        return touched ? next : prev;
      });
      window.dispatchEvent(new Event("kin:routine-unread-changed"));
    } catch {
      /* best-effort */
    }
  };

  /**
   * One routine's own runs, newest first. The global feed is capped, so a
   * routine that has not run recently would otherwise look like it never ran;
   * the daemon's list already supports the filter.
   */
  const loadHistory = async (id: string) => {
    // An empty id means "no filter" to the daemon, which would show the newest
    // tasks of any kind under one routine's name.
    if (!id) return;
    // Reopening the same routine starts a second fetch; the older one must not
    // overwrite the newer list when it lands late.
    const seq = (historySeq.current[id] ?? 0) + 1;
    historySeq.current[id] = seq;
    const epoch = readAllEpoch.current;
    setHistoryLoading((prev) => ({ ...prev, [id]: true }));
    setHistoryError((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    try {
      const tasks = await listTasks({ routineId: id, limit: 10 });
      if (historySeq.current[id] !== seq) return;
      const allRead = readAllEpoch.current !== epoch;
      const read = knownRead.current;
      setHistory((prev) => ({
        ...prev,
        [id]: tasks.map((x) => (allRead || read.has(x.id) ? { ...x, routine_unread: false } : x)),
      }));
    } catch (e) {
      if (historySeq.current[id] !== seq) return;
      // A convenience: the editor works without it, but a failed fetch must
      // not read as "this routine has never run".
      setHistoryError((prev) => ({
        ...prev,
        [id]: e instanceof Error ? e.message : tr("routines.actionFailed"),
      }));
    } finally {
      if (historySeq.current[id] === seq) {
        setHistoryLoading((prev) => ({ ...prev, [id]: false }));
      }
    }
  };

  const onMarkAllRead = async () => {
    try {
      await markAllRoutineRunsRead();
      // Mark-all names no ids, so it beats every fetch that was already out.
      readAllEpoch.current += 1;
      setRuns((prev) => prev.map((x) => ({ ...x, routine_unread: false })));
      // The history is on screen at the same time as the feed; leaving it
      // unread would make the page contradict itself.
      setHistory((prev) => {
        let touched = false;
        const next: Record<string, Task[]> = {};
        for (const [id, list] of Object.entries(prev)) {
          next[id] = list.map((x) => {
            if (!x.routine_unread) return x;
            touched = true;
            return { ...x, routine_unread: false };
          });
        }
        return touched ? next : prev;
      });
      // Nudge App badge (mark-all has no per-task WS storm).
      window.dispatchEvent(new Event("kin:routine-unread-changed"));
    } catch (e) {
      pushToast(e instanceof Error ? e.message : tr("routines.actionFailed"), "error");
    }
  };

  const resetForm = () => {
    setTitle("");
    setPrompt("");
    setModel("");
    setRoutineRule(null);
    setRuleZone(null);
    setNextRunLocal(defaultNextRunLocal());
  };

  const formDraft = (): FormDraft => ({
    title,
    prompt,
    cwd,
    agentId,
    model,
    permissionMode,
    intervalSecs,
    rule: routineRule,
    ruleZone,
    nextRunLocal,
  });

  const applyDraft = (draft: FormDraft) => {
    setTitle(draft.title);
    setPrompt(draft.prompt);
    setCwd(draft.cwd);
    setAgentId(draft.agentId);
    setModel(draft.model);
    setPermissionMode(draft.permissionMode);
    setIntervalSecs(draft.intervalSecs);
    setRoutineRule(draft.rule);
    setRuleZone(draft.ruleZone);
    setNextRunLocal(draft.nextRunLocal);
  };

  const closeForm = () => {
    setShowCreate(false);
    // The control that opened the form is still on the page; focus goes back to
    // it rather than to <body>. (For an edit that is the disclosure, not the
    // row: the row may be scrolled away by the time the save returns.)
    requestAnimationFrame(() => toggleRef.current?.focus());
    if (!editing) return;
    // An edit borrowed the create form. Closing it puts back whatever the
    // reader had typed there — otherwise the next new routine would inherit
    // another routine's agent, directory, cadence and permissions.
    const draft = createDraftRef.current;
    createDraftRef.current = null;
    setEditing(null);
    if (draft) applyDraft(draft);
  };

  const openCreate = () => {
    // Opening the create form from inside an edit first closes the edit, which
    // restores the draft.
    if (editing) closeForm();
    setShowCreate(true);
    requestAnimationFrame(() => titleRef.current?.focus());
  };

  const openEdit = (r: Routine) => {
    // Keep the create draft the first time an edit takes the form over.
    if (!editing) createDraftRef.current = formDraft();
    const draft = routineForm(r);
    setEditing(r);
    setTitle(draft.title);
    setPrompt(draft.prompt);
    setCwd(draft.cwd);
    setPermissionMode(normalizePermissionMode(draft.permissionMode));
    setAgentId(draft.agent);
    setModel(draft.model);
    setIntervalSecs(draft.intervalSecs);
    setRoutineRule(draft.rule);
    setRuleZone(draft.ruleZone);
    setNextRunLocal(
      draft.nextRunMs != null
        ? toLocalInputValue(new Date(draft.nextRunMs))
        : defaultNextRunLocal(),
    );
    setShowCreate(true);
    void loadHistory(r.id);
    // The row that opened this is below the fold: bring the form into view and
    // put the caret in it, rather than leaving focus on a button the reader can
    // no longer see. A reader who asked for less motion gets the jump.
    requestAnimationFrame(() => {
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      formRef.current?.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
      titleRef.current?.focus();
    });
  };

  const onSubmit = async () => {
    const p = prompt.trim();
    if (!p) {
      pushToast(tr("routines.needPrompt"), "error");
      return;
    }
    if (!cwd.trim()) {
      pushToast(tr("routines.needCwd"), "error");
      return;
    }
    const nextMs = parseLocalDateTime(nextRunLocal);
    if (routineRule?.kind === "once" && nextMs == null) {
      pushToast(tr("routines.needNextRun"), "error");
      return;
    }
    if (editing) {
      const patch = routinePatch(editing, {
        title,
        prompt: p,
        cwd,
        agent: agentId,
        model,
        permissionMode,
        intervalSecs,
        rule: routineRule,
        nextRunMs: nextMs,
        ruleZone,
      });
      // Nothing to send is a valid save — the reader opened the form and closed
      // it again. It must not become an empty PATCH, and it must not touch the
      // schedule as a side effect of saving.
      if (!patch) {
        closeForm();
        return;
      }
      setCreating(true);
      try {
        const updated = await patchRoutine(editing.id, patch);
        setRoutines((list) => list.map((x) => (x.id === updated.id ? updated : x)));
        closeForm();
        pushToast(tr("routines.saved"), "info");
      } catch (e) {
        pushToast(e instanceof Error ? e.message : tr("routines.actionFailed"), "error");
      } finally {
        setCreating(false);
      }
      return;
    }
    setCreating(true);
    try {
      const resolvedTitle = routineTitle(title, p);
      // With a wall-clock rule the daemon derives the pace and the first run
      // from the rule itself, so neither interval_secs nor next_due_at is sent:
      // a value the scheduler would ignore is a value that can drift out of
      // step with what the form shows.
      const recurrence = serializeRoutineRule(routineRule, nextMs);
      const r = await createRoutine({
        title: resolvedTitle,
        cwd: cwd.trim(),
        prompt: p,
        ...(recurrence
          ? { recurrence }
          : {
              interval_secs: intervalSecs,
              ...(nextMs != null ? { next_due_at: nextMs } : {}),
            }),
        agent: agentId || undefined,
        ...(model.trim() ? { model: model.trim() } : {}),
        permission_mode: permissionMode,
      });
      setRoutines((list) => [r, ...list]);
      closeForm();
      resetForm();
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
          <div className="hidden md:block">
            <h1 className="text-hero font-bold tracking-tight text-kin-text">
              {tr("routines.title")}
            </h1>
            <p className="mt-1 text-strong text-kin-secondary">{tr("routines.subtitle")}</p>
          </div>
          <div className="flex w-full items-center gap-2 md:w-auto md:shrink-0">
            <button
              ref={toggleRef}
              type="button"
              aria-expanded={showCreate}
              aria-controls="routine-form"
              disabled={creating}
              onClick={() => (showCreate ? closeForm() : openCreate())}
              className={[
                "min-h-11 flex-1 rounded-lg px-3 text-body font-medium md:flex-none",
                showCreate
                  ? "border border-[var(--kin-hairline)] text-kin-secondary"
                  : "bg-kin-blue text-kin-on-brand",
              ].join(" ")}
            >
              {showCreate ? tr("routines.cancel") : tr("routines.createEntry")}
            </button>
            <button
              type="button"
              onClick={() => void onMarkAllRead()}
              className="min-h-11 flex-1 rounded-lg border border-[var(--kin-hairline)] px-3 text-body text-kin-secondary hover:bg-[var(--kin-fill)] md:flex-none"
            >
              {tr("routines.markAllRead")}
            </button>
          </div>
        </div>

        {showCreate && (
          <section
            id="routine-form"
            ref={formRef}
            aria-label={editing ? tr("routines.editPanelTitle") : tr("routines.createPanelTitle")}
            className="mt-5 scroll-mt-4 rounded-2xl border border-kin-blue/30 bg-kin-blue/5 p-4"
          >
            <h2 className="text-strong font-medium text-kin-text">
              {editing ? tr("routines.editPanelTitle") : tr("routines.createPanelTitle")}
            </h2>
            <p className="mt-1 text-body text-kin-secondary">
              {editing ? tr("routines.editPanelHint") : tr("routines.createPanelHint")}
            </p>

            <label className="mt-4 block text-body text-kin-secondary">
              {tr("routines.titleLabel")}
              <input
                ref={titleRef}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={tr("routines.titlePlaceholder")}
                disabled={creating}
                className="mt-1 w-full rounded-lg border border-[var(--kin-hairline)] bg-[var(--kin-fill)] px-3 py-2 text-strong text-kin-text outline-none focus:border-kin-blue/40"
              />
            </label>

            <label className="mt-3 block text-body text-kin-secondary">
              {tr("routines.promptLabel")}
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={tr("routines.promptPlaceholder")}
                rows={4}
                disabled={creating}
                className="mt-1 w-full resize-y rounded-xl border border-[var(--kin-hairline)] bg-kin-panel px-3 py-2.5 text-strong text-kin-text outline-none focus:border-kin-blue/40"
              />
            </label>

            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
              <PermissionModePicker
                value={permissionMode}
                disabled={creating}
                onChange={setPermissionMode}
              />
              {availableAgents.length > 0 && (
                <label className="inline-flex items-center gap-2 text-body text-kin-secondary">
                  <span className="text-kin-muted">{tr("routines.agentLabel")}</span>
                  <select
                    value={agentId}
                    disabled={creating}
                    onChange={(e) => {
                      setAgentId(e.target.value);
                      // A model from the old agent's catalog is not one this
                      // agent has; New Chat clears the same way on a host
                      // change, and a stored id the agent does not know would
                      // fail every run instead of falling back.
                      setModel("");
                    }}
                    className="rounded-lg border border-[var(--kin-hairline)] bg-[var(--kin-fill)] px-2 py-1 text-body text-kin-text"
                  >
                    {/* A routine keeps the agent it was created with, even if
                        that agent is offline right now. Without this row the
                        select would show the first available agent while the
                        state still held the missing id. */}
                    {agentId && availableAgents.every((a) => a.id !== agentId) && (
                      <option value={agentId}>{agentId}</option>
                    )}
                    {availableAgents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {agentId && (
                <ModelPicker
                  // The picker's own "Custom" state survives a value change by
                  // design (picking Custom opens an empty input), so a model
                  // cleared here would leave it reading "Custom" with a blank
                  // box. Remounting on form identity and agent re-initialises
                  // that state from the value the form now holds.
                  key={`${editing?.id ?? "new"}:${agentId}`}
                  value={model}
                  models={modelsForAgent(agents, agentId)}
                  source={modelAgent?.model_list_source}
                  status={modelAgent?.model_list_status}
                  disabled={creating}
                  onChange={setModel}
                />
              )}
            </div>

            <div className="mt-3">
              <CwdPicker className="w-full" cwd={cwd} locked={false} onChange={setCwd} />
            </div>

            <div className="mt-3 rounded-xl border border-[var(--kin-hairline)] bg-[var(--kin-fill)] px-3 py-2.5">
              <RoutineScheduleFields
                intervalSecs={intervalSecs}
                onIntervalChange={setIntervalSecs}
                nextRunLocal={nextRunLocal}
                onNextRunLocalChange={setNextRunLocal}
                rule={routineRule}
                onRuleChange={setRoutineRule}
                ruleZone={ruleZone}
                disabled={creating}
              />
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-lg px-3 py-1.5 text-strong text-kin-secondary"
                onClick={closeForm}
              >
                {tr("routines.cancel")}
              </button>
              <button
                type="button"
                // A one-off with no date-time is refused on submit with a
                // message, not by a disabled button: the schedule field beside
                // it still says "runs on the next tick", so a dead Save would
                // be the only thing telling the reader otherwise.
                disabled={creating || !prompt.trim() || !cwd.trim()}
                className="rounded-lg bg-kin-blue px-3 py-1.5 text-strong font-medium text-kin-on-brand disabled:opacity-50"
                onClick={() => void onSubmit()}
              >
                {editing ? tr("routines.save") : tr("routines.createAndOpen")}
              </button>
            </div>

            {editing && (
              <section
                className="mt-5 border-t border-[var(--kin-hairline)] pt-4"
                aria-labelledby="routine-history-title"
              >
                <h3
                  id="routine-history-title"
                  className="text-caption font-semibold uppercase tracking-label text-kin-muted"
                >
                  {tr("routines.historyTitle")}
                </h3>
                {historyLoading[editing.id] ? (
                  <p className="mt-2 text-body text-kin-muted">{tr("routines.historyLoading")}</p>
                ) : historyError[editing.id] ? (
                  <p className="mt-2 text-body text-kin-red-ink">{historyError[editing.id]}</p>
                ) : (history[editing.id]?.length ?? 0) === 0 ? (
                  <p className="mt-2 text-body text-kin-secondary">{tr("routines.historyEmpty")}</p>
                ) : (
                  <ul className="mt-2 max-h-[min(320px,40vh)] space-y-2 overflow-y-auto kin-scroll">
                    {history[editing.id].map((run) => (
                      <RunCard
                        key={run.id}
                        run={run}
                        onMarkRead={onMarkRead}
                        tr={tr}
                        quiet
                        ownRoutine
                      />
                    ))}
                  </ul>
                )}
              </section>
            )}
          </section>
        )}

        {loading && (
          <div className="mt-8">
            <SlowConnectHint show={slow} />
            <div className="mt-4 h-24 animate-pulse rounded-2xl bg-[var(--kin-fill)]" />
          </div>
        )}

        {!loading && error && (
          <div className="mt-6 rounded-xl border border-kin-red/40 bg-kin-red/10 px-4 py-3 text-strong leading-5 text-kin-red-ink">
            {error}
          </div>
        )}

        {!loading && !error && (
          <>
            <section className="mt-8">
              <div className="mb-3 text-caption font-semibold uppercase tracking-label text-kin-muted">
                {tr("routines.feedSection")}
              </div>
              {noteworthy.length === 0 && silent.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-[var(--kin-hairline-strong)] px-6 py-12 text-center">
                  <p className="text-subtitle leading-6 font-medium text-kin-text">
                    {tr("routines.emptyFeed")}
                  </p>
                  <p className="mt-1 text-strong leading-5 text-kin-secondary">
                    {tr("routines.emptyFeedHint")}
                  </p>
                  {!showCreate && (
                    <button
                      type="button"
                      className="mt-4 rounded-lg bg-kin-blue px-3 py-1.5 text-strong font-medium text-kin-on-brand"
                      onClick={() => openCreate()}
                    >
                      {tr("routines.createEntry")}
                    </button>
                  )}
                </div>
              ) : (
                <div className="max-h-[min(360px,42vh)] overflow-y-auto kin-scroll rounded-2xl border border-[var(--kin-hairline)] bg-[var(--kin-fill)] p-2.5 sm:p-3">
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
                        className="text-body text-kin-secondary hover:text-kin-text"
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
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="text-caption font-semibold uppercase tracking-label text-kin-muted">
                  {tr("routines.listSection")}
                </div>
                <input
                  value={routineQuery}
                  onChange={(e) => setRoutineQuery(e.target.value)}
                  placeholder={tr("routines.searchPlaceholder")}
                  aria-label={tr("routines.searchPlaceholder")}
                  className="min-h-11 w-full rounded-lg border border-[var(--kin-hairline)] bg-[var(--kin-fill)] px-2.5 text-body text-kin-text outline-none focus:border-kin-blue/40 sm:max-w-[260px]"
                />
              </div>
              {routines.length === 0 ? (
                <p className="text-strong text-kin-secondary">{tr("routines.emptyList")}</p>
              ) : (
                <ul className="space-y-2.5">
                  {routines.map((r) => (
                    <li key={r.id} className="rounded-2xl bg-kin-panel/80 px-4 py-3">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-strong font-medium text-kin-text">
                              {r.title || r.prompt.slice(0, 48)}
                            </span>
                            <span
                              className={
                                r.enabled
                                  ? "shrink-0 whitespace-nowrap rounded-full bg-kin-green/15 px-2 py-0.5 text-caption font-medium text-kin-green-ink"
                                  : "shrink-0 whitespace-nowrap rounded-full bg-[var(--kin-fill)] px-2 py-0.5 text-caption text-kin-muted"
                              }
                            >
                              {r.enabled ? tr("routines.enabled") : tr("routines.paused")}
                            </span>
                          </div>
                          <div className="mt-1 truncate text-body text-kin-secondary">
                            {r.agent} ·{" "}
                            {describeRoutineRule(parseRoutineRule(r.recurrence), tr) ??
                              formatInterval(r.interval_secs)}{" "}
                            · {r.cwd}
                          </div>
                          <div className="mt-0.5 text-caption text-kin-muted">
                            {tr("routines.nextDue")}
                            {tr("common.labelSeparator")}
                            {formatWhen(r.next_due_at)}
                            {r.consec_failures > 0
                              ? ` · ${tr("routines.failures", { n: r.consec_failures })}`
                              : ""}
                          </div>
                        </div>
                        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                          <button
                            type="button"
                            disabled={!!busy[r.id] || creating}
                            onClick={() => void onRunNow(r)}
                            className="min-h-11 rounded-lg bg-kin-blue px-3 py-1 text-body font-medium text-kin-on-brand disabled:opacity-50 sm:min-h-8 sm:px-2.5"
                          >
                            {tr("routines.runNow")}
                          </button>
                          <button
                            type="button"
                            disabled={!!busy[r.id] || creating}
                            onClick={() => openEdit(r)}
                            aria-label={tr("routines.editRoutine", {
                              title: r.title || r.prompt.slice(0, 48),
                            })}
                            className="min-h-11 rounded-lg border border-[var(--kin-hairline)] px-3 py-1 text-body text-kin-secondary disabled:opacity-50 sm:min-h-8 sm:px-2.5"
                          >
                            {tr("routines.edit")}
                          </button>
                          <button
                            type="button"
                            disabled={!!busy[r.id] || creating}
                            onClick={() => void onToggle(r)}
                            className="min-h-11 rounded-lg border border-[var(--kin-hairline)] px-3 py-1 text-body text-kin-secondary disabled:opacity-50 sm:min-h-8 sm:px-2.5"
                          >
                            {r.enabled ? tr("routines.pause") : tr("routines.resume")}
                          </button>
                          <button
                            type="button"
                            disabled={!!busy[r.id] || creating}
                            onClick={() => void onDelete(r)}
                            className="min-h-11 rounded-lg px-3 py-1 text-body text-kin-red-ink/90 disabled:opacity-50 sm:min-h-8 sm:px-2.5"
                          >
                            {tr("routines.delete")}
                          </button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {routineHasMore && (
                <button
                  type="button"
                  onClick={() => void loadMoreRoutines()}
                  disabled={loadingMoreRoutines}
                  className="mt-3 min-h-11 w-full rounded-lg border border-[var(--kin-hairline)] px-3 py-2 text-body text-kin-secondary hover:bg-[var(--kin-fill)]"
                >
                  {loadingMoreRoutines ? tr("tree.loadingMore") : tr("routines.loadMore")}
                </button>
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
  ownRoutine,
}: {
  run: Task;
  onMarkRead: (id: string) => void;
  tr: (key: string, vars?: Record<string, string | number>) => string;
  quiet?: boolean;
  /** The card already sits under its own routine; the id prefix is noise. */
  ownRoutine?: boolean;
}) {
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
              to={`/tasks/${run.id}`}
              className="truncate text-strong font-medium text-kin-text hover:underline"
              onClick={() => {
                if (run.routine_unread) onMarkRead(run.id);
              }}
            >
              {run.title || run.id.slice(0, 8)}
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
        </div>
        {run.routine_unread && (
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
