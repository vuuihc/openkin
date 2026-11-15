import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
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
import {
  defaultNextRunLocal,
  parseLocalDateTime,
  toLocalInputValue,
} from "../components/routine/RoutineScheduleFields";
import RoutineEditor, { type FormDraft } from "../components/routine/RoutineEditor";
import RoutineList from "../components/routine/RoutineList";
import { RunCard, RunHistoryPanel } from "../components/routine/RoutineRuns";
import { localTimeZone, serializeRoutineRule, type RoutineRule } from "../lib/routineRecurrence";
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
import { useLeaveGuard } from "../hooks/useLeaveGuard";
import { useMachines } from "../hooks/useMachines";
import { useRoutinePreview } from "../hooks/useRoutinePreview";
import { useSlowHint } from "../hooks/useSlowHint";
import { useT } from "../i18n/react";
import { catalogFor, isRemoteDevice } from "../lib/devices";
import { isPhoneLayout } from "../lib/phoneNavigation";
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
import {
  DEFAULT_CONVERSATION_MODE,
  nextRunConversation,
  previousConversation,
  type ConversationMode,
} from "../lib/routineConversation";
import { routineForm, routinePatch, routineTitle } from "../lib/routineEdit";
import { formatWhen } from "../lib/routineTime";
import { subscribeWS, useAppStore } from "../store/appStore";

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
  // Signed default (2026-11-11): a routine's runs keep one agent session going
  // unless the reader asks for a new one per run.
  const [conversationMode, setConversationMode] =
    useState<ConversationMode>(DEFAULT_CONVERSATION_MODE);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The form as it looked when it opened, so closing can tell an untouched
  // form from one that would lose typed words.
  const openDraftRef = useRef<string | null>(null);
  const formFocusFrame = useRef<number | null>(null);
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
  // A disabled-routine notification may name the machine in `/routines?device=`.
  // Keep the URL and the visible machine in step so warm taps, Back/Forward,
  // and a second tap of the same notification all select the right machine.
  const [searchParams, setSearchParams] = useSearchParams();
  const [deviceId, setDeviceId] = useState<string>(
    () => searchParams.get("device")?.trim() || readRoutineDevice(),
  );
  // Set once the reader picks a machine themselves, so a list refresh cannot
  // overrule them.
  const deviceTouched = useRef(false);
  // A chooseMachine URL write is already reflected in deviceId and must not be
  // re-read as a fresh navigation.
  const writingURL = useRef(false);
  const {
    machines,
    agents: localAgents,
    loading: machinesLoading,
    failed: machinesFailed,
  } = useMachines();
  const machine = machineForRoutineDevice(machines, deviceId);
  // A machine the list names and marks offline. This console is never offline
  // to itself: it is answering the page. Writes are disabled while the selected
  // machine is away; the page still shows what it last read.
  const machineOffline = !!machine && !machine.isSelf && !machine.online;
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
  // A -> B -> A can return to the same device while a request from the first A
  // view is still running. Each transition gets a generation so the old answer
  // cannot mutate the new view.
  const viewGeneration = useRef(0);
  const renderedDevice = useRef(deviceId);
  if (renderedDevice.current !== deviceId) {
    renderedDevice.current = deviceId;
    viewGeneration.current += 1;
  }
  const currentView = () => ({
    deviceId,
    generation: viewGeneration.current,
  });
  const isCurrentView = (view: { deviceId: string; generation: number }) =>
    view.deviceId === deviceRef.current && view.generation === viewGeneration.current;
  // What that machine says it can run. For this machine that is the local
  // registry; for another it is what the machine reported, because that is the
  // list the Hub validates a routine's agent against.
  const machineAgents = useMemo(() => catalogFor(machine, localAgents), [machine, localAgents]);
  // The model its runs start with; "" means the agent's own default, which is
  // what every routine ran with before the field existed.
  const [model, setModel] = useState("");
  const [creating, setCreating] = useState(false);
  const formLocked = creating || machineOffline;
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
  // Routines created before they moved to the machines that run them still sit
  // in this machine's store. The page opens on another machine, so without a
  // pointer those rows are invisible: the list looks complete and the reader
  // never learns that "this machine" has routines. What this machine holds,
  // not what to do with it — migrating or retiring the rows is a separate,
  // deliberate decision.
  const [ownMachineRoutines, setOwnMachineRoutines] = useState<{
    count: number;
    more: boolean;
  } | null>(null);
  const ownMachineSeq = useRef(0);
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
    const view = currentView();
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
      if (seq !== loadSeq.current || !isCurrentView(view)) return;
      setRoutines((current) => [...current, ...(page.routines ?? [])]);
      setRoutineCursor(page.next_cursor ?? "");
      setRoutineHasMore(page.has_more);
    } catch (e) {
      if (!isCurrentView(view)) return;
      pushToast(e instanceof Error ? e.message : tr("routines.actionFailed"), "error");
    } finally {
      if (isCurrentView(view)) setLoadingMoreRoutines(false);
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

  // Count what this machine itself holds while the page shows another one. A
  // failed answer shows nothing rather than a false "no routines": the pointer
  // is a convenience, and an invented zero would be worse than its absence.
  useEffect(() => {
    const seq = ++ownMachineSeq.current;
    if (machinesLoading || machinesFailed || machine?.isSelf) {
      setOwnMachineRoutines(null);
      return;
    }
    let live = true;
    void listRoutines({ limit: 100 }, THIS_MACHINE)
      .then((page) => {
        if (!live || seq !== ownMachineSeq.current) return;
        const count = page.routines?.length ?? 0;
        setOwnMachineRoutines(count > 0 ? { count, more: page.has_more } : null);
      })
      .catch(() => {
        if (live && seq === ownMachineSeq.current) setOwnMachineRoutines(null);
      });
    return () => {
      live = false;
    };
  }, [machinesLoading, machinesFailed, machine?.isSelf]);

  // The URL is the page's second input for which machine it shows: a warm tap,
  // a back/forward press, or a replayed notification changes `?device=` while
  // this component stays mounted, and the useState initializer above only runs
  // once. Apply the URL when it names a machine this Hub still knows; when it
  // does not, converge both state and URL to the fallback so a back press does
  // not land on a dead machine.
  useEffect(() => {
    if (writingURL.current) {
      writingURL.current = false;
      return;
    }
    const fromURL = searchParams.get("device")?.trim();
    if (!fromURL) {
      // Make the current choice explicit before another machine can overwrite
      // the remembered preference. Each history entry can now restore its own
      // machine.
      if (machinesLoading || machinesFailed) return;
      const resolved = resolveRoutineDevice(machines, deviceId);
      if (resolved !== deviceId) setDeviceId(resolved);
      writeRoutineDevice(resolved);
      writingURL.current = true;
      setSearchParams({ device: resolved }, { replace: true });
      return;
    }
    if (fromURL === deviceId) return;
    if (machinesLoading || machinesFailed) {
      setDeviceId(fromURL);
      return;
    }
    const resolved = resolveRoutineDevice(machines, fromURL);
    setDeviceId(resolved);
    writeRoutineDevice(resolved);
    if (resolved !== fromURL) {
      writingURL.current = true;
      setSearchParams({ device: resolved }, { replace: true });
    }
  }, [searchParams, deviceId, machinesLoading, machinesFailed, machines]);

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
    setHistoryLoading({});
    setHistoryError({});
    setHistoryHasMore({});
    setHistoryCursor({});
    setHistoryLoadingOlder({});
    historySeq.current = {};
    setError(null);
    setFailedAt(0);
    setLoading(true);
    setLoadingMoreRoutines(false);
    setCreating(false);
    setBusy({});
    // The form's directory, agent, and model are the machine it was opened on.
    // Carrying them across would make a routine that fails on its first run.
    setShowCreate(false);
    setEditing(null);
    createDraftRef.current = null;
    openDraftRef.current = null;
    setSelectedId(null);
    setCwd("");
    setAgentId("");
    setModel("");
    setTitle("");
    setPrompt("");
    setConversationMode(DEFAULT_CONVERSATION_MODE);
    setRoutineRule(null);
    setRuleZone(null);
    setNextRunLocal(defaultNextRunLocal());
    setPermissionMode(getDraftPermissionMode());
    setIntervalSecs(86400);
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
  const selected = useMemo(
    () => routines.find((r) => r.id === selectedId) ?? null,
    [routines, selectedId],
  );
  const unreadByRoutine = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const run of runs) {
      if (!run.routine_unread || !run.routine_id) continue;
      counts[run.routine_id] = (counts[run.routine_id] ?? 0) + 1;
    }
    return counts;
  }, [runs]);

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
  // What the next run will start from. Editing reads the routine's own loaded
  // history — the global feed may not reach back to this routine's last run,
  // and the daemon only looks at that one row. Creating has no history, so the
  // first run always starts a session.
  //
  // The comparison uses what the form would save, not the stored routine: the
  // reader may be about to change the agent, directory or model, and the
  // daemon compares the newest run against those saved values.
  const conversationRuns = editing ? (history[editing.id] ?? []) : [];
  const formCwd = (cwd || editing?.cwd || "").trim();
  const conversationPrevious = previousConversation(
    conversationRuns,
    editing ? { id: editing.id, agent: agentId, cwd: formCwd, model } : undefined,
  );
  // Only the continue hint waits on history: "start a new session each run"
  // needs to know nothing about the last run. While a first read is pending the
  // hint says it is reading rather than guessing "first run"; a refetch after
  // the page is already loaded keeps the known answer on screen (anti-flicker).
  const conversationLoading = !!editing && !!historyLoading[editing.id] && !history[editing.id];
  const conversationPreview = nextRunConversation(conversationMode, conversationPrevious, formCwd);
  const conversationHint =
    conversationMode === "fresh"
      ? tr("routines.conversationFreshHint", {
          cwd: conversationPreview.cwd || tr("routines.conversationCurrentDirectory"),
        })
      : conversationLoading
        ? tr("routines.conversationChecking")
        : conversationPreview.sessionRef
          ? tr("routines.conversationContinues", {
              when: formatWhen(
                conversationPrevious?.finished_at ?? conversationPrevious?.created_at,
              ),
            })
          : conversationRuns.length > 0
            ? tr("routines.conversationRestart")
            : tr("routines.conversationFirstRun");

  const onToggle = async (r: Routine) => {
    const view = currentView();
    setBusy((b) => ({ ...b, [r.id]: true }));
    try {
      const updated = await patchRoutine(r.id, { enabled: !r.enabled }, view.deviceId);
      if (!isCurrentView(view)) return;
      setRoutines((list) => list.map((x) => (x.id === r.id ? updated : x)));
    } catch (e) {
      if (!isCurrentView(view)) return;
      pushToast(e instanceof Error ? e.message : tr("routines.actionFailed"), "error");
    } finally {
      if (isCurrentView(view)) setBusy((b) => ({ ...b, [r.id]: false }));
    }
  };

  const onDelete = async (r: Routine) => {
    if (!window.confirm(tr("routines.deleteConfirm", { title: r.title || r.id }))) return;
    const view = currentView();
    setBusy((b) => ({ ...b, [r.id]: true }));
    try {
      await deleteRoutine(r.id, view.deviceId);
      if (!isCurrentView(view)) return;
      setRoutines((list) => list.filter((x) => x.id !== r.id));
      // Deleting the routine the form is editing would leave Save pointed at a
      // row that no longer exists.
      if (editing?.id === r.id) closeForm(true);
      if (selectedId === r.id) setSelectedId(null);
    } catch (e) {
      if (!isCurrentView(view)) return;
      pushToast(e instanceof Error ? e.message : tr("routines.actionFailed"), "error");
    } finally {
      if (isCurrentView(view)) setBusy((b) => ({ ...b, [r.id]: false }));
    }
  };

  const onRunNow = async (r: Routine) => {
    const view = currentView();
    setBusy((b) => ({ ...b, [r.id]: true }));
    try {
      const t = await runRoutineNow(r.id, view.deviceId);
      // The page moved to another machine while the run was starting. This
      // task belongs to the view that was showing, even if the reader has
      // since returned to the same machine.
      if (!isCurrentView(view)) return;
      setRuns((prev) => [t, ...prev].slice(0, 80));
      // The editor may be open on this routine; Run now should show up there
      // without waiting for the websocket echo (which the fold then dedupes).
      setHistory((prev) => {
        const folded = foldRoutineRun(prev[r.id], t);
        return folded ? { ...prev, [r.id]: folded } : prev;
      });
      pushToast(tr("routines.runStarted"), "info");
    } catch (e) {
      if (!isCurrentView(view)) return;
      pushToast(e instanceof Error ? e.message : tr("routines.actionFailed"), "error");
    } finally {
      if (isCurrentView(view)) setBusy((b) => ({ ...b, [r.id]: false }));
    }
  };

  const onMarkRead = async (taskId: string) => {
    const view = currentView();
    try {
      const t = await markRoutineRunRead(taskId, view.deviceId);
      if (!isCurrentView(view)) return;
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
    const view = currentView();
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
      if (historySeq.current[id] !== seq || !isCurrentView(view)) return;
      const allRead = readAllEpoch.current !== epoch;
      const read = knownRead.current;
      setHistoryHasMore((prev) => ({ ...prev, [id]: tasks.length >= ROUTINE_HISTORY_PAGE }));
      setHistoryCursor((prev) => ({ ...prev, [id]: pageCursor(tasks) }));
      setHistory((prev) => ({
        ...prev,
        [id]: reconcileRoutineReads(tasks, allRead, read),
      }));
    } catch (e) {
      if (historySeq.current[id] !== seq || !isCurrentView(view)) return;
      // A convenience: the editor works without it, but a failed fetch must
      // not read as "this routine has never run".
      setHistoryError((prev) => ({
        ...prev,
        [id]: e instanceof Error ? e.message : tr("routines.actionFailed"),
      }));
    } finally {
      if (historySeq.current[id] === seq && isCurrentView(view)) {
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
    const view = currentView();
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
      if (historySeq.current[id] !== seq || !isCurrentView(view)) return;
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
      if (!isCurrentView(view)) return;
      pushToast(e instanceof Error ? e.message : tr("routines.actionFailed"), "error");
    } finally {
      if (isCurrentView(view)) {
        setHistoryLoadingOlder((prev) => ({ ...prev, [id]: false }));
      }
    }
  };

  /** Point the run-history panel at one routine and load its first page. */
  const selectRoutine = (r: Routine) => {
    setSelectedId(r.id);
    if (!history[r.id] && !historyLoading[r.id] && !historyError[r.id]) {
      void loadHistory(r.id);
    }
  };

  const onMarkAllRead = async () => {
    const view = currentView();
    try {
      await markAllRoutineRunsRead(view.deviceId);
      if (!isCurrentView(view)) return;
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
      if (!isCurrentView(view)) return;
      pushToast(e instanceof Error ? e.message : tr("routines.actionFailed"), "error");
    }
  };

  const resetForm = () => {
    setTitle("");
    setPrompt("");
    setModel("");
    setConversationMode(DEFAULT_CONVERSATION_MODE);
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
    conversationMode,
    intervalSecs,
    rule: routineRule,
    ruleZone,
    nextRunLocal,
  });

  const draftKey = (draft: FormDraft): string => JSON.stringify(draft);

  const applyDraft = (draft: FormDraft) => {
    setTitle(draft.title);
    setPrompt(draft.prompt);
    setCwd(draft.cwd);
    setAgentId(draft.agentId);
    setModel(draft.model);
    setPermissionMode(draft.permissionMode);
    setConversationMode(draft.conversationMode);
    setIntervalSecs(draft.intervalSecs);
    setRoutineRule(draft.rule);
    setRuleZone(draft.ruleZone);
    setNextRunLocal(draft.nextRunLocal);
  };

  // The editor reports one patch per edit; each field still has its own state.
  const applyPatch = (patch: Partial<FormDraft>) => {
    if (patch.title !== undefined) setTitle(patch.title);
    if (patch.prompt !== undefined) setPrompt(patch.prompt);
    if (patch.cwd !== undefined) setCwd(patch.cwd);
    if (patch.agentId !== undefined) setAgentId(patch.agentId);
    if (patch.model !== undefined) setModel(patch.model);
    if (patch.permissionMode !== undefined) setPermissionMode(patch.permissionMode);
    if (patch.conversationMode !== undefined) setConversationMode(patch.conversationMode);
    if (patch.intervalSecs !== undefined) setIntervalSecs(patch.intervalSecs);
    if (patch.rule !== undefined) setRoutineRule(patch.rule);
    if (patch.ruleZone !== undefined) setRuleZone(patch.ruleZone);
    if (patch.nextRunLocal !== undefined) setNextRunLocal(patch.nextRunLocal);
  };

  /**
   * Close the form. A form with typed changes asks first — an accidental Esc
   * must not lose a prompt the reader just wrote. `force` is for the paths that
   * already decided: a successful save, or deleting the routine being edited.
   *
   * Returns false when the reader chose to stay.
   */
  const closeForm = (force = false): boolean => {
    const dirty = openDraftRef.current !== null && draftKey(formDraft()) !== openDraftRef.current;
    if (!force && dirty && !window.confirm(tr("routines.discardConfirm"))) return false;
    openDraftRef.current = null;
    setShowCreate(false);
    // The control that opened the form is still on the page; focus goes back to
    // it rather than to <body>. (For an edit that is the disclosure, not the
    // row: the row may be scrolled away by the time the save returns.)
    requestAnimationFrame(() => toggleRef.current?.focus());
    if (!editing) return true;
    // An edit borrowed the create form. Closing it puts back whatever the
    // reader had typed there — otherwise the next new routine would inherit
    // another routine's agent, directory, cadence and permissions.
    const draft = createDraftRef.current;
    createDraftRef.current = null;
    setEditing(null);
    if (draft) applyDraft(draft);
    return true;
  };

  const focusFormSoon = (scrollToForm: boolean) => {
    if (formFocusFrame.current !== null) cancelAnimationFrame(formFocusFrame.current);
    formFocusFrame.current = requestAnimationFrame(() => {
      formFocusFrame.current = null;
      const active = document.activeElement;
      if (scrollToForm) {
        const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
        formRef.current?.scrollIntoView?.({
          block: "start",
          behavior: reduce ? "auto" : "smooth",
        });
      }
      // Opening moves focus from the trigger to the first form field. If the
      // reader already chose another field in the meantime, keep their choice;
      // a late frame must not steal the caret halfway through the first word.
      if (
        !(active instanceof HTMLElement) ||
        active === document.body ||
        !formRef.current?.contains(active)
      ) {
        titleRef.current?.focus();
      }
    });
  };

  useEffect(
    () => () => {
      if (formFocusFrame.current !== null) cancelAnimationFrame(formFocusFrame.current);
    },
    [],
  );

  const formDirty =
    showCreate && openDraftRef.current !== null && draftKey(formDraft()) !== openDraftRef.current;

  // Leaving the screen (header back, edge swipe, palette) closes the form the
  // same way its own buttons do, so typed text is never dropped without the
  // page's confirm.
  useLeaveGuard(() => closeForm(), formDirty);

  const openCreate = () => {
    // Opening the create form from inside an edit first closes the edit, which
    // restores the draft the create form had before the edit borrowed it —
    // unless the reader chose to stay.
    const restored = editing ? createDraftRef.current : null;
    if (editing && !closeForm()) return;
    openDraftRef.current = draftKey(restored ?? formDraft());
    setShowCreate(true);
    focusFormSoon(false);
  };

  const openEdit = (r: Routine) => {
    // Keep the create draft the first time an edit takes the form over.
    if (!editing) createDraftRef.current = formDraft();
    const draft = routineForm(r);
    const next: FormDraft = {
      title: draft.title,
      prompt: draft.prompt,
      cwd: draft.cwd,
      agentId: draft.agent,
      model: draft.model,
      permissionMode: normalizePermissionMode(draft.permissionMode),
      conversationMode: draft.conversationMode,
      intervalSecs: draft.intervalSecs,
      rule: draft.rule,
      ruleZone: draft.ruleZone,
      nextRunLocal:
        draft.nextRunMs != null
          ? toLocalInputValue(new Date(draft.nextRunMs))
          : defaultNextRunLocal(),
    };
    setEditing(r);
    applyDraft(next);
    openDraftRef.current = draftKey(next);
    setShowCreate(true);
    setSelectedId(r.id);
    void loadHistory(r.id);
    // The row that opened this is below the fold: bring the form into view and
    // put the caret in it, rather than leaving focus on a button the reader can
    // no longer see. A reader who asked for less motion gets the jump.
    focusFormSoon(true);
  };

  const onSubmit = async () => {
    if (machineOffline) {
      pushToast(tr("routines.offlineBanner"), "error");
      return;
    }
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
        conversationMode,
        intervalSecs,
        rule: routineRule,
        nextRunMs: nextMs,
        ruleZone,
      });
      // Nothing to send is a valid save — the reader opened the form and closed
      // it again. It must not become an empty PATCH, and it must not touch the
      // schedule as a side effect of saving.
      if (!patch) {
        closeForm(true);
        return;
      }
      const view = currentView();
      setCreating(true);
      try {
        const updated = await patchRoutine(editing.id, patch, view.deviceId);
        if (!isCurrentView(view)) return;
        setRoutines((list) => list.map((x) => (x.id === updated.id ? updated : x)));
        closeForm(true);
        pushToast(tr("routines.saved"), "info");
      } catch (e) {
        if (!isCurrentView(view)) return;
        pushToast(e instanceof Error ? e.message : tr("routines.actionFailed"), "error");
      } finally {
        if (isCurrentView(view)) setCreating(false);
      }
      return;
    }
    const view = currentView();
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
          conversation_mode: conversationMode,
        },
        view.deviceId,
      );
      if (!isCurrentView(view)) return;
      setRoutines((list) => [r, ...list]);
      closeForm(true);
      resetForm();
      pushToast(tr("routines.created"), "info");
    } catch (e) {
      if (!isCurrentView(view)) return;
      pushToast(e instanceof Error ? e.message : tr("routines.actionFailed"), "error");
    } finally {
      if (isCurrentView(view)) setCreating(false);
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
    // The open form belongs to the machine being left. Ask before dropping it,
    // exactly as Esc does, rather than silently resetting the reader's words.
    if (showCreate && !closeForm()) return;
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
    // Mac keeps the machines the reader actually visited; phone replaces the
    // routines view so one Back still reaches the conversation list.
    writingURL.current = true;
    setSearchParams({ device: id }, { replace: isPhoneLayout() });
    // The sidebar badge counts the machine this page shows; a switch that did
    // not tell it would leave the old machine's number there.
    window.dispatchEvent(new Event("kin:routine-unread-changed"));
    setDeviceId(id);
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto kin-scroll">
      <div className="mx-auto max-w-5xl px-4 py-6 md:px-6">
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
              aria-controls={showCreate ? "routine-form" : undefined}
              disabled={creating || (machineOffline && !showCreate)}
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
              disabled={machineOffline}
              onClick={() => void onMarkAllRead()}
              className="min-h-11 flex-1 rounded-lg border border-[var(--kin-hairline)] px-3 text-body text-kin-secondary hover:bg-[var(--kin-fill)] disabled:opacity-50 md:flex-none"
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

        {machineOffline && (
          <div
            role="status"
            className="mt-3 rounded-xl border border-kin-orange/40 bg-kin-orange/10 px-4 py-3 text-body leading-5 text-kin-orange-ink"
          >
            {tr("routines.offlineBanner")}
          </div>
        )}

        {ownMachineRoutines && (
          <p className="mt-2 text-body text-kin-secondary">
            {tr("routines.ownMachineHasRoutines", {
              count: ownMachineRoutines.more
                ? `${ownMachineRoutines.count}+`
                : ownMachineRoutines.count,
            })}{" "}
            <button
              type="button"
              onClick={() => chooseMachine(THIS_MACHINE)}
              className="min-h-11 text-kin-blue-ink hover:underline sm:min-h-0"
            >
              {tr("routines.ownMachineView")}
            </button>
          </p>
        )}

        {showCreate && (
          <RoutineEditor
            value={formDraft()}
            editing={editing}
            onChange={applyPatch}
            onSubmit={() => void onSubmit()}
            onCancel={() => closeForm()}
            creating={creating}
            formLocked={formLocked}
            agents={availableAgents}
            models={modelsForAgent(machineAgents, agentId)}
            modelSource={modelAgent?.model_list_source}
            modelStatus={modelAgent?.model_list_status}
            deviceId={deviceId}
            nextRunPreview={rulePreviewAt}
            conversationHint={conversationHint}
            sectionRef={formRef}
            titleRef={titleRef}
          />
        )}

        {loading && (
          <div className="mt-8">
            <SlowConnectHint show={slow} />
            <div className="mt-4 h-24 animate-pulse rounded-2xl bg-[var(--kin-fill)]" />
          </div>
        )}

        {!loading && error && (
          <div className="mt-6 rounded-xl border border-kin-red/40 bg-kin-red/10 px-4 py-3 text-strong leading-5 text-kin-red-ink">
            <p>{error}</p>
            <button
              type="button"
              onClick={() => {
                setLoading(true);
                void load();
              }}
              className="mt-2 min-h-11 rounded-lg border border-kin-red/40 px-3 py-1 text-body text-kin-red-ink md:min-h-8"
            >
              {tr("routines.retry")}
            </button>
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
                      disabled={machineOffline || creating}
                      className="mt-4 rounded-lg bg-kin-blue px-3 py-1.5 text-strong font-medium text-kin-on-brand disabled:opacity-50"
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
                          device={remote ? deviceId : undefined}
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
                              device={remote ? deviceId : undefined}
                            />
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              )}
            </section>

            <div className="mt-10 md:grid md:grid-cols-[minmax(0,1fr)_340px] md:items-start md:gap-6">
              <RoutineList
                routines={routines}
                query={routineQuery}
                onQueryChange={setRoutineQuery}
                selectedId={selectedId}
                unreadByRoutine={unreadByRoutine}
                busy={busy}
                creating={creating}
                machineOffline={machineOffline}
                hasMore={routineHasMore}
                loadingMore={loadingMoreRoutines}
                onSelect={selectRoutine}
                onCreate={openCreate}
                onRunNow={(r) => void onRunNow(r)}
                onEdit={openEdit}
                onToggle={(r) => void onToggle(r)}
                onDelete={(r) => void onDelete(r)}
                onLoadMore={() => void loadMoreRoutines()}
                renderRowExtra={(r) =>
                  selectedId === r.id ? (
                    <div className="mt-3 md:hidden">
                      <RunHistoryPanel
                        routine={r}
                        runs={history[r.id] ?? []}
                        loading={!!historyLoading[r.id]}
                        error={historyError[r.id]}
                        hasMore={!!historyHasMore[r.id]}
                        loadingOlder={!!historyLoadingOlder[r.id]}
                        remote={remote}
                        device={remote ? deviceId : undefined}
                        onLoadOlder={() => void loadOlderHistory(r.id)}
                        onRetry={() => void loadHistory(r.id)}
                        onMarkRead={onMarkRead}
                        tr={tr}
                      />
                    </div>
                  ) : null
                }
                tr={tr}
              />
              <aside className="hidden md:sticky md:top-4 md:block">
                {selected ? (
                  <RunHistoryPanel
                    routine={selected}
                    runs={history[selected.id] ?? []}
                    loading={!!historyLoading[selected.id]}
                    error={historyError[selected.id]}
                    hasMore={!!historyHasMore[selected.id]}
                    loadingOlder={!!historyLoadingOlder[selected.id]}
                    remote={remote}
                    device={remote ? deviceId : undefined}
                    onLoadOlder={() => void loadOlderHistory(selected.id)}
                    onRetry={() => void loadHistory(selected.id)}
                    onMarkRead={onMarkRead}
                    tr={tr}
                  />
                ) : (
                  <p className="rounded-2xl border border-dashed border-[var(--kin-hairline-strong)] px-4 py-6 text-body text-kin-secondary">
                    {tr("routines.pickRoutine")}
                  </p>
                )}
              </aside>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
