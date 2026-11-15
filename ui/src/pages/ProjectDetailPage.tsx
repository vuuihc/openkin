import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { goBackToList } from "../lib/phoneBack";
import { useLeaveGuard } from "../hooks/useLeaveGuard";
import { runGuardedNavigation } from "../lib/leaveGuard";
import {
  draftEntryState,
  onGuardedLinkClick,
  phonePush,
  returnListUrl,
} from "../lib/phoneNavigation";
import {
  ApiError,
  getOnePager,
  getProject,
  getProjectPulse,
  isAuthenticated,
  listAgentSessions,
  listProjectTasks,
  listRoutines,
  patchProject,
  putOnePager,
  refreshProjectPulse,
  type OnePager,
  type OnePagerSummary,
  type Project,
  type ProjectMode,
  type ProjectPulse,
  type PulseDay,
  type Routine,
} from "../api/client";
import { IconBack, IconRoutines } from "../components/icons";
import Heatmap from "../components/project/Heatmap";
import ProjectActivity from "../components/project/ProjectActivity";
import ProjectCover, { NewChatControl } from "../components/project/ProjectCover";
import ProjectOnePager from "../components/project/ProjectOnePager";
import { SkeletonLine, SlowConnectHint } from "../components/Skeleton";
import { useMinWidth } from "../hooks/useMinWidth";
import { useSlowHint } from "../hooks/useSlowHint";
import { useMachines } from "../hooks/useMachines";
import { samePath } from "../lib/devices";
import { onePagerFocus, setOnePagerFocus } from "../lib/onePagerSummary";
import { clearProjectCover, readProjectCover, writeProjectCover } from "../lib/projectCoverCache";
import {
  loadProjectChats,
  projectNewChatTarget,
  projectRoots,
  type ProjectChatRow,
  type ProjectChatsOutcome,
} from "../lib/projectChats";
import { readProjectScroll, writeProjectScroll } from "../lib/projectScroll";
import { readRoutineDevice, routineDeviceForProject } from "../lib/routineDevice";
import { formatRelativeTime } from "../lib/relativeTime";
import { useT } from "../i18n/react";
import { useAppStore } from "../store/appStore";

/**
 * Project cover — the answer to "what happened here, and where do I continue".
 *
 * One surface, no tabs (KIN-PROJECT-001 D2): summary, recent activity, two
 * weeks of pulse and the project's routines — the routines read-only, because
 * scheduling belongs to /routines. The newest conversation is the only
 * conversation row; a second list would duplicate the sidebar's.
 *
 * The reads are independent on purpose: the project record owns the page, the
 * One-Pager owns the summary, the pulse owns the heatmaps, the activity feed
 * owns its one row, and routines own their card. One failing feed blanks its
 * own block, never the page.
 */

/** The heatmaps answer "lately", so two weeks, not a quarter. */
const PULSE_WINDOW_DAYS = 14;
const ROUTINES_SHOWN = 3;

export default function ProjectDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const tr = useT();
  const pushToast = useAppStore((s) => s.pushToast);
  const reconnectGen = useAppStore((s) => s.reconnectGen);
  const wsStatus = useAppStore((s) => s.wsStatus);
  const offline = wsStatus === "disconnected";
  const wide = useMinWidth(1024);
  const cardIds = useId();

  const [project, setProject] = useState<Project | null>(null);
  const [markdown, setMarkdown] = useState("");
  const [updatedAt, setUpdatedAt] = useState(0);
  const [summary, setSummary] = useState<OnePagerSummary | null>(null);
  const [lastLoadedAt, setLastLoadedAt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; notFound: boolean } | null>(null);

  const [onePagerLoaded, setOnePagerLoaded] = useState(false);
  const [onePagerLoading, setOnePagerLoading] = useState(true);
  const [onePagerError, setOnePagerError] = useState<string | null>(null);

  const [pulse, setPulse] = useState<ProjectPulse | null>(null);
  const [pulseFor, setPulseFor] = useState<string | null>(null);
  const [pulseLoading, setPulseLoading] = useState(true);
  const [pulseError, setPulseError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [routines, setRoutines] = useState<Routine[]>([]);
  const [routinesFor, setRoutinesFor] = useState<string | null>(null);
  const [routinesLoaded, setRoutinesLoaded] = useState(false);
  const [routinesLoading, setRoutinesLoading] = useState(true);
  const [routinesError, setRoutinesError] = useState<string | null>(null);

  const [latest, setLatest] = useState<ProjectChatRow | null>(null);
  const [lastImportAt, setLastImportAt] = useState<number | null>(null);
  const [activityFor, setActivityFor] = useState<string | null>(null);
  const [activityLoaded, setActivityLoaded] = useState(false);
  const [activityLoading, setActivityLoading] = useState(true);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [activityPartial, setActivityPartial] = useState(false);

  const [editing, setEditing] = useState(false);
  /** The One-Pager section owns the draft; the page owns the leave guard. */
  const [dirty, setDirty] = useState(false);
  /** The version the editor started from; a reconnect must not move it. */
  const [editBase, setEditBase] = useState({ markdown: "", updatedAt: 0 });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [conflict, setConflict] = useState<OnePager | null>(null);

  const [params, setParams] = useSearchParams();
  const projectRef = useRef<Project | null>(null);
  const coverRequest = useRef(0);
  const onePagerRequest = useRef(0);
  const routinesRequest = useRef(0);
  const activityRequest = useRef(0);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const scrollTopRef = useRef(0);
  const restoredFor = useRef<string | null>(null);
  const slow = useSlowHint(loading && !project);
  const { machines, loading: machinesLoading, failed: machinesFailed } = useMachines();
  const selfDeviceId = (machines.find((machine) => machine.isSelf)?.id ?? "").trim();
  const projectCwd = project && project.id === id ? (projectRoots(project)[0] ?? "") : "";
  const [routineDevice, routinesDeviceResolved] = useMemo((): [string, boolean] => {
    if (machinesLoading) return ["", false];
    if (machinesFailed) {
      // A failed list degrades to the Hub alone. Matching the project against
      // that fallback would confidently read the wrong machine's routines.
      // The routines page's remembered remote choice is the best surviving
      // evidence; with none, leave this card unresolved instead of guessing.
      const remembered = readRoutineDevice().trim();
      return [remembered, remembered.length > 0];
    }
    return [routineDeviceForProject(machines, projectCwd, readRoutineDevice()), true];
  }, [machines, machinesFailed, machinesLoading, projectCwd]);

  // The old ?tab= links predate the signed cover. They land on the cover and
  // the address bar stops claiming a view that no longer exists.
  useEffect(() => {
    if (!params.has("tab")) return;
    const next = new URLSearchParams(params);
    next.delete("tab");
    setParams(next, { replace: true });
  }, [params, setParams]);

  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  // Whatever opened the cover — the sidebar project title, usually — gets
  // focus back when the reader leaves (contract step 6). The element may not
  // exist after a route unmount, so `goBack` also falls back to the project's
  // title button by name.
  useEffect(() => {
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      active !== document.body &&
      active !== document.documentElement
    ) {
      openerRef.current = active;
    }
  }, [id]);

  // Another project means a different cover, not the previous one under a new
  // URL. Every request generation is bumped so an answer for the old route
  // cannot install itself here; the cached cover, if any, paints first.
  useEffect(() => {
    coverRequest.current += 1;
    onePagerRequest.current += 1;
    routinesRequest.current += 1;
    activityRequest.current += 1;
    setError(null);
    setEditing(false);
    setConflict(null);
    setSaved(false);
    setEditBase({ markdown: "", updatedAt: 0 });
    setMarkdown("");
    setUpdatedAt(0);
    setSummary(null);
    setOnePagerLoaded(false);
    setOnePagerLoading(true);
    setOnePagerError(null);
    setPulse(null);
    setPulseFor(null);
    setPulseError(null);
    setRoutines([]);
    setRoutinesFor(null);
    setRoutinesLoaded(false);
    setRoutinesError(null);
    setLatest(null);
    setLastImportAt(null);
    setActivityFor(null);
    setActivityLoaded(false);
    setActivityError(null);
    setActivityPartial(false);

    const cached = id ? readProjectCover(id) : null;
    if (!cached) {
      setProject(null);
      setLastLoadedAt(0);
      return;
    }
    setProject(cached.project);
    setLastLoadedAt(cached.savedAt);
    setPulse(cached.pulse);
    if (cached.pulse) setPulseFor(id);
    // Only a read that actually answered is replayed. A cached "empty" from a
    // half-finished first visit is a gap, not an answer.
    if (cached.routinesLoaded) {
      setRoutines(cached.routines);
      setRoutinesFor(id);
      setRoutinesLoaded(true);
    }
    if (cached.activityLoaded) {
      setLatest(cached.latest);
      setLastImportAt(cached.lastImportAt);
      setActivityFor(id);
      setActivityLoaded(true);
    }
  }, [id]);

  const loadProject = useCallback(async () => {
    if (!isAuthenticated() || !id) return;
    const gen = ++coverRequest.current;
    setLoading(true);
    try {
      const p = await getProject(id);
      if (gen !== coverRequest.current) return;
      setProject(p);
      setLastLoadedAt(Date.now());
      setError(null);
    } catch (e) {
      if (gen !== coverRequest.current) return;
      if (e instanceof ApiError && e.status === 401) return;
      if (e instanceof ApiError && e.status === 404) {
        // The record is gone, so the cached cover is wrong now. This is the
        // only read allowed to say "project not found"; a missing One-Pager
        // is a summary state, not a missing project.
        clearProjectCover(id);
        setProject(null);
        setError({ message: tr("projects.notFound"), notFound: true });
        return;
      }
      const message = e instanceof Error && e.message ? e.message : tr("projects.loadFailed");
      // A reload that fails keeps the cover that is already on screen: an
      // offline visit should still show the last result, not an empty page.
      if (projectRef.current?.id === id) pushToast(message, "error");
      else setError({ message, notFound: false });
    } finally {
      if (gen === coverRequest.current) setLoading(false);
    }
  }, [id, tr, pushToast]);

  const loadOnePager = useCallback(async () => {
    if (!isAuthenticated() || !id) return;
    const gen = ++onePagerRequest.current;
    setOnePagerLoading(true);
    setOnePagerError(null);
    try {
      const op = await getOnePager(id);
      if (gen !== onePagerRequest.current) return;
      setMarkdown(op.markdown);
      setUpdatedAt(op.updated_at);
      setSummary(op.one_pager_summary ?? null);
      setOnePagerLoaded(true);
    } catch (e) {
      if (gen !== onePagerRequest.current) return;
      if (e instanceof ApiError && e.status === 401) return;
      if (e instanceof ApiError && e.status === 404) {
        // No One-Pager file yet: an empty, editable summary, not an error.
        setMarkdown("");
        setUpdatedAt(0);
        setSummary(null);
        setOnePagerLoaded(true);
        return;
      }
      setOnePagerError(tr("projects.summaryLoadFailed"));
    } finally {
      if (gen === onePagerRequest.current) setOnePagerLoading(false);
    }
  }, [id, tr]);

  useEffect(() => {
    void loadProject();
  }, [loadProject, reconnectGen]);

  useEffect(() => {
    void loadOnePager();
  }, [loadOnePager, reconnectGen]);

  useEffect(() => {
    if (!id || !isAuthenticated()) return;
    let cancelled = false;
    setPulseLoading(true);
    setPulseError(null);
    getProjectPulse(id, PULSE_WINDOW_DAYS)
      .then((next) => {
        if (!cancelled) {
          setPulse(next);
          setPulseFor(id);
        }
      })
      .catch(() => {
        // The previous pulse stays: "showing the last result" is the offline
        // contract, and the heatmaps are read-only history either way.
        if (!cancelled) setPulseError(tr("projects.overviewUnavailable"));
      })
      .finally(() => {
        if (!cancelled) setPulseLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, reconnectGen, tr]);

  const loadRoutines = useCallback(async () => {
    if (!id || !projectCwd || machinesLoading || !isAuthenticated()) return;
    const gen = ++routinesRequest.current;
    if (!routinesDeviceResolved) {
      setRoutines([]);
      setRoutinesFor(id);
      setRoutinesLoaded(true);
      setRoutinesLoading(false);
      setRoutinesError(tr("projects.routinesLoadFailed"));
      return;
    }
    setRoutinesLoading(true);
    setRoutinesError(null);
    try {
      const page = await listRoutines({ limit: 100 }, routineDevice || undefined);
      if (gen !== routinesRequest.current) return;
      setRoutines((page.routines ?? []).filter((routine) => samePath(routine.cwd, projectCwd)));
      setRoutinesFor(id);
      setRoutinesLoaded(true);
    } catch {
      if (gen === routinesRequest.current) setRoutinesError(tr("projects.routinesLoadFailed"));
    } finally {
      if (gen === routinesRequest.current) setRoutinesLoading(false);
    }
  }, [id, machinesLoading, projectCwd, routineDevice, routinesDeviceResolved, tr]);

  useEffect(() => {
    void loadRoutines();
  }, [loadRoutines, reconnectGen]);

  const loadActivity = useCallback(
    async (target: Project) => {
      const projectId = target.id;
      const gen = ++activityRequest.current;
      setActivityLoading(true);
      setActivityError(null);
      setActivityPartial(false);
      let outcome: ProjectChatsOutcome | null = null;
      try {
        outcome = await loadProjectChats({
          projectId,
          roots: projectRoots(target),
          feed: {
            tasks: () => listProjectTasks(projectId, 50),
            sessions: (root) => listAgentSessions({ cwd: root, limit: 50 }),
          },
          copy: { untitled: tr("sessions.untitled"), loadFailed: tr("projects.loadFailed") },
          selfDeviceId,
          limit: 1,
          isCurrent: () => gen === activityRequest.current,
        });
      } catch {
        if (gen === activityRequest.current) {
          // Keep the row that is already on screen; a reload failure is not a
          // reason to forget the last answer.
          setActivityFor(projectId);
          setActivityPartial(false);
          setActivityError(tr("projects.activityFailed"));
        }
      } finally {
        if (gen === activityRequest.current) setActivityLoading(false);
      }
      if (!outcome) return;
      setActivityFor(outcome.projectId);
      setActivityPartial(outcome.partial);
      setActivityError(outcome.error ? tr("projects.activityFailed") : null);
      // A failed read says so; it does not erase the last row and its time.
      // A successful empty read is the only thing that means "no conversations".
      if (!outcome.error) {
        setLatest(outcome.rows[0] ?? null);
        setLastImportAt(outcome.lastImportAt);
        setActivityLoaded(true);
      }
    },
    [tr, selfDeviceId],
  );

  // A cover read for another route's project is not this route's answer.
  const currentProject = project && project.id === id ? project : null;

  useEffect(() => {
    if (!currentProject) return;
    void loadActivity(currentProject);
    // A reconnect re-reads the row even when the project record came back
    // unchanged; the conversation may have moved while the socket was down.
  }, [currentProject, loadActivity, reconnectGen]);

  const contentReady = !pulseLoading && !routinesLoading && !activityLoading;

  // What the reader last saw, kept for the next visit — including an offline
  // one. The daemon remains the source of truth; this is the first paint. It
  // writes only once every block has settled, so a visit interrupted halfway
  // cannot cache "no routines" or "no conversations" as if it were an answer.
  useEffect(() => {
    if (!currentProject || !contentReady) return;
    const routinesCurrent = routinesFor === currentProject.id;
    const activityCurrent = activityFor === currentProject.id;
    writeProjectCover(currentProject.id, {
      project: currentProject,
      pulse: pulseFor === currentProject.id ? pulse : null,
      routines: routinesCurrent ? routines : [],
      routinesLoaded: routinesCurrent && routinesLoaded,
      latest: activityCurrent ? latest : null,
      lastImportAt: activityCurrent ? lastImportAt : null,
      activityLoaded: activityCurrent && activityLoaded,
      savedAt: lastLoadedAt || Date.now(),
    });
  }, [
    currentProject,
    contentReady,
    pulse,
    pulseFor,
    routines,
    routinesFor,
    routinesLoaded,
    latest,
    lastImportAt,
    activityFor,
    activityLoaded,
    lastLoadedAt,
  ]);

  // The page unmounts when a conversation opens; the reader's place in it
  // should not.
  useEffect(() => {
    const projectId = id;
    scrollTopRef.current = 0;
    restoredFor.current = null;
    return () => {
      if (projectId) writeProjectScroll(projectId, scrollTopRef.current);
    };
  }, [id]);

  // Restoring before the pulse, routines and activity have settled applies the
  // saved offset to a short skeleton, where it clamps to the bottom — and that
  // clamped value is what the next visit remembers. Wait for the blocks, then
  // retry briefly while their real heights land.
  useEffect(() => {
    if (!currentProject || loading || !contentReady) return;
    const projectId = currentProject.id;
    if (restoredFor.current === projectId) return;
    const saved = readProjectScroll(projectId);
    if (saved <= 0) {
      restoredFor.current = projectId;
      return;
    }
    const el = scrollerRef.current;
    if (!el) return;
    if (typeof requestAnimationFrame !== "function") {
      el.scrollTop = saved;
      scrollTopRef.current = saved;
      restoredFor.current = projectId;
      return;
    }
    let frames = 0;
    let raf = 0;
    const apply = () => {
      const target = scrollerRef.current;
      if (!target) return;
      target.scrollTop = saved;
      if (target.scrollTop >= saved) {
        scrollTopRef.current = saved;
        restoredFor.current = projectId;
        return;
      }
      if (frames >= 12) return;
      frames += 1;
      raf = requestAnimationFrame(apply);
    };
    raf = requestAnimationFrame(apply);
    return () => cancelAnimationFrame(raf);
  }, [currentProject, loading, contentReady]);

  const summaryText = onePagerLoaded
    ? summary
      ? (summary.focus ?? "")
      : onePagerFocus(markdown)
    : "";

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const canLeave = useCallback(() => {
    if (!dirty) return true;
    return typeof window.confirm === "function"
      ? window.confirm(tr("projects.summaryDiscard"))
      : true;
  }, [dirty, tr]);

  useLeaveGuard(canLeave, dirty);

  const goBack = useCallback(() => {
    if (!canLeave()) return;
    const opener = openerRef.current;
    const name = projectRef.current?.name;
    const restoreFocus = () => {
      const run = () => {
        if (opener?.isConnected) {
          opener.focus();
          return;
        }
        if (!name) return;
        const buttons = Array.from(document.querySelectorAll<HTMLElement>("button[aria-label]"));
        buttons.find((button) => button.getAttribute("aria-label") === name)?.focus();
      };
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => requestAnimationFrame(run));
      } else {
        run();
      }
    };
    goBackToList(navigate);
    restoreFocus();
  }, [canLeave, navigate]);

  const applyOnePager = (op: OnePager) => {
    setMarkdown(op.markdown);
    setUpdatedAt(op.updated_at);
    setSummary(op.one_pager_summary ?? null);
  };

  const saveSummary = async (base: string, baseUpdatedAt: number, body: string) => {
    if (!id) return;
    setSaving(true);
    setSaved(false);
    try {
      const op = await putOnePager(id, setOnePagerFocus(base, body), baseUpdatedAt || undefined);
      applyOnePager(op);
      setConflict(null);
      setSaved(true);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        try {
          const theirs = await getOnePager(id);
          setConflict(theirs);
        } catch {
          pushToast(tr("projects.conflict"), "error");
        }
      } else {
        pushToast(e instanceof Error ? e.message : tr("projects.saveFailed"), "error");
      }
    } finally {
      setSaving(false);
    }
  };

  // The base is the version the editor opened, not whatever a reconnect has
  // since read. Saving against the newer version would overwrite another
  // device's line without the conflict the contract promises.
  const onSave = (body: string) => void saveSummary(editBase.markdown, editBase.updatedAt, body);

  const onTakeTheirs = () => {
    if (!conflict) return;
    applyOnePager(conflict);
    setConflict(null);
    setSaved(false);
  };

  const onKeepMine = (body: string) => {
    if (!conflict) return;
    // Compose on their document, not the stale one, so choosing "overwrite"
    // overwrites the focus line and leaves their other edits intact.
    void saveSummary(conflict.markdown, conflict.updated_at, body);
  };

  const onBeginEdit = useCallback(() => {
    setEditBase({ markdown, updatedAt });
    setSaved(false);
    setConflict(null);
  }, [markdown, updatedAt]);

  const onEditingChange = useCallback((next: boolean) => setEditing(next), []);
  const onDirtyChange = useCallback((next: boolean) => setDirty(next), []);
  const onDismissConflict = () => {
    setConflict(null);
    setSaved(false);
  };

  const onModeChange = async (mode: ProjectMode) => {
    if (!id) return;
    try {
      const p = await patchProject(id, { mode });
      setProject(p);
    } catch (e) {
      pushToast(e instanceof Error ? e.message : tr("projects.modeSaveFailed"), "error");
    }
  };

  const onRefreshPulse = async () => {
    if (!id) return;
    setRefreshing(true);
    try {
      const res = await refreshProjectPulse(id, {
        window_days: PULSE_WINDOW_DAYS,
        write: true,
      });
      setPulse(res.pulse);
      setPulseFor(id);
      setPulseError(null);
      setMarkdown(res.markdown);
      setUpdatedAt(res.updated_at);
      setSummary((prev) => (prev ? { ...prev, focus: onePagerFocus(res.markdown) } : prev));
      pushToast(tr("projects.refreshed"));
    } catch (e) {
      pushToast(e instanceof Error ? e.message : tr("projects.refreshFailed"), "error");
    } finally {
      setRefreshing(false);
    }
  };

  const openChat = (row: ProjectChatRow) => {
    const to = row.task
      ? `/tasks/${encodeURIComponent(row.task.id)}`
      : row.session
        ? `/agent-sessions/${encodeURIComponent(row.session.id)}`
        : "";
    if (!to) return;
    runGuardedNavigation(() => phonePush(navigate, location, to));
  };

  const roots = currentProject ? projectRoots(currentProject) : [];
  const newChat = currentProject
    ? projectNewChatTarget(currentProject)
    : ({ kind: "no-root" } as const);
  const anyAvailableAgent = machines.some(
    (machine) => machine.online && machine.agents.some((agent) => agent.available),
  );
  const noAgent = machines.length > 0 && !machinesLoading && !anyAvailableAgent;
  const newChatReason = offline
    ? tr("projects.newChatOffline")
    : newChat.kind === "no-root"
      ? tr("projects.continueNeedRoot")
      : noAgent
        ? tr("projects.newChatNoAgent")
        : "";
  const newChatDisabled = Boolean(newChatReason);
  const newChatHref = newChat.kind === "no-root" ? null : newChat.href;
  const canStartChat = !newChatDisabled && Boolean(newChatHref);
  const startChat = useCallback(() => {
    if (!newChatHref) return;
    runGuardedNavigation(() =>
      phonePush(navigate, location, newChatHref, {
        state: draftEntryState(returnListUrl(location)),
      }),
    );
  }, [location, navigate, newChatHref]);

  // The cover owns the window keys, so mount it headless on the two screens
  // that paint no cover: Escape is the only way back from either.
  const keys = (
    <ProjectCover
      project={null}
      now={0}
      canStartChat={canStartChat}
      onBack={goBack}
      onModeChange={() => {}}
      onStartChat={startChat}
    />
  );

  if (!currentProject) {
    if (error) {
      return (
        <div className="flex-1 min-h-0 overflow-y-auto kin-scroll">
          {keys}
          <div className="mx-auto max-w-5xl px-4 py-6">
            <button
              type="button"
              className="mb-4 inline-flex items-center gap-1 text-strong text-kin-secondary hover:text-kin-text"
              onClick={goBack}
            >
              <IconBack size={14} />
              {tr("projects.back")}
            </button>
            <div
              role="alert"
              className="rounded-lg border border-kin-red/30 bg-kin-red/10 px-3 py-2 text-strong text-kin-red-ink"
            >
              {error.message}
            </div>
            {!error.notFound && (
              <button
                type="button"
                onClick={() => void loadProject()}
                className="mt-3 min-h-11 rounded-lg border border-kin-hairline px-3 text-strong text-kin-text hover:bg-[var(--kin-fill-strong)]"
              >
                {tr("common.retry")}
              </button>
            )}
          </div>
        </div>
      );
    }
    return (
      <div className="flex-1 min-h-0 overflow-y-auto kin-scroll">
        {keys}
        <div className="mx-auto max-w-5xl px-4 py-6 space-y-3">
          {slow && <SlowConnectHint show />}
          <SkeletonLine />
          <SkeletonLine />
          <SkeletonLine />
        </div>
      </div>
    );
  }

  const activity = activityFor === currentProject.id ? latest : null;
  const importAt = activityFor === currentProject.id ? lastImportAt : null;
  const activityPartialShown = activityFor === currentProject.id && activityPartial;
  const shownRoutines = routinesFor === currentProject.id ? routines : [];
  // "What runs next" is the useful order on a cover, not storage order.
  const nextRoutines = [...shownRoutines]
    .sort((a, b) => (a.next_due_at || 0) - (b.next_due_at || 0))
    .slice(0, ROUTINES_SHOWN);
  const visiblePulse = pulseFor === currentProject.id ? pulse : null;
  const pulseTotal = visiblePulse
    ? [...(visiblePulse.session_heat ?? []), ...(visiblePulse.commit_heat ?? [])].reduce(
        (sum, day) => sum + day.count,
        0,
      )
    : 0;
  const lastCommit = lastCommitAt(visiblePulse);
  const now = Date.now();

  const newChatControl = (
    <NewChatControl
      href={newChatHref}
      disabledReason={newChatDisabled ? newChatReason : ""}
      fullWidth={!wide}
    />
  );

  return (
    <div
      ref={scrollerRef}
      data-testid="project-scroll"
      className="flex-1 min-h-0 overflow-y-auto kin-scroll"
      onScroll={(event) => {
        scrollTopRef.current = event.currentTarget.scrollTop;
      }}
    >
      <div className="mx-auto max-w-5xl px-4 py-6 pb-24">
        <ProjectCover
          project={currentProject}
          root={roots[0] ?? ""}
          offline={offline}
          lastLoadedAt={lastLoadedAt}
          now={now}
          editing={editing}
          canStartChat={canStartChat}
          onBack={goBack}
          onModeChange={(mode) => void onModeChange(mode)}
          onStartChat={startChat}
        />

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-4">
            <ProjectOnePager
              key={currentProject.id}
              titleId={`${cardIds}-summary`}
              loaded={onePagerLoaded}
              loading={onePagerLoading}
              loadError={onePagerError}
              summaryText={summaryText}
              saving={saving}
              saved={saved}
              conflict={conflict}
              offline={offline}
              onRetry={() => void loadOnePager()}
              onSave={onSave}
              onBeginEdit={onBeginEdit}
              onKeepMine={onKeepMine}
              onTakeTheirs={onTakeTheirs}
              onDismissConflict={onDismissConflict}
              onEditingChange={onEditingChange}
              onDirtyChange={onDirtyChange}
            />

            <ProjectActivity
              titleId={`${cardIds}-recent`}
              activity={activity}
              loading={activityLoading}
              ready={activityFor === currentProject.id}
              error={activityError}
              partial={activityPartialShown}
              lastCommit={lastCommit}
              importAt={importAt}
              windowDays={PULSE_WINDOW_DAYS}
              now={now}
              onRetry={() => void loadActivity(currentProject)}
              onOpen={openChat}
              continueControl={newChatControl}
              showContinue={wide}
            />
          </div>

          <div className="space-y-4">
            <section aria-labelledby={`${cardIds}-pulse`} className="rounded-xl bg-kin-panel p-4">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h2
                  id={`${cardIds}-pulse`}
                  className="text-body font-medium uppercase tracking-label text-kin-secondary"
                >
                  {tr("projects.overviewWindow")}
                </h2>
                <button
                  type="button"
                  disabled={refreshing || offline}
                  className="rounded-lg border border-kin-hairline px-2.5 py-1 text-body text-kin-text hover:bg-[var(--kin-fill-strong)] disabled:opacity-50"
                  onClick={() => void onRefreshPulse()}
                >
                  {refreshing ? tr("projects.refreshing") : tr("projects.refresh")}
                </button>
              </div>

              {pulseError && (
                <div
                  role="alert"
                  className="mb-3 rounded-lg border border-kin-red/30 bg-kin-red/10 px-3 py-2 text-body text-kin-red-ink"
                >
                  <p>{pulseError}</p>
                  {visiblePulse && (
                    <p className="mt-1 text-caption">
                      {tr("projects.overviewStale", {
                        time: formatRelativeTime(visiblePulse.generated_at, now),
                      })}
                    </p>
                  )}
                  <button
                    type="button"
                    disabled={refreshing || offline}
                    onClick={() => void onRefreshPulse()}
                    className="mt-2 min-h-11 rounded-lg border border-kin-red/40 px-3 text-strong text-kin-red-ink disabled:opacity-50"
                  >
                    {tr("projects.refresh")}
                  </button>
                </div>
              )}

              {visiblePulse ? (
                pulseTotal === 0 ? (
                  <p className="text-body text-kin-secondary">{tr("projects.overviewEmpty")}</p>
                ) : (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Heatmap
                      days={visiblePulse.session_heat}
                      title={tr("projects.sessionHeat")}
                      max={PULSE_WINDOW_DAYS}
                    />
                    <Heatmap
                      days={visiblePulse.commit_heat}
                      title={tr("projects.commitHeat")}
                      max={PULSE_WINDOW_DAYS}
                    />
                  </div>
                )
              ) : pulseLoading || (pulseFor !== currentProject.id && !pulseError) ? (
                <div className="space-y-3 py-2">
                  <SkeletonLine />
                  <SkeletonLine />
                </div>
              ) : null}
            </section>

            <section
              aria-labelledby={`${cardIds}-routines`}
              className="rounded-xl bg-kin-panel p-4"
            >
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h2
                  id={`${cardIds}-routines`}
                  className="flex items-center gap-1.5 text-body font-medium uppercase tracking-label text-kin-secondary"
                >
                  <IconRoutines size={13} />
                  {tr("projects.routinesTitle")}
                </h2>
                {routinesDeviceResolved ? (
                  <Link
                    to={
                      routineDevice
                        ? `/routines?device=${encodeURIComponent(routineDevice)}`
                        : "/routines"
                    }
                    onClick={(event) =>
                      onGuardedLinkClick(
                        event,
                        navigate,
                        location,
                        routineDevice
                          ? `/routines?device=${encodeURIComponent(routineDevice)}`
                          : "/routines",
                      )
                    }
                    className="inline-flex min-h-11 items-center gap-1 text-body text-kin-secondary hover:text-kin-text"
                  >
                    {tr("projects.openRoutines")}
                    <span aria-hidden>→</span>
                  </Link>
                ) : null}
              </div>

              {routinesError && (
                <div
                  role="alert"
                  className="mb-3 rounded-lg border border-kin-red/30 bg-kin-red/10 px-3 py-2 text-body text-kin-red-ink"
                >
                  <p>{routinesError}</p>
                  <button
                    type="button"
                    onClick={() => void loadRoutines()}
                    className="mt-2 min-h-11 rounded-lg border border-kin-red/40 px-3 text-strong text-kin-red-ink"
                  >
                    {tr("common.retry")}
                  </button>
                </div>
              )}

              {(routinesLoading || routinesFor !== currentProject.id) &&
              shownRoutines.length === 0 &&
              !routinesError ? (
                <div className="space-y-2 py-1">
                  <SkeletonLine />
                  <SkeletonLine />
                </div>
              ) : shownRoutines.length === 0 ? (
                !routinesError && (
                  <p className="text-body text-kin-secondary">{tr("projects.routinesEmpty")}</p>
                )
              ) : (
                <ul className="space-y-1.5">
                  {nextRoutines.map((routine) => (
                    <li key={routine.id} className="text-body text-kin-text">
                      <span className="font-medium">{routine.title}</span>
                      <span className="text-kin-muted">
                        {tr("common.labelSeparator")}
                        {routine.enabled && routine.next_due_at > 0
                          ? tr("projects.routineNext", {
                              time: formatRelativeTime(routine.next_due_at, now),
                            })
                          : tr("routines.paused")}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              <p className="mt-2 text-caption text-kin-muted">{tr("projects.routinesHint")}</p>
            </section>
          </div>
        </div>

        {!wide && <div className="mt-4">{newChatControl}</div>}
      </div>
    </div>
  );
}

/** The latest day with a commit inside the pulse window, as epoch ms. */
export function lastCommitAt(pulse: ProjectPulse | null): number | null {
  const days: PulseDay[] | undefined = pulse?.commit_heat;
  if (!days?.length) return null;
  for (let i = days.length - 1; i >= 0; i--) {
    const day = days[i];
    if (day.count <= 0) continue;
    const [year, month, date] = day.date.split("-").map(Number);
    if (!year || !month || !date) return null;
    // The day's own clock, not noon: a commit seen before noon must not read
    // as a future time, and the heat only knows the day.
    return Math.min(new Date(year, month - 1, date).getTime(), Date.now());
  }
  return null;
}
