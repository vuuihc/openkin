import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  ApiError,
  createRoutine,
  deleteRoutine,
  isAuthenticated,
  isTerminal,
  listRoutineRuns,
  listRoutines,
  listTasks,
  markAllRoutineRunsRead,
  markRoutineRunRead,
  patchRoutine,
  runRoutineNow,
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
  localTimeZone,
  parseRoutineRule,
  serializeRoutineRule,
  type RoutineRule,
} from "../lib/routineRecurrence";
import {
  appendOlderRuns,
  foldRoutineRun,
  pageCursor,
  reconcileRoutineReads,
  ROUTINE_HISTORY_MAX,
  ROUTINE_HISTORY_PAGE,
} from "../lib/routineHistory";
import { SlowConnectHint } from "../components/Skeleton";
import SheetSelect from "../components/ui/SheetSelect";
import { useMachines } from "../hooks/useMachines";
import { useRoutinePreview } from "../hooks/useRoutinePreview";
import { useSlowHint } from "../hooks/useSlowHint";
import { useT } from "../i18n/react";
import { catalogFor, isRemoteDevice } from "../lib/devices";
import {
  machineForRoutineDevice,
  readRoutineDevice,
  resolveRoutineDevice,
  THIS_MACHINE,
  writeRoutineDevice,
} from "../lib/routineDevice";
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
  // A full page is the tasks route's only "maybe more" signal. Older pages are
  // asked for below the oldest id a page returned — kept here rather than read
  // off the list, because a live push can put a deeper run at the tail and the
  // cursor must not follow it down.
  const [historyHasMore, setHistoryHasMore] = useState<Record<string, boolean>>({});
  const [historyCursor, setHistoryCursor] = useState<Record<string, string>>({});
  const [historyLoadingOlder, setHistoryLoadingOlder] = useState<Record<string, boolean>>({});
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
  const [agentId, setAgentId] = useState("");
  // A routine belongs to one machine, and this page reads one machine's
  // routines. The remembered choice is resolved once the machine list arrives;
  // see resolveRoutineDevice for why "this machine" is not the default on a
  // phone (there, this machine is the Hub, which holds no routines).
  const [deviceId, setDeviceId] = useState<string>(() => readRoutineDevice());
  // Set once the reader picks a machine themselves, so a list refresh cannot
  // overrule them.
  const deviceTouched = useRef(false);
  const {
    machines,
    agents: localAgents,
    loading: machinesLoading,
    failed: machinesFailed,
  } = useMachines();
  const machine = machineForRoutineDevice(machines, deviceId);
  // Read from the id, not from the machine cache: when the machine list could
  // not be read the cache degrades to this machine alone, and a page that then
  // believed its remote routines were local would link to tasks the Hub cannot
  // serve and read its own task store under another machine's routine name.
  const remote = isRemoteDevice(deviceId) && !machine?.isSelf;
  // The websocket handler is registered once, and it must not fold the Hub's
  // own task updates into a remote machine's feed.
  const remoteRef = useRef(remote);
  remoteRef.current = remote;
  const deviceRef = useRef(deviceId);
  deviceRef.current = deviceId;
  // What that machine says it can run. For this machine that is the local
  // registry; for another it is what the machine reported, because that is the
  // list the Hub validates a routine's agent against.
  const machineAgents = useMemo(() => catalogFor(machine, localAgents), [machine, localAgents]);
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

  // A device switch and a reconnect can both start a load; only the newest
  // answer may land, or one machine's routines would be shown under another
  // machine's name.
  const loadSeq = useRef(0);
  // When the last load failed, so a retry can be armed. A sleeping machine or a
  // Hub coming back from a restart is a normal state, and the person should not
  // have to reload the page to see it end.
  const [failedAt, setFailedAt] = useState(0);
  // Each consecutive failure widens the wait: a page left open on a machine
  // that stays offline should keep trying, but not relay a request every 15
  // seconds forever. A good load puts it back to the short wait.
  const retryDelay = useRef(15_000);
  const load = useCallback(async () => {
    if (!isAuthenticated()) return;
    // Until the machine list settles, the page has not chosen a machine yet.
    // Asking now would read this daemon's empty store for a moment and then
    // ask again for the machine the page was going to open on.
    if (machinesLoading) return;
    const seq = ++loadSeq.current;
    try {
      const [rs, feed] = await Promise.all([
        listRoutines({ limit: 100, q: routineQuery.trim() || undefined }, deviceId),
        listRoutineRuns(80, deviceId),
      ]);
      if (seq !== loadSeq.current) return;
      setRoutines(rs.routines ?? []);
      setRoutineCursor(rs.next_cursor ?? "");
      setRoutineHasMore(rs.has_more);
      setRuns(feed);
      setError(null);
      setFailedAt(0);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      if (e instanceof ApiError && e.status === 401) return;
      setError(e instanceof Error ? e.message : tr("routines.loadFailed"));
      setFailedAt(Date.now());
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [tr, routineQuery, deviceId, machinesLoading]);

  const loadMoreRoutines = async () => {
    if (!routineCursor || !routineHasMore || loadingMoreRoutines) return;
    setLoadingMoreRoutines(true);
    const seq = loadSeq.current;
    try {
      const page = await listRoutines(
        {
          limit: 100,
          cursor: routineCursor,
          q: routineQuery.trim() || undefined,
        },
        deviceId,
      );
      // A page from the machine the page has since left is not this machine's
      // second page.
      if (seq !== loadSeq.current) return;
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

  // The page opens on a machine, and the remembered choice is only a preference
  // until the list confirms it still exists. `deviceTouched` keeps a later list
  // refresh from overruling a choice the reader made in this session.
  //
  // A list that failed to load is not confirmation of anything: it degrades to
  // "this machine", and resolving against it would overwrite a good remembered
  // machine with the Hub — which is the empty page this whole change exists to
  // fix. The saved choice stands until a real list arrives.
  useEffect(() => {
    if (machinesLoading || machinesFailed || deviceTouched.current) return;
    const resolved = resolveRoutineDevice(machines, deviceId);
    if (resolved === deviceId) return;
    setDeviceId(resolved);
    writeRoutineDevice(resolved);
  }, [machinesLoading, machinesFailed, machines, deviceId]);

  // A failure re-arms this; a success clears the timestamp, resets the wait,
  // and cancels it. The wait doubles when a retry fires, so it is the previous
  // failure's delay that is armed here.
  useEffect(() => {
    if (!failedAt) {
      retryDelay.current = 15_000;
      return;
    }
    const timer = setTimeout(() => {
      retryDelay.current = Math.min(retryDelay.current * 2, 120_000);
      void load();
    }, retryDelay.current);
    return () => clearTimeout(timer);
  }, [failedAt, load]);

  // A different machine has different routines, different runs, and different
  // paths. Nothing from the old one may stay on screen while the new one loads:
  // a row from the wrong machine reads as that machine's routine.
  useEffect(() => {
    setRoutines([]);
    setRuns([]);
    setRoutineCursor("");
    setRoutineHasMore(false);
    setHistory({});
    setError(null);
    setFailedAt(0);
    setLoading(true);
    // The form's directory, agent, and model are the machine it was opened on.
    // Carrying them across would make a routine that fails on its first run.
    setShowCreate(false);
    setEditing(null);
    createDraftRef.current = null;
    setCwd("");
    setAgentId("");
    setModel("");
  }, [deviceId]);

  useEffect(() => {
    return subscribeWS((msg) => {
      if (msg.kind !== "task_update") return;
      // The Hub's stream carries the Hub's tasks. While the page is showing
      // another machine's routines, one of those updates would appear in that
      // machine's feed — and marking it read would relay to a machine that has
      // never heard of it.
      if (remoteRef.current) return;
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
      // The editor's list is a snapshot from when it opened. A scheduled run
      // that starts (or finishes) while the editor stays open has to land here
      // too, or the reader watches a list that never moves.
      setHistory((prev) => {
        const folded = foldRoutineRun(prev[t.routine_id!], t);
        return folded ? { ...prev, [t.routine_id!]: folded } : prev;
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

  const availableAgents = useMemo(() => machineAgents.filter((a) => a.available), [machineAgents]);
  // A new routine starts on the agent this machine would use. The choice is
  // only filled in when there is none: an edit's agent — which may be offline
  // but is still the agent that routine runs with — must not be displaced by a
  // catalog refresh.
  useEffect(() => {
    if (availableAgents.length === 0) return;
    setAgentId((cur) => {
      if (cur) return cur;
      const def = availableAgents.find((a) => a.default) ?? availableAgents[0];
      return def?.id ?? "";
    });
  }, [availableAgents]);
  // The agent whose catalog the model picker lists. It is read from all agents,
  // not just the available ones: a routine keeps its agent when that agent goes
  // offline, and the catalog it last reported is still the best list to offer.
  const modelAgent = machineAgents.find((a) => a.id === agentId);

  // The rule as create or a patch would send it. A one-off shows its instant in
  // the date field itself, so only repeated rules are worth asking about.
  const rulePayload = useMemo(() => {
    if (!routineRule || routineRule.kind === "once") return "";
    // A stored rule keeps the zone it was written in; a new one is written in
    // the browser's. Defaulting the same way the edit path does
    // (`schedulePatch` in routineEdit.ts) keeps the preview on the clock the
    // save would store, not just one that happens to match today.
    return serializeRoutineRule(routineRule, null, ruleZone ?? localTimeZone());
  }, [routineRule, ruleZone]);
  const rulePreviewAt = useRoutinePreview(rulePayload);

  const onToggle = async (r: Routine) => {
    setBusy((b) => ({ ...b, [r.id]: true }));
    try {
      const updated = await patchRoutine(r.id, { enabled: !r.enabled }, deviceId);
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
      await deleteRoutine(r.id, deviceId);
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
    const at = deviceId;
    try {
      const t = await runRoutineNow(r.id, at);
      // The page moved to another machine while the run was starting. This
      // task belongs to the machine that was showing, not the one that is.
      if (deviceRef.current !== at) return;
      setRuns((prev) => [t, ...prev].slice(0, 80));
      // The editor may be open on this routine; Run now should show up there
      // without waiting for the websocket echo (which the fold then dedupes).
      setHistory((prev) => {
        const folded = foldRoutineRun(prev[r.id], t);
        return folded ? { ...prev, [r.id]: folded } : prev;
      });
      pushToast(tr("routines.runStarted"), "info");
    } catch (e) {
      pushToast(e instanceof Error ? e.message : tr("routines.actionFailed"), "error");
    } finally {
      setBusy((b) => ({ ...b, [r.id]: false }));
    }
  };

  const onMarkRead = async (taskId: string) => {
    try {
      const t = await markRoutineRunRead(taskId, deviceId);
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
    if (remote) {
      // The Hub cannot read this machine's task table, and the relayed routine
      // feed is its only window into that machine's runs: the newest runs of
      // every routine on it, which this page already holds. That is the whole
      // history this console can show, and there is no older page to ask for.
      setHistory((prev) => ({ ...prev, [id]: runs.filter((x) => x.routine_id === id) }));
      setHistoryHasMore((prev) => ({ ...prev, [id]: false }));
      setHistoryError((prev) => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
      return;
    }
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
      const tasks = await listTasks({ routineId: id, limit: ROUTINE_HISTORY_PAGE });
      if (historySeq.current[id] !== seq) return;
      const allRead = readAllEpoch.current !== epoch;
      const read = knownRead.current;
      setHistoryHasMore((prev) => ({ ...prev, [id]: tasks.length >= ROUTINE_HISTORY_PAGE }));
      setHistoryCursor((prev) => ({ ...prev, [id]: pageCursor(tasks) }));
      setHistory((prev) => ({
        ...prev,
        [id]: reconcileRoutineReads(tasks, allRead, read),
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

  /**
   * The next page of runs below the last one a page returned. The cursor is
   * that page's oldest id ("id < before"); a page that came back empty or short
   * means there is nothing older to ask for, so the button goes away. The list
   * is capped, so the button and this guard stop asking at 200 rows; a page
   * that straddles the cap keeps its newer rows and drops its oldest.
   */
  const loadOlderHistory = async (id: string) => {
    // A remote machine's runs come from the feed, which has no older pages the
    // Hub can ask for; the button is not shown there.
    if (remote) return;
    const cursor = historyCursor[id] ?? "";
    if (
      !id ||
      !cursor ||
      historyLoadingOlder[id] ||
      (history[id]?.length ?? 0) >= ROUTINE_HISTORY_MAX
    ) {
      return;
    }
    // A re-open starts a newer initial fetch, which replaces the list this
    // cursor came from; appending to that new list would skip the rows between
    // the two pages. Same newest-wins policy as loadHistory.
    const seq = historySeq.current[id] ?? 0;
    const epoch = readAllEpoch.current;
    const read = knownRead.current;
    setHistoryLoadingOlder((prev) => ({ ...prev, [id]: true }));
    try {
      const page = await listTasks({
        routineId: id,
        limit: ROUTINE_HISTORY_PAGE,
        before: cursor,
      });
      if (historySeq.current[id] !== seq) return;
      // The page can predate a mark-all (which publishes no task update) or a
      // per-task mark; reconcile before appending or older rows come back
      // unread over a badge that says everything is read.
      const allRead = readAllEpoch.current !== epoch;
      // The list may have grown while this page was in flight (a live run, the
      // previous page); merging into the latest state keeps both.
      setHistory((prev) => ({
        ...prev,
        [id]: appendOlderRuns(prev[id] ?? [], reconcileRoutineReads(page, allRead, read)),
      }));
      setHistoryHasMore((prev) => ({ ...prev, [id]: page.length >= ROUTINE_HISTORY_PAGE }));
      setHistoryCursor((prev) => ({ ...prev, [id]: pageCursor(page) }));
    } catch (e) {
      pushToast(e instanceof Error ? e.message : tr("routines.actionFailed"), "error");
    } finally {
      setHistoryLoadingOlder((prev) => ({ ...prev, [id]: false }));
    }
  };

  const onMarkAllRead = async () => {
    try {
      await markAllRoutineRunsRead(deviceId);
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
        const updated = await patchRoutine(editing.id, patch, deviceId);
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
      const r = await createRoutine(
        {
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
        },
        deviceId,
      );
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

  const machineOptions = useMemo(() => {
    const rows = machines.map((m) => ({
      id: m.isSelf ? THIS_MACHINE : m.id,
      label: m.isSelf
        ? tr("machine.thisMachine")
        : `${m.label}${m.online ? "" : ` · ${tr("machine.offline")}`}`,
    }));
    // Before the list arrives there is still one machine: this one.
    return rows.length > 0 ? rows : [{ id: THIS_MACHINE, label: tr("machine.thisMachine") }];
  }, [machines, tr]);

  /**
   * Point the page at another machine.
   *
   * An open form goes with the old machine: its directory, its agent, and its
   * model are that machine's, and carrying any of them into a routine on
   * another machine would make a routine that fails on its first run.
   */
  const chooseMachine = (id: string) => {
    if (id === (deviceId || THIS_MACHINE)) return;
    deviceTouched.current = true;
    if (editing) {
      createDraftRef.current = null;
      setEditing(null);
    }
    setShowCreate(false);
    resetForm();
    setCwd("");
    setAgentId("");
    writeRoutineDevice(id);
    // The sidebar badge counts the machine this page shows; a switch that did
    // not tell it would leave the old machine's number there.
    window.dispatchEvent(new Event("kin:routine-unread-changed"));
    setDeviceId(id);
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

        {/* Which machine's routines this page is showing. Above the list
            because everything below it — the routines, their runs, the form's
            directories and agents — is that machine's, not this console's. */}
        <div className="mt-3 flex flex-wrap items-center gap-2 text-body text-kin-secondary">
          <span className="text-kin-muted">{tr("routines.machineLabel")}</span>
          <SheetSelect
            label={tr("machine.title")}
            // This machine has three spellings; the picker has one row for it.
            value={machine?.isSelf ? THIS_MACHINE : deviceId || THIS_MACHINE}
            display={
              !machine && !machinesLoading && isRemoteDevice(deviceId)
                ? machinesFailed
                  ? // The list failed; the id is still what the page is
                    // reading, and calling it "gone" would invent a fact.
                    deviceId
                  : tr("machine.gone", { name: deviceId })
                : undefined
            }
            placeholder={machinesLoading ? tr("machine.detecting") : undefined}
            options={machineOptions}
            disabled={creating || machinesLoading}
            className="text-kin-text"
            onChange={chooseMachine}
          />
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
                <span className="inline-flex items-center gap-2 text-body text-kin-secondary">
                  <span className="text-kin-muted">{tr("routines.agentLabel")}</span>
                  <SheetSelect
                    label={tr("routines.agentLabel")}
                    value={agentId}
                    disabled={creating}
                    options={[
                      /* A routine keeps the agent it was created with, even if
                         that agent is offline right now. Without this row the
                         control would show the first available agent while the
                         state still held the missing id. */
                      ...(agentId && availableAgents.every((a) => a.id !== agentId)
                        ? [{ id: agentId, label: agentId }]
                        : []),
                      ...availableAgents.map((a) => ({ id: a.id, label: a.name })),
                    ]}
                    onChange={(next) => {
                      setAgentId(next);
                      // A model from the old agent's catalog is not one this
                      // agent has; New Chat clears the same way on a host
                      // change, and a stored id the agent does not know would
                      // fail every run instead of falling back.
                      setModel("");
                    }}
                  />
                </span>
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
                  models={modelsForAgent(machineAgents, agentId)}
                  source={modelAgent?.model_list_source}
                  status={modelAgent?.model_list_status}
                  disabled={creating}
                  onChange={setModel}
                />
              )}
            </div>

            <div className="mt-3">
              <CwdPicker
                className="w-full"
                cwd={cwd}
                locked={false}
                // The cwd is a path on the machine the routine runs on. Without
                // this the panel would list this console's directories and the
                // saved path would be one that machine has never heard of.
                device={deviceId || undefined}
                onChange={setCwd}
              />
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
                nextRunPreview={rulePreviewAt}
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
                  <p className="mt-2 text-body text-kin-secondary">
                    {remote ? tr("routines.historyEmptyRemote") : tr("routines.historyEmpty")}
                  </p>
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
                        linkable={!remote}
                      />
                    ))}
                    {/* Inside the scroll box: the click happens at the bottom,
                        and the rows it fetches appear just above the button,
                        in view. Outside it, the label changed while the new
                        rows landed off-screen. */}
                    {historyHasMore[editing.id] &&
                      (history[editing.id]?.length ?? 0) < ROUTINE_HISTORY_MAX && (
                        <li>
                          <button
                            type="button"
                            disabled={historyLoadingOlder[editing.id]}
                            onClick={() => void loadOlderHistory(editing.id)}
                            className="min-h-11 text-body text-kin-secondary hover:text-kin-text disabled:opacity-50 sm:min-h-8"
                          >
                            {historyLoadingOlder[editing.id]
                              ? tr("routines.historyLoadingOlder")
                              : tr("routines.historyLoadOlder")}
                          </button>
                        </li>
                      )}
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
                        <RunCard
                          key={run.id}
                          run={run}
                          onMarkRead={onMarkRead}
                          tr={tr}
                          linkable={!remote}
                        />
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
                            <RunCard
                              key={run.id}
                              run={run}
                              onMarkRead={onMarkRead}
                              tr={tr}
                              quiet
                              linkable={!remote}
                            />
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
  linkable = true,
}: {
  run: Task;
  onMarkRead: (id: string) => void;
  tr: (key: string, vars?: Record<string, string | number>) => string;
  quiet?: boolean;
  /** The card already sits under its own routine; the id prefix is noise. */
  ownRoutine?: boolean;
  /**
   * Whether this console can open the run. It can for this machine's tasks; a
   * run on another machine lives in that machine's store, which the Hub cannot
   * read, so a link here would lead to a task page that does not exist.
   */
  linkable?: boolean;
}) {
  const title = run.title || run.id.slice(0, 8);
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
            {linkable ? (
              <Link
                to={`/tasks/${run.id}`}
                className="truncate text-strong font-medium text-kin-text hover:underline"
                onClick={() => {
                  if (run.routine_unread) onMarkRead(run.id);
                }}
              >
                {title}
              </Link>
            ) : (
              <span className="truncate text-strong font-medium text-kin-text">{title}</span>
            )}
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
