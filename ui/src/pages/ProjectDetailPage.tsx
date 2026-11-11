import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
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
import { IconBack, IconMachine, IconRoutines } from "../components/icons";
import SearchSelect from "../components/ui/SearchSelect";
import Heatmap from "../components/project/Heatmap";
import { SkeletonLine, SlowConnectHint } from "../components/Skeleton";
import { useMinWidth } from "../hooks/useMinWidth";
import { useSlowHint } from "../hooks/useSlowHint";
import { useMachines } from "../hooks/useMachines";
import { agentAvatarMeta, agentDisplayName } from "../lib/agentMention";
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
import { formatRelativeTime } from "../lib/relativeTime";
import { sessionStatusDotClass } from "../lib/sessionViewed";
import { taskCardStatusView } from "../lib/taskCardStatus";
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
  const [draft, setDraft] = useState("");
  /** The version the editor started from; a reconnect must not move it. */
  const [editBase, setEditBase] = useState({ markdown: "", updatedAt: 0 });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [conflict, setConflict] = useState<OnePager | null>(null);

  const [params, setParams] = useSearchParams();
  const projectRef = useRef<Project | null>(null);
  const editingRef = useRef(false);
  const coverRequest = useRef(0);
  const onePagerRequest = useRef(0);
  const routinesRequest = useRef(0);
  const activityRequest = useRef(0);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const summaryFieldRef = useRef<HTMLTextAreaElement | null>(null);
  const editButtonRef = useRef<HTMLButtonElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const scrollTopRef = useRef(0);
  const restoredFor = useRef<string | null>(null);
  const slow = useSlowHint(loading && !project);
  const { machines, loading: machinesLoading } = useMachines();
  const selfDeviceId = (machines.find((machine) => machine.isSelf)?.id ?? "").trim();

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

  useEffect(() => {
    editingRef.current = editing;
  }, [editing]);

  // Whatever opened the cover — the sidebar project title, usually — gets
  // focus back when the reader leaves (contract step 6). The element may not
  // exist after a route unmount, so `goBack` also falls back to the project's
  // title button by name.
  useEffect(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && active !== document.documentElement) {
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
    setDraft("");
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
      // A reconnect must not throw away a line the reader is still typing.
      if (!editingRef.current) {
        setDraft(op.one_pager_summary?.focus ?? onePagerFocus(op.markdown));
      }
      setOnePagerLoaded(true);
    } catch (e) {
      if (gen !== onePagerRequest.current) return;
      if (e instanceof ApiError && e.status === 401) return;
      if (e instanceof ApiError && e.status === 404) {
        // No One-Pager file yet: an empty, editable summary, not an error.
        setMarkdown("");
        setUpdatedAt(0);
        setSummary(null);
        if (!editingRef.current) setDraft("");
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
    if (!id || !isAuthenticated()) return;
    const gen = ++routinesRequest.current;
    setRoutinesLoading(true);
    setRoutinesError(null);
    try {
      const page = await listRoutines({ project_id: id, limit: 50 });
      if (gen !== routinesRequest.current) return;
      setRoutines(page.routines ?? []);
      setRoutinesFor(id);
      setRoutinesLoaded(true);
    } catch {
      if (gen === routinesRequest.current) setRoutinesError(tr("projects.routinesLoadFailed"));
    } finally {
      if (gen === routinesRequest.current) setRoutinesLoading(false);
    }
  }, [id, tr]);

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
  const dirty = editing && draft.trim() !== summaryText.trim();

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
    // `history.length` counts entries from other sites too, so on a cold launch
    // it says "there is somewhere to go back to" and leaves the app. The
    // router's own index is 0 when this document has no in-app entry behind it.
    if ((window.history.state?.idx ?? 0) > 0) navigate(-1);
    else navigate("/sessions");
    restoreFocus();
  }, [canLeave, navigate]);

  const applyOnePager = (op: OnePager) => {
    setMarkdown(op.markdown);
    setUpdatedAt(op.updated_at);
    setSummary(op.one_pager_summary ?? null);
    setDraft(op.one_pager_summary?.focus ?? onePagerFocus(op.markdown));
  };

  const focusEditButton = () => {
    const focus = () => editButtonRef.current?.focus();
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(focus);
    else focus();
  };

  const saveSummary = async (base: string, baseUpdatedAt: number) => {
    if (!id) return;
    setSaving(true);
    setSaved(false);
    try {
      const op = await putOnePager(id, setOnePagerFocus(base, draft), baseUpdatedAt || undefined);
      applyOnePager(op);
      setEditing(false);
      setConflict(null);
      setSaved(true);
      focusEditButton();
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
  const onSave = () => void saveSummary(editBase.markdown, editBase.updatedAt);

  const onTakeTheirs = () => {
    if (!conflict) return;
    applyOnePager(conflict);
    setEditing(false);
    setConflict(null);
    setSaved(false);
    focusEditButton();
  };

  const onKeepMine = () => {
    if (!conflict) return;
    // Compose on their document, not the stale one, so choosing "overwrite"
    // overwrites the focus line and leaves their other edits intact.
    void saveSummary(conflict.markdown, conflict.updated_at);
  };

  const beginEdit = () => {
    setDraft(summaryText);
    setEditBase({ markdown, updatedAt });
    setEditing(true);
    setSaved(false);
    setConflict(null);
  };

  const cancelEdit = () => {
    setDraft(summaryText);
    setEditing(false);
    setConflict(null);
    setSaved(false);
    focusEditButton();
  };

  useEffect(() => {
    if (!editing) return;
    const field = summaryFieldRef.current;
    if (!field) return;
    field.focus();
    const end = field.value.length;
    try {
      field.setSelectionRange(end, end);
    } catch {
      // Some browsers refuse selection on a hidden field; focus is enough.
    }
  }, [editing]);

  const onSummaryKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      if (!saving && !offline) onSave();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancelEdit();
    }
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
      if (!editingRef.current) setDraft(onePagerFocus(res.markdown));
      pushToast(tr("projects.refreshed"));
    } catch (e) {
      pushToast(e instanceof Error ? e.message : tr("projects.refreshFailed"), "error");
    } finally {
      setRefreshing(false);
    }
  };

  const openChat = (row: ProjectChatRow) => {
    if (!canLeave()) return;
    if (row.task) navigate(`/tasks/${encodeURIComponent(row.task.id)}`);
    else if (row.session) navigate(`/agent-sessions/${encodeURIComponent(row.session.id)}`);
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

  // Esc goes back and ⌘Enter starts a chat from anywhere on the cover, not
  // only while a particular control has focus. Typing fields and open pickers
  // keep their own keys.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const typing = Boolean(
        target &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.tagName === "SELECT" ||
            target.isContentEditable),
      );
      if (event.key === "Escape") {
        if (editing || typing) return;
        // A picker or sheet owns Escape while it is open; leaving the project
        // because the reader closed a menu is not the same key press.
        if (document.querySelector('[role="listbox"], [role="dialog"]')) return;
        event.preventDefault();
        goBack();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        if (editing || typing || newChatDisabled || !newChatHref) return;
        if (!canLeave()) return;
        event.preventDefault();
        navigate(newChatHref);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editing, goBack, canLeave, navigate, newChatDisabled, newChatHref]);

  if (!currentProject) {
    if (error) {
      return (
        <div className="flex-1 min-h-0 overflow-y-auto kin-scroll">
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
      onBeforeNavigate={canLeave}
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
        <button
          type="button"
          className="mb-3 inline-flex items-center gap-1 text-strong text-kin-secondary hover:text-kin-text"
          onClick={goBack}
        >
          <IconBack size={14} />
          {tr("projects.back")}
        </button>

        <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h1
              tabIndex={0}
              className="truncate text-title leading-7 font-semibold text-kin-text"
            >
              {currentProject.name}
            </h1>
            {roots[0] && (
              <div className="mt-1 max-w-sheet truncate text-body text-kin-secondary">
                {roots[0]}
              </div>
            )}
          </div>
          <SearchSelect
            label={tr("projects.mode")}
            value={currentProject.mode}
            options={[
              { id: "ship", label: tr("projects.modeShip") },
              { id: "learn", label: tr("projects.modeLearn") },
              { id: "explore", label: tr("projects.modeExplore") },
              { id: "maintain", label: tr("projects.modeMaintain") },
            ]}
            onChange={(next) => void onModeChange(next as ProjectMode)}
            disabled={offline}
            className="text-body text-kin-text"
          />
        </div>

        {offline && lastLoadedAt > 0 && (
          <div
            role="status"
            className="mb-3 rounded-lg border border-kin-hairline bg-kin-panel px-3 py-2 text-body text-kin-secondary"
          >
            {tr("projects.offlineSince", { time: formatRelativeTime(lastLoadedAt, now) })}
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-4">
            <section aria-labelledby={`${cardIds}-summary`} className="rounded-xl bg-kin-panel p-4">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h2
                  id={`${cardIds}-summary`}
                  className="text-body font-medium uppercase tracking-label text-kin-secondary"
                >
                  {tr("projects.summaryTitle")}
                </h2>
                {!editing && onePagerLoaded && (
                  <button
                    ref={editButtonRef}
                    type="button"
                    disabled={offline}
                    className="rounded-lg border border-kin-hairline px-3 py-1.5 text-strong text-kin-text hover:bg-[var(--kin-fill-strong)] disabled:opacity-50"
                    onClick={beginEdit}
                  >
                    {tr("projects.summaryEdit")}
                  </button>
                )}
              </div>

              {onePagerError && (
                <div
                  role="alert"
                  className="mb-3 rounded-lg border border-kin-red/30 bg-kin-red/10 px-3 py-2 text-body text-kin-red-ink"
                >
                  <p>{onePagerError}</p>
                  <button
                    type="button"
                    onClick={() => void loadOnePager()}
                    className="mt-2 min-h-11 rounded-lg border border-kin-red/40 px-3 text-strong text-kin-red-ink"
                  >
                    {tr("common.retry")}
                  </button>
                </div>
              )}

              {!onePagerLoaded ? (
                onePagerLoading ? (
                  <div className="space-y-3 py-2">
                    <SkeletonLine />
                    <SkeletonLine />
                  </div>
                ) : null
              ) : editing ? (
                <>
                  <textarea
                    ref={summaryFieldRef}
                    aria-label={tr("projects.summaryTitle")}
                    className="min-h-16 w-full resize-y rounded-lg border border-kin-hairline bg-transparent p-3 text-strong leading-prose text-kin-text outline-none focus:border-kin-blue/40"
                    value={draft}
                    maxLength={300}
                    placeholder={tr("projects.summaryPlaceholder")}
                    disabled={offline || saving}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={onSummaryKeyDown}
                  />
                  {offline ? (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <p className="text-caption text-kin-muted">{tr("projects.summaryOffline")}</p>
                      <button
                        type="button"
                        className="min-h-11 rounded-lg px-3 text-strong text-kin-secondary"
                        onClick={cancelEdit}
                      >
                        {tr("common.cancel")}
                      </button>
                    </div>
                  ) : conflict ? (
                    <div
                      role="alert"
                      className="mt-3 rounded-lg border border-kin-red/30 bg-kin-red/10 px-3 py-2 text-body text-kin-red-ink"
                    >
                      <p className="font-medium">{tr("projects.conflictTitle")}</p>
                      <p className="mt-1 whitespace-pre-wrap text-strong">
                        {conflict.one_pager_summary?.focus ||
                          onePagerFocus(conflict.markdown) ||
                          tr("projects.summaryEmpty")}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={saving}
                          className="min-h-11 rounded-lg bg-kin-blue px-3 text-strong font-medium text-kin-on-brand disabled:opacity-50"
                          onClick={onKeepMine}
                        >
                          {tr("projects.conflictKeepMine")}
                        </button>
                        <button
                          type="button"
                          className="min-h-11 rounded-lg border border-kin-hairline px-3 text-strong text-kin-text"
                          onClick={onTakeTheirs}
                        >
                          {tr("projects.conflictTakeTheirs")}
                        </button>
                        <button
                          type="button"
                          className="min-h-11 rounded-lg px-3 text-strong text-kin-secondary"
                          // Dismissing keeps the old base on purpose: the next
                          // save meets the same 409 instead of silently
                          // overwriting the version this editor has not read.
                          onClick={() => setConflict(null)}
                        >
                          {tr("projects.conflictDismiss")}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={saving}
                        className="min-h-11 rounded-lg bg-kin-blue px-3 text-strong font-medium text-kin-on-brand disabled:opacity-50"
                        onClick={onSave}
                      >
                        {saving ? tr("projects.summarySaving") : tr("common.save")}
                      </button>
                      <button
                        type="button"
                        className="min-h-11 rounded-lg px-3 text-strong text-kin-secondary"
                        onClick={cancelEdit}
                      >
                        {tr("common.cancel")}
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <p
                  className={[
                    "text-strong leading-prose",
                    summaryText ? "text-kin-text" : "text-kin-secondary",
                  ].join(" ")}
                >
                  {summaryText || tr("projects.summaryEmpty")}
                </p>
              )}
              {!editing && onePagerLoaded && saved && (
                <p role="status" className="mt-2 text-caption text-kin-muted">
                  {tr("projects.summarySaved")}
                </p>
              )}
            </section>

            <section aria-labelledby={`${cardIds}-recent`} className="rounded-xl bg-kin-panel p-4">
              <h2
                id={`${cardIds}-recent`}
                className="mb-2 text-body font-medium uppercase tracking-label text-kin-secondary"
              >
                {tr("projects.recentTitle")}
              </h2>

              {activityError && (
                <div
                  role="alert"
                  className="rounded-lg border border-kin-red/30 bg-kin-red/10 px-3 py-2 text-strong text-kin-red-ink"
                >
                  <p>{activityError}</p>
                  <button
                    type="button"
                    onClick={() => void loadActivity(currentProject)}
                    className="mt-2 min-h-11 rounded-lg border border-kin-red/40 px-3 text-strong text-kin-red-ink"
                  >
                    {tr("common.retry")}
                  </button>
                </div>
              )}

              {activity ? (
                <div className={activityError ? "mt-3" : ""}>
                  <div className="text-caption font-medium text-kin-muted">
                    {tr("projects.recentLastConversation")}
                  </div>
                  <RecentConversationRow
                    row={activity}
                    now={now}
                    onOpen={() => openChat(activity)}
                  />
                </div>
              ) : (activityLoading || activityFor !== currentProject.id) && !activityError ? (
                <div className="space-y-3 py-2">
                  <SkeletonLine />
                  <SkeletonLine />
                </div>
              ) : !activityError ? (
                <div className="py-1 text-body text-kin-secondary">
                  <p>{tr("projects.recentEmpty")}</p>
                  <p className="mt-1 text-kin-muted">{tr("projects.recentEmptyHint")}</p>
                </div>
              ) : null}

              {activityPartialShown && !activityError && (
                <p role="status" className="mt-2 text-caption text-kin-muted">
                  {tr("projects.chatsPartial")}
                </p>
              )}

              <dl className="mt-2 space-y-1 text-caption text-kin-muted">
                {lastCommit !== null && (
                  <div className="flex gap-1">
                    <dt>{tr("projects.lastCommitWindow", { days: PULSE_WINDOW_DAYS })}</dt>
                    <dd aria-hidden>{tr("common.labelSeparator")}</dd>
                    <dd className="tabular-nums">{formatRelativeTime(lastCommit, now)}</dd>
                  </div>
                )}
                {importAt !== null && (
                  <div className="flex gap-1">
                    <dt>{tr("projects.lastImport")}</dt>
                    <dd aria-hidden>{tr("common.labelSeparator")}</dd>
                    <dd className="tabular-nums">{formatRelativeTime(importAt, now)}</dd>
                  </div>
                )}
              </dl>

              <p className="mt-2 text-caption text-kin-muted">{tr("projects.recentOnlyLatest")}</p>

              {wide && <div className="mt-3">{newChatControl}</div>}
            </section>
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
                <Link
                  to="/routines"
                  onClick={(event) => {
                    if (!canLeave()) event.preventDefault();
                  }}
                  className="inline-flex min-h-11 items-center gap-1 text-body text-kin-secondary hover:text-kin-text"
                >
                  {tr("projects.openRoutines")}
                  <span aria-hidden>→</span>
                </Link>
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

function NewChatControl({
  href,
  disabledReason,
  fullWidth,
  onBeforeNavigate,
}: {
  href: string | null;
  disabledReason: string;
  fullWidth: boolean;
  onBeforeNavigate?: () => boolean;
}) {
  const tr = useT();
  const reasonId = useId();
  const className = [
    "inline-flex min-h-11 items-center justify-center rounded-lg bg-kin-blue px-3 text-strong font-medium text-kin-on-brand",
    fullWidth ? "w-full" : "",
  ].join(" ");

  if (href === null || disabledReason) {
    return (
      <div className={fullWidth ? "w-full" : ""}>
        <button
          type="button"
          disabled
          aria-describedby={disabledReason ? reasonId : undefined}
          className={`${className} opacity-50`}
        >
          {tr("projects.newChat")}
        </button>
        {disabledReason && (
          <p id={reasonId} className="mt-1 text-caption text-kin-muted">
            {disabledReason}
          </p>
        )}
      </div>
    );
  }

  return (
    <Link
      to={href}
      className={className}
      onClick={(event) => {
        if (onBeforeNavigate && !onBeforeNavigate()) event.preventDefault();
      }}
    >
      {tr("projects.newChat")}
    </Link>
  );
}

function RecentConversationRow({
  row,
  now,
  onOpen,
}: {
  row: ProjectChatRow;
  now: number;
  onOpen: () => void;
}) {
  const tr = useT();
  const avatar = agentAvatarMeta(row.agentId);
  const status = row.task ? taskCardStatusView(row.task.status) : null;
  // The same dot rule as the list, so a row means the same thing in both
  // places: green for a finished chat not yet seen, pulsing while it runs.
  const dot = row.task ? sessionStatusDotClass(row.task.status, false) : null;
  const label = [
    row.title,
    agentDisplayName(row.agentId),
    formatRelativeTime(row.at, now),
    status ? tr(status.labelKey) : "",
    row.remote ? tr("machine.remote") : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={label}
      className="kin-row-press flex min-h-11 w-full items-center gap-2.5 px-1 py-2 text-left"
    >
      <span className="flex w-2 flex-none justify-center">
        {dot ? <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden /> : null}
      </span>
      <span
        className={`flex h-5 w-5 flex-none items-center justify-center rounded-full text-micro font-semibold ${avatar.className}`}
        title={agentDisplayName(row.agentId)}
        aria-hidden
      >
        {avatar.initials}
      </span>
      <span className="min-w-0 flex-1 truncate text-subtitle font-medium leading-ui text-kin-text">
        {row.title}
      </span>
      {row.remote && (
        <span className="flex-none text-kin-muted" title={tr("machine.remote")} aria-hidden>
          <IconMachine size={12} />
        </span>
      )}
      <span className="flex-none text-caption leading-ui text-kin-muted tabular-nums">
        {formatRelativeTime(row.at, now)}
      </span>
      <span className="flex-none text-caption text-kin-secondary">
        {tr("projects.recentContinue")} <span aria-hidden>→</span>
      </span>
    </button>
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
