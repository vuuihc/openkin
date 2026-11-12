import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { IonActionSheet } from "@ionic/react";
import type { ActionSheetButton } from "@ionic/core";
import {
  ApiError,
  archiveTask,
  cancelTask,
  cancelWorkerStep,
  deleteTask,
  createArtifact,
  answerUserQuestion,
  deriveArtifactTitle,
  detectArtifactKind,
  followUpPrompt,
  forkTask,
  markRoutineRunRead,
  getTaskUsage,
  getTaskLimitWait,
  isAuthenticated,
  isTerminal,
  listAgents,
  listEvents,
  listQueuedPrompts,
  listWorkerSteps,
  limitContinue,
  restoreTaskWorkspace,
  retryTask,
  searchTaskSourceFiles,
  unarchiveTask,
  withdrawQueuedPrompt,
  type AgentInfo,
  type Approval,
  type LimitHit,
  type QueuedPrompt,
  type Task,
  type TaskUsage,
  type TaskLimitWait,
  type Upload,
  type WorkerStep,
} from "../api/client";
import { liveResources } from "../api/liveResources";
import { useFindSeed } from "./useFindSeed";
import { useMinWidth } from "../hooks/useMinWidth";
import { usePendingResources, useTaskResource } from "../api/useLiveResources";
import { isImeKeyEvent } from "../lib/ime";
import ApprovalCard from "../components/cards/ApprovalCard";
import LimitCard from "../components/cards/LimitCard";
import UserQuestionCard from "../components/cards/UserQuestionCard";
import ChatStream from "../components/chat/ChatStream";
import { findSpeakerModel, pendingRefSeqs } from "../components/chat/transcriptProjection";
import Composer, { type SubmitFailure } from "../components/chat/Composer";
import RunConfigControl from "../components/chat/RunConfigSheet";
import BranchPicker from "../components/chat/BranchPicker";
import RepoChip from "../components/chat/RepoChip";
import CwdPicker from "../components/chat/CwdPicker";
import PermissionModePicker from "../components/chat/PermissionModePicker";
import ModelPicker from "../components/chat/ModelPicker";
import {
  IconAlert,
  IconArchive,
  IconBack,
  IconKin,
  IconMachine,
  IconMore,
  IconPanel,
  IconPullRequest,
  IconRestore,
  IconSessions,
  IconShare,
  IconSpinner,
  IconTrash,
} from "../components/icons";
import { SlowConnectHint } from "../components/Skeleton";
import PanelSurface from "../components/layout/PanelSurface";
import MobileHeader, { MobileHeaderButton } from "../components/mobile/MobileHeader";
import PullRequestPanel from "../components/pr/PullRequestPanel";
import PublishPanel from "../components/pr/PublishPanel";
import ChangedFilesBar from "../components/workspace/ChangedFilesBar";
import FileQuickOpen from "../components/workspace/FileQuickOpen";
import WorkspacePanel from "../components/workspace/WorkspacePanel";
import TaskUsageSummary from "../components/usage/TaskUsageSummary";
import WorkerTimeline from "../components/task/WorkerTimeline";
import ShareDialog from "../components/task/ShareDialog";
import { workerActivity, type WorkerRow } from "../components/task/workerActivity";
import { extractChangedFiles } from "../lib/changedFiles";
import type { AgentRole } from "../lib/agentRoles";
import { anchoredPendingIds, mergeDecidedApprovals, orderPending } from "../lib/needsYou";
import { forgetLastConversation } from "../lib/lastConversation";
import { overlayOwnsKeyboard } from "../lib/overlayOwnsKeyboard";
import { focusSessionSearch } from "../lib/sessionSearch";
import {
  canRefillComposer,
  editStillRunning,
  queuedMessageSeqs,
  startEdit,
  startWithdrawal,
  withoutWithdrawn,
} from "../lib/queuedPrompts";
import { publishDraftFrom } from "../lib/publishDraft";
import type { AttentionMark } from "../lib/sessionSwitcher";
import { switcherTriggerLabel } from "../lib/sessionSwitcher";
import { useSlowHint } from "../hooks/useSlowHint";
import { useMachines } from "../hooks/useMachines";
import { useApprovalDecision } from "../hooks/useApprovalDecision";
import { catalogFor, findMachine, remoteMachine } from "../lib/devices";
import { useT } from "../i18n/react";
import { agentAvatarMeta, agentDisplayName } from "../lib/agentMention";
import { agentFamily } from "../lib/agentFamilies";
import { projectLabel, toWorkspaceRelativePath } from "../lib/paths";
import { isKinDesktop } from "../lib/desktop";
import {
  normalizePermissionMode,
  permissionModesForAgent,
  type PermissionMode,
} from "../lib/permissionMode";
import { clearFollowUpDraft, getFollowUpDraft, setFollowUpDraft } from "../lib/followUpDraft";
import { clearSessionScroll, getSessionScroll, setSessionScroll } from "../lib/sessionScroll";
import { modelPickerLabel, modelsForAgent } from "../lib/agentModels";
import { isPanelAvailable, panelForView, resolvePanel, type PanelContext } from "../lib/panels";
import { useAppStore } from "../store/appStore";
import { displayUserPrompt } from "../lib/attachments";

/**
 * Single-column chat: user talks to the session host; @agents are task workers.
 * Main chat column + optional right rail (usage / diffs at 1600px+).
 */
type TaskDetailPageProps = {
  /** Fixed task id when hosted in a keep-alive cache (Chrome-tab style). */
  taskId?: string;
  /** Whether this instance is the visible session. */
  active?: boolean;
  /**
   * Opens the phone's session switcher (the tab strip is desktop-only). Passed
   * by the host that owns the open-tab list; the phone header shows the button
   * only when it is there.
   */
  onOpenSessionSwitcher?: () => void;
  /**
   * What the switcher's dot says, when one is owed: a session other than the
   * one in front is blocked on a person or has a result nobody has read. The
   * host computes it from the same rows the sheet draws — which include the
   * recent sessions behind the tabs, not only open tabs, because on a phone
   * there is usually no tab to mark and a result that landed in another
   * session is exactly what the dot is for.
   */
  switcherMark?: AttentionMark | null;
  /**
   * Saved prompt shortcuts for the composer's `/` menu. The host reads them
   * once for every session pane it keeps alive; a pane that is rendered on its
   * own (or a test) simply has none. `null` is "not loaded yet", which the
   * composer's menu reports differently from an empty list.
   */
  agentRoles?: AgentRole[] | null;
  /**
   * The newest row the session list already holds for this id.
   *
   * A cold entry (no pane kept alive, or a task created a moment ago) has no
   * detail yet. Rendering only after the detail answers turns the whole screen
   * into a skeleton: header, composer and all. The list row is the same `Task`
   * shape, so the chrome can be drawn from it while the events are still in
   * flight; the detail then replaces the content inside the same shell.
   */
  fallbackTask?: Task;
};

export default function TaskDetailPage({
  taskId,
  active = true,
  onOpenSessionSwitcher,
  switcherMark = null,
  agentRoles = [],
  fallbackTask,
}: TaskDetailPageProps) {
  const { id: paramId = "" } = useParams();
  const id = taskId || paramId;
  const navigate = useNavigate();
  const tr = useT();
  // The session-actions sheet is a phone surface; below `md` it is the way to
  // stop, share or find. Keeping it mounted at desktop width leaves an
  // `ion-action-sheet` in the Mac's document even while closed.
  const wide = useMinWidth(768);
  const { machines } = useMachines();
  const detail = useTaskResource(id);
  const pending = usePendingResources();
  // A cached list row is for drawing the chrome while the detail is on its
  // way; it must not keep a deleted conversation on screen. Deletion outranks
  // the cache, so the not-found branch below still owns that answer.
  const gone =
    detail.data.deleted || (detail.error instanceof ApiError && detail.error.status === 404);
  const task = detail.data.task ?? (gone ? null : fallbackTask) ?? null;
  // The title the save button reads, kept current across a memo bailout: the
  // message rows deliberately ignore changed closures, so their save handler
  // can still be the one built before the session was renamed.
  const taskTitleRef = useRef(task?.title);
  taskTitleRef.current = task?.title;
  const events = detail.data.events;
  const approvals = useMemo(
    () => pending.data.approvals.filter((item) => item.task_id === id),
    [id, pending.data.approvals],
  );
  const userQuestions = useMemo(
    () => pending.data.questions.filter((item) => item.task_id === id),
    [id, pending.data.questions],
  );
  const loading = !detail.loaded;
  const error = detail.data.deleted
    ? tr("task.notFound")
    : detail.error instanceof ApiError && detail.error.status === 404
      ? tr("task.notFound")
      : detail.error instanceof Error
        ? detail.error.message
        : detail.error
          ? tr("task.loadFailed")
          : null;
  // The stored resume point must not outlive the conversation it names: a
  // task deleted here or on another device would otherwise reopen as an error
  // on every cold start.
  useEffect(() => {
    if (detail.data.deleted || (detail.error instanceof ApiError && detail.error.status === 404)) {
      forgetLastConversation(id);
    }
  }, [detail.data.deleted, detail.error, id]);
  const [usage, setUsage] = useState<TaskUsage | null>(null);
  const [limitWait, setLimitWait] = useState<TaskLimitWait | null>(null);
  const [workerSteps, setWorkerSteps] = useState<WorkerStep[]>([]);
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedPrompt[]>([]);
  /**
   * The queue as the last poll saw it, readable from a click handler whose
   * identity must stay put: the message rows are memoized and keep the handler
   * they were given, so the handler reads the current queue from here rather
   * than from a capture that would go stale as the queue drains.
   */
  const queuedPromptsRef = useRef<QueuedPrompt[]>([]);
  /**
   * Queue rows this page has withdrawn. Kept after the request succeeds, not
   * just while it is in flight: a poll the daemon answered before the delete
   * landed can arrive afterwards, and without the mark it would put the row —
   * and the badge the tap just removed — back on screen.
   */
  const withdrawnRef = useRef<Set<number>>(new Set());
  /** Bumped to ask the queue effect below to re-read now, not on the next poll. */
  const [queueReload, setQueueReload] = useState(0);
  const [usageLoading, setUsageLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [awaitingReply, setAwaitingReply] = useState(false);
  const [composerModel, setComposerModel] = useState("");
  const [composerPermission, setComposerPermission] = useState<PermissionMode>("default");
  // Bumped when the composer's text is changed from outside it (a queued
  // message being edited). The draft itself lives in localStorage; a render is
  // what makes the composer read it again. The same number is handed to the
  // composer as a focus signal, so the text lands under the caret.
  //
  // The task travels with the number: a composer mounted for another task must
  // not read a leftover signal as a request to take the focus on mount, and a
  // mount-time focus cannot be cancelled from here — React runs the child's
  // effects before the parent's. Keying the signal by task makes the check a
  // render, not a race.
  const [refill, setRefill] = useState<{ taskID: string; n: number }>({ taskID: "", n: 0 });
  // When the last edit request started, in ms, or 0 when none is in flight. A
  // timestamp rather than a flag: a request that never answers would otherwise
  // refuse every pencil tap for the life of the page.
  const editStartedAtRef = useRef(0);
  // Latest follow-up draft fields for this task (localStorage is source of truth).
  const draftPromptRef = useRef("");
  const draftAttachmentsRef = useRef<Upload[]>([]);
  const [stopping, setStopping] = useState(false);
  /** The worker row whose stop request is in flight, keyed like the timeline. */
  const [workerStoppingKey, setWorkerStoppingKey] = useState<string | null>(null);
  /** The task the page is showing now; a late cancel answer must check it. */
  const taskIdRef = useRef(id);
  const [deleting, setDeleting] = useState(false);
  const [archiving, setArchiving] = useState(false);
  /** Phone-only overflow sheet; the same actions stay as chips from `md` up. */
  const [actionsOpen, setActionsOpen] = useState(false);
  /** The public-link dialog, reachable from the sheet and from the chip row. */
  const [shareOpen, setShareOpen] = useState(false);
  /** Open the share dialog once the phone's action sheet has gone; see
   *  `openFindAfterSheet` for why it cannot open underneath it. */
  const openShareAfterSheet = useRef(false);
  /**
   * Find-in-conversation, owned here rather than in ChatStream so the phone's
   * sheet can open it — the phone has no Cmd+F. The hidden panes behind the tab
   * strip pass `findShortcut={false}` so one shortcut cannot open every bar.
   */
  const [findOpen, setFindOpen] = useState(false);
  /**
   * A chat-search result arrives as `?find=…`: the conversation opens with its
   * find bar on those words, so the reader lands on the line that matched. Only
   * the pane in front takes it — the others are mounted behind the tab strip
   * and would open a bar nobody can see. The hook consumes the parameter, so
   * the same hit can be picked again and the bar reopens.
   *
   * Nothing is consumed while the page is still loading. The hook deletes the
   * parameter on the render it first sees it, and the conversation is not
   * mounted until the task detail has loaded — consuming early would hand the
   * seed to a page that has nowhere to put it, and the reader would land at the
   * top of a long transcript, which is the failure this feature exists to fix.
   */
  const findSeed = useFindSeed(active && !loading);
  /**
   * Set by the sheet's 查找 row. The bar opens on dismissal, not on the tap:
   * Ionic keeps keyboard focus inside the action sheet until it is removed from
   * the DOM, so focusing the field while the sheet is still up shows a bar with
   * no keyboard, and the removal then drops focus to `<body>`.
   */
  const openFindAfterSheet = useRef(false);
  const [actionBusy, setActionBusy] = useState(false);
  // The same decision path the inbox and the floating card use, so a failure
  // reads the same wherever the reader answered from.
  const { busy, decide } = useApprovalDecision("task.decisionFailed");
  /**
   * Answers this pane has just recorded, keyed by approval id.
   *
   * The pending list drops a row the moment it is decided, which used to make
   * the card disappear and leave the conversation to imply the outcome. These
   * keep the card where it was asked, now saying what was decided — the same
   * place, the same card, no second pending card on the next device.
   */
  const [decidedApprovals, setDecidedApprovals] = useState<Record<string, Approval>>({});
  const decideAndKeep = useCallback(
    async (id: string, decision: "approved" | "denied") => {
      const updated = await decide(id, decision);
      if (!updated) return;
      setDecidedApprovals((prev) => {
        const next = { ...prev, [id]: updated };
        // A long session can answer many cards; the strip is a record of the
        // recent ones, not an ever-growing copy of the approval table.
        const ids = Object.keys(next);
        for (const key of ids.slice(0, Math.max(0, ids.length - 20))) delete next[key];
        return next;
      });
    },
    [decide],
  );
  const [answerBusy, setAnswerBusy] = useState<Record<string, boolean>>({});
  const [limitBusy, setLimitBusy] = useState<string | null>(null);
  const [focusIdx, setFocusIdx] = useState(0);
  const [agents, setAgents] = useState<AgentInfo[]>([]);

  // The panel's rows: the plan table (what each worker was asked) joined to
  // the tool calls on the event stream (what it is doing). Derived, because a
  // second copy of either source is a second thing to keep in step.
  const workerRows = useMemo(() => workerActivity(events, workerSteps), [events, workerSteps]);
  // What the session is actually running when the daemon chose for it: the
  // transcript reports the model the adapter picked (a provider fallback is
  // invisible in `task.model`). The face and the desktop strip name this
  // instead of the generic default, while the stored value stays empty so a
  // follow-up still lets the daemon choose.
  const transcriptModel = useMemo(
    () => (task ? findSpeakerModel(events, task.agent || "") : undefined),
    [events, task],
  );
  const [workspaceOpenPath, setWorkspaceOpenPath] = useState<string | null>(null);
  const [workspaceOpenNonce, setWorkspaceOpenNonce] = useState(0);
  /**
   * The file finder, owned by the page rather than the files panel: the
   * shortcut works with the panel closed, and the phone's action sheet needs an
   * opener outside it. The panel's sidebar has one too, for the same reason the
   * sheet does.
   */
  const [fileFinderOpen, setFileFinderOpen] = useState(false);
  /** Open the finder once the phone's action sheet has gone; see `openFindAfterSheet`. */
  const openFileFinderAfterSheet = useRef(false);
  // A window can cross the breakpoint with the sheet open. The sheet is only
  // mounted below `md`, so widening unmounts it without its dismiss path; the
  // note saying "open find once the sheet is gone" would stay armed for a
  // sheet that is never coming back. Drop both with the sheet.
  useEffect(() => {
    if (!wide) return;
    setActionsOpen(false);
    openFindAfterSheet.current = false;
    openShareAfterSheet.current = false;
    openFileFinderAfterSheet.current = false;
  }, [wide]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null | undefined>(
    undefined,
  );
  const [reviewBusy, setReviewBusy] = useState(false);
  /** Hide scroller until first position is applied — avoids top→bottom flash. */
  const [scrollReady, setScrollReady] = useState(false);
  const lastObservedEventSeq = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** User is near the bottom → stick to new content. */
  const stickToBottomRef = useRef(true);
  /** First paint of this mounted instance: jump to bottom once (no animation). */
  const didInitialScrollRef = useRef(false);
  /**
   * Last known scrollTop while this pane was visible.
   * display:none (keep-alive hide) resets DOM scrollTop, so we restore from here.
   */
  const savedScrollTopRef = useRef<number | null>(id ? getSessionScroll(id) : null);
  const markScrollReady = useCallback(() => {
    setScrollReady((prev) => (prev ? prev : true));
  }, []);
  const pushToast = useAppStore((s) => s.pushToast);
  const wsStatus = useAppStore((s) => s.wsStatus);
  // Which panel is over the app, and the view it belongs to. One value, one
  // writer, so the terminal and this page can no longer both believe they are on
  // top; `panelForView` is what makes it this session's business and no other's.
  const shownPanel = useAppStore((s) => s.shownPanel);
  const showPanel = useAppStore((s) => s.showPanel);
  const hidePanel = useAppStore((s) => s.hidePanel);
  const togglePanel = useAppStore((s) => s.togglePanel);
  // Closing the files panel spends the open-file pulse. The panel consumes the
  // path once; keeping it would replay the last "open this file" on the next
  // open and land inside a file instead of on the list, which is what a fresh
  // open of Files means. Read from the store rather than from the rendered
  // panel because this hook has to run in every render (the page returns early
  // while the task loads), and the files panel is offered whenever there is a
  // task, so the store's answer is the panel's.
  const filesPanelOpen = shownPanel?.view === id && shownPanel.id === "files";
  useEffect(() => {
    if (!filesPanelOpen) setWorkspaceOpenPath(null);
  }, [filesPanelOpen]);
  const slow = useSlowHint(loading);

  const loadUsage = useCallback(async () => {
    if (!isAuthenticated()) return;
    setUsageLoading(true);
    try {
      setUsage(await getTaskUsage(id));
    } catch {
      setUsage(null);
    } finally {
      setUsageLoading(false);
    }
  }, [id]);

  useEffect(() => {
    taskIdRef.current = id;
    lastObservedEventSeq.current = 0;
    setUsage(null);
    setLimitWait(null);
    setWorkerSteps([]);
    setQueuedPrompts([]);
    queuedPromptsRef.current = [];
    withdrawnRef.current = new Set();
    setWorkspaceOpenPath(null);
    setWorkspaceOpenNonce(0);
    setSelectedWorkspaceId(undefined);
    stickToBottomRef.current = true;
    listAgents()
      .then(setAgents)
      .catch(() => setAgents([]));
    // No panel to close here: the panel is keyed by session, so a new `id` is
    // already showing whatever that session had open (usually nothing) and
    // leaving the old session's panel where it was.
  }, [id]);

  useEffect(() => {
    if (!id || !task) return;
    let active = true;
    const timer = window.setTimeout(() => {
      listWorkerSteps(id)
        .then((steps) => {
          if (active) setWorkerSteps(steps);
        })
        .catch(() => {
          if (active) setWorkerSteps([]);
        });
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [id, task?.id, task?.status, events.length]);

  // The queue drains at the turn boundary, which the event stream reports — so
  // re-read it whenever events land, and keep a slow poll for the case where the
  // only thing that changed is that a waiting message got answered.
  useEffect(() => {
    if (!id || !task) return;
    let active = true;
    const load = () => {
      listQueuedPrompts(id)
        .then((prompts) => {
          if (!active) return;
          const next = withoutWithdrawn(prompts, withdrawnRef.current);
          queuedPromptsRef.current = next;
          setQueuedPrompts(next);
        })
        .catch(() => {
          if (!active) return;
          queuedPromptsRef.current = [];
          setQueuedPrompts([]);
        });
    };
    const timer = window.setTimeout(load, 250);
    const interval = isTerminal(task.status) ? undefined : window.setInterval(load, 3000);
    return () => {
      active = false;
      window.clearTimeout(timer);
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, [id, task?.id, task?.status, events.length, queueReload]);

  // Stable identity, so the stream only re-renders when the queue really changed.
  const queuedSeqs = useMemo(() => queuedMessageSeqs(queuedPrompts), [queuedPrompts]);

  /**
   * Take a message back before the daemon delivers it.
   *
   * The row loses its badge at once and the queue poll confirms it — the queue is
   * the truth, and a message that reached the turn boundary in the meantime is
   * not a failure, so a 404 just means the poll is about to agree. Anything else
   * puts the badge back by re-reading the queue and says what went wrong.
   */
  const withdrawQueued = useCallback(
    (seq: number) => {
      // Read by the error path below, which runs a microtask later — after this
      // call has returned the row it is about.
      let started: QueuedPrompt | null = null;
      started = startWithdrawal({
        queue: queuedPromptsRef.current,
        seq,
        withdrawn: withdrawnRef.current,
        request: (promptID) => withdrawQueuedPrompt(id, promptID),
        onError: () => {
          const row = started;
          if (!row) return;
          // A failed request is not proof the withdrawal failed: the delete can
          // land and only its answer be lost — a reset connection, a proxy
          // timeout — and toasting then would report a success as an error.
          // The queue is the truth, so ask it before saying anything.
          void listQueuedPrompts(id)
            .then((prompts) => {
              queuedPromptsRef.current = withoutWithdrawn(prompts, withdrawnRef.current);
              setQueuedPrompts(queuedPromptsRef.current);
              if (!prompts.some((prompt) => prompt.id === row.id)) {
                // It did land. The mark went with the error; put it back so a
                // poll answered before the delete cannot resurrect the row.
                withdrawnRef.current.add(row.id);
                return;
              }
              pushToast(tr("chat.withdrawFailed"), "error");
            })
            .catch(() => {
              pushToast(tr("chat.withdrawFailed"), "error");
              setQueueReload((n) => n + 1);
            });
        },
      });
      if (!started) return;
      const row = started;
      // Functional on purpose: a poll can land between the tap and this update,
      // and dropping the row from the latest list keeps whatever it brought.
      const drop = (list: QueuedPrompt[]) => list.filter((p) => p.id !== row.id);
      queuedPromptsRef.current = drop(queuedPromptsRef.current);
      setQueuedPrompts(drop);
    },
    [id, pushToast, tr],
  );

  /** The × in a queued message's badge: take it back and say nothing more. */
  const onWithdrawQueued = useCallback((seq: number) => withdrawQueued(seq), [withdrawQueued]);

  useEffect(() => {
    if (!task) return;
    void loadUsage();
  }, [loadUsage, task?.status, task?.tokens_in, task?.tokens_out, task?.cost_usd]);

  // Opening a routine run marks it read (clears sidebar blue pill).
  useEffect(() => {
    if (!task?.routine_id || !task.routine_unread) return;
    const id = task.id;
    void markRoutineRunRead(id)
      .then(() => {
        liveResources.patchTask(id, { routine_unread: false });
        window.dispatchEvent(new Event("kin:routine-unread-changed"));
      })
      .catch(() => undefined);
  }, [task?.id, task?.routine_id, task?.routine_unread]);

  useEffect(() => {
    if (detail.data.deleted && active) navigate("/");
  }, [active, detail.data.deleted, navigate]);

  useEffect(() => {
    for (const event of events) {
      if (event.seq <= lastObservedEventSeq.current) continue;
      lastObservedEventSeq.current = event.seq;
      if (event.type !== "message" || parsePayloadSpeaker(event.payload) !== "user") {
        setAwaitingReply(false);
      }
    }
  }, [events]);

  const isNearBottom = useCallback((el: HTMLElement, threshold = 96) => {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
  }, []);

  const onChatScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = isNearBottom(el);
    // Only record while laid out — hidden (display:none) panes report 0.
    if (active && el.clientHeight > 0) {
      savedScrollTopRef.current = el.scrollTop;
      if (id) setSessionScroll(id, el.scrollTop);
    }
  }, [isNearBottom, active, id]);

  // First paint of this mounted instance: restore saved scroll, else jump to bottom.
  // Instant scrollTop (no smooth). Scroller stays invisible until positioned (scrollReady).
  // Keep-alive hides with display:none which clears DOM scrollTop — we re-apply from
  // savedScrollTopRef / localStorage on activate (see effect below).
  useLayoutEffect(() => {
    if (didInitialScrollRef.current) return;
    if (loading || !task) return;
    const el = scrollRef.current;
    if (!el) return;

    const saved = savedScrollTopRef.current ?? (id ? getSessionScroll(id) : null);

    const finalize = (node: HTMLElement) => {
      didInitialScrollRef.current = true;
      savedScrollTopRef.current = node.scrollTop;
      if (id) setSessionScroll(id, node.scrollTop);
      markScrollReady();
    };

    const tryJump = (): boolean => {
      if (didInitialScrollRef.current) return true;
      const node = scrollRef.current;
      if (!node) return false;
      // Flex chain not ready yet — keep waiting (ResizeObserver / rAF will retry).
      if (node.clientHeight <= 0) return false;

      if (saved != null) {
        // Direct assignment — no smooth scroll animation.
        node.scrollTop = saved;
        stickToBottomRef.current = isNearBottom(node);
        const overflow = node.scrollHeight - node.clientHeight;
        // Content still loading (too short to reach saved) — wait for more layout.
        if (overflow + 1 < saved && overflow > 1) return false;
        finalize(node);
        return true;
      }

      node.scrollTop = node.scrollHeight;
      stickToBottomRef.current = true;

      const overflow = node.scrollHeight - node.clientHeight;
      const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
      // Short thread (no overflow) or successfully pinned to bottom.
      if (overflow <= 1 || distance <= 4) {
        finalize(node);
        return true;
      }
      return false;
    };

    if (tryJump()) return;

    let raf = 0;
    const ro = new ResizeObserver(() => {
      if (tryJump()) {
        ro.disconnect();
        if (raf) cancelAnimationFrame(raf);
        return;
      }
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (tryJump()) ro.disconnect();
      });
    });
    ro.observe(el);
    if (el.firstElementChild instanceof Element) {
      ro.observe(el.firstElementChild);
    }

    // Fallback so a flaky layout never leaves the user stuck at the top.
    const timer = window.setTimeout(() => {
      const node = scrollRef.current;
      if (!node || didInitialScrollRef.current) return;
      if (saved != null) {
        node.scrollTop = saved;
        stickToBottomRef.current = isNearBottom(node);
      } else {
        node.scrollTop = node.scrollHeight;
        stickToBottomRef.current = true;
      }
      finalize(node);
      ro.disconnect();
    }, 1000);

    return () => {
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [loading, task, events.length, id, isNearBottom, markScrollReady]);

  // After display:none hide, re-apply scroll in useLayoutEffect (before paint).
  // Instant scrollTop only — no smooth animation, no top→bottom slide.
  useLayoutEffect(() => {
    if (!active) return;
    if (!didInitialScrollRef.current) return;
    const el = scrollRef.current;
    if (!el) return;

    const apply = (): boolean => {
      const node = scrollRef.current;
      if (!node || node.clientHeight <= 0) return false;
      if (stickToBottomRef.current) {
        node.scrollTop = node.scrollHeight;
      } else {
        const saved = savedScrollTopRef.current ?? (id ? getSessionScroll(id) : null);
        if (saved != null) node.scrollTop = saved;
      }
      stickToBottomRef.current = isNearBottom(node);
      savedScrollTopRef.current = node.scrollTop;
      if (id) setSessionScroll(id, node.scrollTop);
      markScrollReady();
      return true;
    };

    if (apply()) return;

    // Layout not ready yet — keep hidden until we can place scroll.
    setScrollReady(false);
    let raf = 0;
    const ro = new ResizeObserver(() => {
      if (apply()) {
        ro.disconnect();
        if (raf) cancelAnimationFrame(raf);
      } else {
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          if (apply()) ro.disconnect();
        });
      }
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [active, id, isNearBottom, markScrollReady]);

  // Follow new content only when user was already at bottom, or just sent a message.
  // Skip while keep-alive-hidden (clientHeight 0); stickToBottomRef keeps intent for restore.
  // Instant pin — never smooth-scroll the main transcript.
  useLayoutEffect(() => {
    if (!didInitialScrollRef.current) return;
    if (!(stickToBottomRef.current || sending)) return;
    const el = scrollRef.current;
    if (!el || el.clientHeight <= 0) return;
    el.scrollTop = el.scrollHeight;
    stickToBottomRef.current = true;
    savedScrollTopRef.current = el.scrollTop;
    if (id) setSessionScroll(id, el.scrollTop);
  }, [events, approvals, userQuestions, sending, id]);

  const latestLimitHit = useMemo(() => {
    let lastUserSeq = 0;
    for (const ev of events) {
      if (ev.type !== "message") continue;
      const p = (ev.payload ?? {}) as Record<string, unknown>;
      if (p.role === "user" || p.speaker === "user") lastUserSeq = ev.seq;
    }
    let hit: { seq: number; payload: LimitHit } | null = null;
    for (const ev of events) {
      if (ev.type !== "limit_hit" || ev.seq <= lastUserSeq) continue;
      const p = (ev.payload ?? {}) as LimitHit;
      hit = { seq: ev.seq, payload: p };
    }
    if (!hit) return null;
    // Terminal cards still render (actions hide themselves inside LimitCard).
    return hit;
  }, [events]);

  useEffect(() => {
    if (!task || !latestLimitHit) return;
    void getTaskLimitWait(task.id)
      .then(setLimitWait)
      .catch(() => setLimitWait(null));
  }, [task?.id, task?.status, latestLimitHit?.seq]);

  const needsYou = useMemo(() => {
    // Where each card was asked. A card whose asking event has scrolled out of
    // the loaded window has no place in the conversation and sorts last — that
    // is the difference between "drawn at the point the agent stopped" and
    // "drawn at the end of the stream".
    const anchors = pendingRefSeqs(events);
    const a = approvals.map((item) => ({
      kind: "approval" as const,
      id: item.id,
      created_at: item.created_at,
      seq: anchors.get(item.id) ?? null,
      item,
    }));
    const q = userQuestions.map((item) => ({
      kind: "question" as const,
      id: item.id,
      created_at: item.created_at,
      seq: anchors.get(item.id) ?? null,
      item,
    }));
    // Chronological first, then by anchor: `orderPending` is stable, so two
    // cards with no anchor keep the order they were asked in.
    return orderPending([...a, ...q].sort((x, y) => x.created_at - y.created_at));
  }, [approvals, userQuestions, events]);

  type NeedsYouEntry = (typeof needsYou)[number];

  // Decided cards outlive their pending row: the answers this pane just gave,
  // and the ones the transcript already remembers (a reload, or a decision
  // made on the phone). Only until the server lists the same approval again.
  const decidedCards = useMemo(
    () => mergeDecidedApprovals(approvals, decidedApprovals, events),
    [approvals, decidedApprovals, events],
  );
  const displayNeedsYou = useMemo(() => {
    const pending = needsYou.map((entry) => ({ ...entry, decided: false }));
    if (decidedCards.length === 0) return pending;
    const anchors = pendingRefSeqs(events);
    const decided = decidedCards.map((item) => ({
      kind: "approval" as const,
      id: item.id,
      created_at: item.created_at,
      seq: anchors.get(item.id) ?? null,
      item,
      decided: true,
    }));
    return orderPending([...pending, ...decided].sort((a, b) => a.created_at - b.created_at));
  }, [needsYou, decidedCards, events]);

  useEffect(() => {
    if (!active) return;
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      // A floating layer owns the keyboard while it is up. Approving a card
      // behind the overlay is the worst thing a shortcut can do, and a focused
      // button in the file finder is exactly the target this would otherwise
      // get. Not only dialogs: the permission menu and the phone's run-config
      // layers are `menu`/`listbox` roles portaled over this same pane.
      if (overlayOwnsKeyboard()) return;
      const list = needsYou;
      if (!list.length) return;
      if (e.key === "j" || e.key === "J") {
        setFocusIdx((i) => Math.min(list.length - 1, i + 1));
      } else if (e.key === "k" || e.key === "K") {
        setFocusIdx((i) => Math.max(0, i - 1));
      } else if (e.key === "a" || e.key === "A") {
        const cur = list[focusIdx] ?? list[0];
        if (cur?.kind === "approval") void decideAndKeep(cur.id, "approved");
      } else if (e.key === "d" || e.key === "D") {
        const cur = list[focusIdx] ?? list[0];
        if (cur?.kind === "approval") void decideAndKeep(cur.id, "denied");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, needsYou, focusIdx, decideAndKeep]);

  // ⌘P / Ctrl+P is the file finder, from anywhere on the session — the whole
  // point is that it works without first opening the files panel and walking a
  // tree. It fires with the caret in the composer too: a shortcut that stops
  // working where you type is a shortcut nobody trusts.
  //
  // It does not fire from inside a dialog, and that is not politeness. The
  // command palette, a sheet and the finder itself are all modal surfaces that
  // keep their own focus; opening this one underneath them would put a hidden
  // text field in front of the keyboard. The finder marks its own dialog, so
  // pressing the key again while it is open is still its own.
  const canFindFile = active && Boolean(task);
  useEffect(() => {
    if (!canFindFile) return;
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || isImeKeyEvent(event) || event.repeat) return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== "p") return;
      const target = event.target;
      const dialog =
        target instanceof Element ? target.closest('[role="dialog"], [role="alertdialog"]') : null;
      if (dialog && !dialog.hasAttribute("data-file-quick-open")) return;
      event.preventDefault();
      setFileFinderOpen(true);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canFindFile]);

  // A pane behind the tab strip keeps its state, and the finder is a modal
  // overlay: leaving it open would greet the reader with it on return, days
  // later, over a session they had moved on from.
  useEffect(() => {
    if (!active) setFileFinderOpen(false);
  }, [active]);

  // Escape leaves the conversation and puts the caret back in the one list
  // search box (step 3). Overlays claim the key first: a menu, the finder bar
  // or a sheet that already handled it must not also move the reader out. The
  // claim is checked after dispatch because the palette and the find bar act
  // on their own timers.
  useEffect(() => {
    if (!active || !wide) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented || isImeKeyEvent(event)) return;
      if (overlayOwnsKeyboard()) return;
      window.setTimeout(() => {
        if (event.defaultPrevented) return;
        focusSessionSearch();
      }, 0);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, wide]);

  async function onLimitAction(action: "wait" | "continue" | "switch" | "dismiss", agent?: string) {
    if (!task) return;
    const busyKey = action === "switch" && agent ? `switch:${agent}` : action;
    setLimitBusy(busyKey);
    const requestRevision = liveResources.currentRevision();
    try {
      const t = await limitContinue(task.id, {
        action,
        ...(agent ? { agent } : {}),
        ...(action === "wait" && latestLimitHit?.payload.reset_at
          ? { reset_at: latestLimitHit.payload.reset_at }
          : {}),
      });
      liveResources.applyTaskSnapshot(t, requestRevision);
    } catch (e) {
      pushToast(e instanceof Error ? e.message : tr("limit.actionFailed"), "error");
    } finally {
      setLimitBusy(null);
    }
  }

  async function onAnswer(questionId: string, body: { selected: string[]; other_text: string }) {
    setAnswerBusy((b) => ({ ...b, [questionId]: true }));
    try {
      const updated = await answerUserQuestion(questionId, body);
      liveResources.applyMessage({ kind: "user_question_update", data: updated });
    } catch (e) {
      pushToast(e instanceof Error ? e.message : tr("question.answerFailed"), "error");
    } finally {
      setAnswerBusy((b) => {
        const next = { ...b };
        delete next[questionId];
        return next;
      });
    }
  }

  // Keep model picker aligned with the task's effective model.
  useEffect(() => {
    if (!task) return;
    setComposerModel((task.model || "").trim());
  }, [task?.id, task?.model]);

  // Keep permission picker aligned with the task's effective mode.
  useEffect(() => {
    if (!task) return;
    setComposerPermission(normalizePermissionMode(task.permission_mode));
  }, [task?.id, task?.permission_mode]);

  // Keep refs aligned when navigating between tasks.
  useEffect(() => {
    if (!id) return;
    const draft = getFollowUpDraft(id);
    draftPromptRef.current = draft.prompt;
    draftAttachmentsRef.current = draft.attachments;
  }, [id]);

  const persistFollowUpDraft = useCallback(
    (prompt: string, attachments = draftAttachmentsRef.current) => {
      if (!id) return;
      draftPromptRef.current = prompt;
      draftAttachmentsRef.current = attachments;
      setFollowUpDraft(id, { prompt, attachments });
    },
    [id],
  );

  /**
   * Edit a queued message: take it back, then put its text where it can be
   * changed.
   *
   * The withdrawal itself is `startEdit`, which owns the rule that matters: the
   * text is refilled only when the daemon says it deleted the row, because a
   * 404 can mean the turn boundary already pulled the message into the running
   * round, and a copy of a running message is a message sent twice. Every other
   * ending says what happened and leaves the message in the transcript, where
   * it can still be copied.
   *
   * The refill also waits for an empty composer, because replacing a draft
   * somebody is already writing is not what tapping one message asks for. That
   * is checked at the tap and again when the answer arrives: a round trip is
   * long enough to type into.
   *
   * What it refills is the prompt exactly as it was sent, attachment block and
   * all: the block is how the images travel, and the composer has no way to
   * rebuild the uploads behind a summary line. The transcript hides the block
   * for display; here it is the message.
   */
  const onEditQueued = useCallback(
    (seq: number) => {
      if (editStillRunning(editStartedAtRef.current, Date.now())) {
        pushToast(tr("chat.editBusy"), "info");
        return;
      }
      if (
        !canRefillComposer({
          prompt: draftPromptRef.current,
          attachments: draftAttachmentsRef.current,
        })
      ) {
        pushToast(tr("chat.editNeedsEmptyComposer"), "info");
        return;
      }
      const row = queuedPromptsRef.current.find((prompt) => prompt.user_seq === seq);
      if (!row) return;

      // The badge goes at once, like the ×: both taps take a message out of the
      // queue, and one of them waiting on a round trip would be a different
      // gesture for the same thing.
      const drop = (list: QueuedPrompt[]) => list.filter((prompt) => prompt.id !== row.id);
      queuedPromptsRef.current = drop(queuedPromptsRef.current);
      setQueuedPrompts(drop);
      const startedAt = Date.now();
      editStartedAtRef.current = startedAt;

      /** Put the message where it can be changed, unless something got there first. */
      const refillComposer = () => {
        if (
          !canRefillComposer({
            prompt: draftPromptRef.current,
            attachments: draftAttachmentsRef.current,
          })
        ) {
          // Withdrawn already, so the message is not lost — it is in the
          // transcript with its withdrawal notice — but the text is not put
          // here, and the composer keeps what was typed meanwhile.
          pushToast(tr("chat.editComposerTaken"), "info");
          return;
        }
        persistFollowUpDraft(row.prompt, []);
        // The draft lives in localStorage and the composer reads it once per
        // render, so the render is what carries the text across; the same bump
        // tells the composer to take the focus.
        setRefill((prev) => ({ taskID: id, n: prev.n + 1 }));
      };

      startEdit({
        row,
        withdrawn: withdrawnRef.current,
        request: (promptID) => withdrawQueuedPrompt(id, promptID),
        relist: () => listQueuedPrompts(id),
        onSettled: (outcome) => {
          // Only this request's deadline is cleared: a stalled one can settle
          // after a later tap has already taken the pencil, and zeroing then
          // would let a third request run beside the second.
          if (editStartedAtRef.current === startedAt) editStartedAtRef.current = 0;
          switch (outcome.kind) {
            case "withdrawn":
              refillComposer();
              return;
            case "stillQueued":
              // It is still waiting, so the badge belongs back on screen and
              // the tap failed for a reason worth saying.
              queuedPromptsRef.current = withoutWithdrawn(outcome.queue, withdrawnRef.current);
              setQueuedPrompts(queuedPromptsRef.current);
              pushToast(tr("chat.withdrawFailed"), "error");
              return;
            case "unknown":
              pushToast(tr("chat.withdrawFailed"), "error");
              setQueueReload((n) => n + 1);
              return;
            case "gone":
              // Taken before the delete reached it, or withdrawn and the answer
              // lost. Only one of those still runs, and they cannot be told
              // apart from here — so nothing is refilled, and the message stays
              // in the transcript where it can be copied.
              pushToast(tr("chat.editAlreadyGone"), "info");
              return;
          }
        },
      });
    },
    [id, persistFollowUpDraft, pushToast, tr],
  );

  // What the composer's @ menu searches. Stable per task so a keystroke does
  // not restart the debounce, and answered by the machine that holds the files
  // when the task runs elsewhere.
  const searchSourceFiles = useCallback(
    async (query: string) => {
      if (!task?.id) return [];
      return (await searchTaskSourceFiles(task.id, query)).files;
    },
    [task?.id],
  );

  async function onComposer(text: string, opts?: { interrupt?: boolean }) {
    if (!task) return;
    setSending(true);
    setAwaitingReply(true);
    // The draft as the composer left it when it submitted — normally empty,
    // because the composer clears itself before calling in.
    const submittedDraft = draftPromptRef.current;
    const requestRevision = liveResources.currentRevision();
    const wasRunning = !isTerminal(task.status);
    try {
      // A running task queues the message and answers it when the round ends;
      // `interrupt` is the explicit second action that cuts the round short
      // instead. Send model / permission only when the picker differs from the task.
      const picked = composerModel.trim();
      const current = (task.model || "").trim();
      const currentPerm = normalizePermissionMode(task.permission_mode);
      const send: { model?: string; permission_mode?: string; interrupt?: boolean } = {};
      if (picked !== current) send.model = picked;
      if (composerPermissionMode !== currentPerm) send.permission_mode = composerPermissionMode;
      if (opts?.interrupt) send.interrupt = true;
      const t = await followUpPrompt(task.id, text, Object.keys(send).length ? send : undefined);
      liveResources.applyTaskSnapshot(t, requestRevision);
      // The draft can change while the POST is in flight: editing a queued
      // message refills the composer. Clearing then would delete text the
      // person is about to send, so only the draft this send started from is
      // cleared — which is the ordinary case.
      if (draftPromptRef.current === submittedDraft) {
        clearFollowUpDraft(task.id);
        draftPromptRef.current = "";
        draftAttachmentsRef.current = [];
      }
      if (wasRunning) {
        // Say which of the two things happened. The queue is the default, so
        // claiming an interrupt here would be a lie the user only discovers when
        // the round they thought they had stopped keeps going.
        pushToast(tr(opts?.interrupt ? "task.interruptedGuide" : "task.queuedGuide"), "info");
      }
    } catch (err) {
      const failure = err instanceof Error ? err : new Error(tr("task.sendFailed"));
      // Re-throw so Composer restores the cleared input + draft, and shows the
      // toast — unless the draft is no longer the one this send started from.
      // Editing a queued message can refill the composer while the POST is in
      // flight, and that text is not this failed send's to put back.
      (failure as SubmitFailure).keepComposer = draftPromptRef.current !== submittedDraft;
      throw failure;
    } finally {
      setSending(false);
    }
  }

  async function onStop() {
    if (!task || isTerminal(task.status)) return;
    setStopping(true);
    const requestRevision = liveResources.currentRevision();
    try {
      const t = await cancelTask(task.id);
      liveResources.applyTaskSnapshot(t, requestRevision);
      pushToast(tr("task.stopped"), "info");
    } catch (err) {
      pushToast(err instanceof Error ? err.message : tr("task.stopFailed"), "error");
    } finally {
      setStopping(false);
    }
  }

  async function onStopWorker(row: WorkerRow) {
    if (!task || workerStoppingKey) return;
    const key = `${row.executionId}-${row.stepIndex}`;
    setWorkerStoppingKey(key);
    try {
      await cancelWorkerStep(task.id, row.executionId, row.stepIndex);
    } catch (err) {
      // 409 is the step having settled while the button was on screen. The
      // refresh below is the honest answer; an error toast would blame the
      // reader for a race they could not see.
      if (!(err instanceof ApiError && err.status === 409)) {
        pushToast(err instanceof Error ? err.message : tr("task.workerCancelFailed"), "error");
      }
    } finally {
      setWorkerStoppingKey(null);
      // The row's plan status is the poll's to report; ask now so the row
      // reads canceled without waiting for the next event to nudge the poll.
      // A reader who moved to another task in the meantime keeps that task's
      // panel: this answer belongs to the task it was asked for.
      void listWorkerSteps(task.id)
        .then((steps) => {
          if (taskIdRef.current === task.id) setWorkerSteps(steps);
        })
        .catch(() => {});
    }
  }

  /**
   * Put this conversation away, or bring it back.
   *
   * One button, because the row knows which side of the archive it is on. The
   * answer is a task like any other change, so it is applied through the same
   * live-resource path the console uses for streaming updates — the list and
   * the drawer learn about it without a refetch. Archiving then leaves the
   * page: it is how a chat is put away, and staying inside it would be reading
   * a conversation the list no longer offers. Restoring stays put.
   */
  async function onToggleArchive() {
    if (!task) return;
    const wasArchived = Boolean(task.archived_at);
    setArchiving(true);
    try {
      const updated = wasArchived ? await unarchiveTask(task.id) : await archiveTask(task.id);
      liveResources.applyMessage({ kind: "task_update", data: updated });
      pushToast(tr(wasArchived ? "task.unarchived" : "task.archived"), "info");
      // Leaving is only right if this is still the conversation on screen: a
      // slow answer must not pull the person off the one they opened next.
      if (!wasArchived && taskIdRef.current === task.id) navigate("/");
    } catch (err) {
      pushToast(
        err instanceof Error
          ? err.message
          : tr(wasArchived ? "task.unarchiveFailed" : "task.archiveFailed"),
        "error",
      );
    } finally {
      setArchiving(false);
    }
  }

  async function onDelete() {
    if (!task) return;
    const title = (task.title || displayUserPrompt(task.prompt || "") || task.id).trim();
    const ok = window.confirm(tr("task.deleteConfirm") + (title ? `\n\n${title}` : ""));
    if (!ok) return;
    setDeleting(true);
    try {
      await deleteTask(task.id);
      liveResources.applyMessage({ kind: "task_deleted", data: { id: task.id } });
      clearSessionScroll(task.id);
      clearFollowUpDraft(task.id);
      pushToast(tr("task.deleted"), "info");
      navigate("/");
    } catch (err) {
      pushToast(err instanceof Error ? err.message : tr("task.deleteFailed"), "error");
    } finally {
      setDeleting(false);
    }
  }

  async function onRetry(fromSeq: number) {
    if (!task || !isTerminal(task.status) || actionBusy) return;
    setActionBusy(true);
    const requestRevision = liveResources.currentRevision();
    const eventReset = liveResources.resetTaskEvents(task.id);
    lastObservedEventSeq.current = 0;
    let retryAccepted = false;
    try {
      const t = await retryTask(task.id, { from_seq: fromSeq });
      retryAccepted = true;
      liveResources.applyTaskSnapshot(t, requestRevision);
      // Reload events after server truncated + re-seeded.
      const evs = await listEvents(task.id);
      liveResources.replaceTaskEvents(
        task.id,
        evs,
        eventReset.revision,
        t.event_epoch ?? eventReset.eventEpoch + 1,
      );
      pushToast(tr("task.retryDone"), "info");
    } catch (err) {
      if (!retryAccepted && err instanceof ApiError) {
        const restored = liveResources.restoreTaskEvents(eventReset);
        if (!restored) void liveResources.refreshTask(task.id, true);
      } else {
        void liveResources.refreshTask(task.id, true);
      }
      pushToast(err instanceof Error ? err.message : tr("task.retryFailed"), "error");
    } finally {
      setActionBusy(false);
    }
  }

  async function onFork(fromSeq: number) {
    if (!task || actionBusy) return;
    setActionBusy(true);
    try {
      // Snapshot branch at this user message (no auto-run). User continues in the new session.
      const t = await forkTask(task.id, { from_seq: fromSeq });
      pushToast(tr("task.forkDone"), "info");
      navigate(`/tasks/${t.id}`);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : tr("task.forkFailed"), "error");
    } finally {
      setActionBusy(false);
    }
  }

  async function onSaveArtifact(text: string) {
    if (!task || actionBusy) return;
    const content = text.trim();
    if (!content) return;
    setActionBusy(true);
    try {
      const art = await createArtifact({
        title: deriveArtifactTitle(content, taskTitleRef.current || tr("api.untitled")),
        kind: detectArtifactKind(content),
        content,
        source_task_id: task.id,
        status: "saved",
      });
      pushToast(tr("task.saveArtifactDone"), "info");
      navigate(`/artifacts/${art.id}`);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : tr("task.saveArtifactFailed"), "error");
    } finally {
      setActionBusy(false);
    }
  }

  function onOpenWorkspacePath(filePath: string): boolean {
    if (!task) return false;
    // If the path is already a canonical repo-relative path, use it directly.
    // Otherwise resolve against the task's cwd as legacy fallback.
    const next = toWorkspaceRelativePath(task.cwd, filePath);
    if (!next) {
      pushToast(tr("workspace.outsideWorkspace"), "error");
      return false;
    }
    showPanel(id, "files");
    setWorkspaceOpenPath(next);
    // Bump the nonce so re-clicking the same path re-loads/focuses it.
    setWorkspaceOpenNonce((n) => n + 1);
    return true;
  }

  /**
   * A file chosen in the finder. The search answers for the checkout, so that
   * is where the file opens: a generation is a snapshot of the work, and the
   * file just found may not exist in the one that happened to be on screen.
   * The generation is only left behind once the path is known to open — a
   * refused path should not flip the panel to the source view and show nothing.
   */
  function onQuickOpenPath(filePath: string) {
    if (!onOpenWorkspacePath(filePath)) return;
    setSelectedWorkspaceId(null);
  }

  const changedFiles = useMemo(() => extractChangedFiles(events), [events]);

  // The agent's last answer, as the publish sheet's opening draft. Recomputed
  // only when the stream changes, because it walks the whole transcript.
  const publishDraft = useMemo(() => publishDraftFrom(events), [events]);

  function openFilesPanel() {
    showPanel(id, "files");
  }

  function openPublishPanel() {
    showPanel(id, "publish");
  }

  function togglePrPanel() {
    togglePanel(id, "pr");
  }

  async function onKeepAllChanges() {
    pushToast(tr("workspace.changed.keepAllDone"), "info");
  }

  async function onDiscardAllChanges() {
    if (!task) return;
    if (task.workspace_mode && task.workspace_mode !== "worktree") {
      pushToast(tr("workspace.changed.discardUnavailable"), "error");
      return;
    }
    setReviewBusy(true);
    try {
      await restoreTaskWorkspace(task.id, 0);
      pushToast(tr("workspace.changed.discardAllDone"), "info");
    } catch (err) {
      pushToast(
        err instanceof Error ? err.message : tr("workspace.changed.discardAllFailed"),
        "error",
      );
      throw err;
    } finally {
      setReviewBusy(false);
    }
  }

  if (loading && !task) {
    // A cold start lands here: the address is the last conversation and its
    // row has not arrived yet. This used to draw a skeleton of the header and
    // two bubbles — a layout for a page that did not exist yet, animating
    // while it waited. The brand mark is what is actually true during that
    // wait: the console is restoring the session. It is one element, it fades
    // in once, and the real page replaces it as soon as the detail answers.
    // `max-md:pt-safe`: on a phone this route does not reserve the top inset
    // yet, and centring the mark under the sensor housing is not centred.
    return (
      <div className="flex-1 flex min-h-0 flex-col items-center justify-center gap-4 bg-kin-bg px-6 max-md:pt-safe">
        <div
          role="status"
          aria-label={tr("common.loading")}
          className="kin-brand-enter flex h-16 w-16 items-center justify-center rounded-2xl bg-kin-blue"
        >
          <IconKin size={30} className="text-kin-on-brand" />
        </div>
        <SlowConnectHint show={slow} />
      </div>
    );
  }

  if (error && !task) {
    return (
      <div className="flex-1 px-6 pb-6 space-y-3 max-md:pt-safe">
        <Link to="/" className="text-strong leading-5 text-kin-blue-ink">
          {tr("task.home")}
        </Link>
        <div
          className="rounded-xl border border-kin-red/40 bg-kin-red/10 px-4 py-3 text-strong leading-5 text-kin-red-ink"
          role="alert"
        >
          {error}
        </div>
      </div>
    );
  }

  if (!task) {
    return (
      <div className="flex-1 px-6 pb-6 space-y-3 max-md:pt-safe">
        <Link to="/" className="text-strong leading-5 text-kin-blue-ink">
          {tr("task.home")}
        </Link>
        <div
          className="rounded-xl border border-[var(--kin-hairline)] bg-[var(--kin-fill)] px-4 py-3 text-strong leading-5 text-kin-secondary"
          role="status"
        >
          {tr("task.loadFailed")}
        </div>
      </div>
    );
  }

  const terminal = isTerminal(task.status);
  // One card, one place: a card whose request is in the loaded window is drawn
  // at the point the agent stopped, and only the ones with no place left (their
  // event scrolled out) fall back to the end of the stream. Rendering both would
  // put two sets of Approve/Deny buttons for the same decision on screen.
  const anchoredIds = anchoredPendingIds(displayNeedsYou);
  const pendingSlots: Record<string, ReactNode> = {};
  for (const entry of displayNeedsYou) {
    if (anchoredIds.has(entry.id)) pendingSlots[entry.id] = renderPendingCard(entry);
  }
  const unanchored = displayNeedsYou.filter((entry) => !anchoredIds.has(entry.id));

  function renderPendingCard(entry: NeedsYouEntry & { decided?: boolean }) {
    const settled =
      entry.kind === "approval" && (entry.decided || entry.item.decision !== "pending");
    const focused = !settled && needsYou[focusIdx]?.id === entry.id;
    return (
      <div data-pending-id={entry.id}>
        {entry.kind === "approval" ? (
          <ApprovalCard
            approval={entry.item}
            focused={focused}
            busy={busy[entry.id] ?? null}
            onApprove={() => {
              if (!settled) void decideAndKeep(entry.id, "approved");
            }}
            onDeny={() => {
              if (!settled) void decideAndKeep(entry.id, "denied");
            }}
            onOpenPath={onOpenWorkspacePath}
          />
        ) : (
          <UserQuestionCard
            question={entry.item}
            focused={focused}
            busy={Boolean(answerBusy[entry.id])}
            onAnswer={(body) => void onAnswer(entry.id, body)}
          />
        )}
      </div>
    );
  }

  // Bring the next thing that is waiting on the user into view, and put the
  // keyboard cursor on it. On a phone the transcript is often scrolled up, and
  // an approval the user never saw is the same as no approval at all.
  function revealFirstPending() {
    const first = needsYou[0];
    if (!first) return;
    setFocusIdx(0);
    const el = scrollRef.current;
    if (!el) return;
    if (first.seq === null) {
      // No anchor: the card is painted at the end of the stream.
      el.scrollTop = el.scrollHeight;
      stickToBottomRef.current = true;
      savedScrollTopRef.current = el.scrollTop;
      if (id) setSessionScroll(id, el.scrollTop);
      return;
    }
    for (const node of el.querySelectorAll("[data-pending-id]")) {
      if (node.getAttribute("data-pending-id") !== first.id) continue;
      node.scrollIntoView({ block: "nearest" });
      stickToBottomRef.current = false;
      return;
    }
  }
  const machine = remoteMachine(machines, task.executing_device_id);
  // What the registry is asked about. Built here because this is where the facts
  // it needs exist: which session this is, and whether its checkout is on another
  // machine. `resolvePanel` is what enforces availability — a panel that stopped
  // applying (the session moved to a checkout the Hub holds) closes rather than
  // rendering in a state it is not offered in.
  const panelCtx: PanelContext = {
    taskId: task.id,
    remote: machine !== null,
    desktop: isKinDesktop(),
  };
  const panel = resolvePanel(panelForView(shownPanel, id), panelCtx);
  const filesOpen = panel === "files";
  const switcherLabel = switcherTriggerLabel(switcherMark);
  const prOpen = panel === "pr";
  const publishOpen = panel === "publish";
  const project = projectLabel(task.cwd);
  const degraded = wsStatus !== "connected" && !terminal;
  // The session's agent belongs to the machine that runs it, not to this one.
  // Reading the local registry here was how a remote session's model list
  // vanished and how a mode the remote node refuses stayed on offer.
  const taskMachine = findMachine(machines, task.executing_device_id);
  const taskAgents = catalogFor(taskMachine, agents);
  // Only another machine's own report is authoritative here. This machine's
  // entry in the machine list is a summary without models, so reading it would
  // replace the local registry's model list with nothing.
  const taskMachineAgent =
    taskMachine && !taskMachine.isSelf
      ? taskMachine.agents.find((agent) => agent.id === task.agent)
      : undefined;
  const taskAgentMeta =
    taskAgents.find((agent) => agent.id === task.agent) ??
    taskAgents.find(
      (agent) => agent.family === agentFamily(task.agent || "", taskMachineAgent?.family),
    );
  const taskAgentModels = taskMachineAgent
    ? (taskMachineAgent.models ?? []).map((id) => ({ id, label: modelPickerLabel({ id }) }))
    : modelsForAgent(agents, task.agent || "");
  const taskAgentModelSource = taskMachineAgent
    ? taskAgentModels.length > 0
      ? ("recommended" as const)
      : ("none" as const)
    : taskAgentMeta?.model_list_source;
  const taskAgentModelStatus = taskMachineAgent
    ? taskAgentModels.length > 0
      ? ("available" as const)
      : ("default_only" as const)
    : taskAgentMeta?.model_list_status;
  // Only a session with no other machine, or one whose id resolves to this
  // machine, runs here. An id this console cannot see is *not* this machine:
  // offering the bypassed mode for a machine that never advertised it is how a
  // follow-up gets refused.
  const taskRunsHere = !task.executing_device_id || taskMachine?.isSelf === true;
  // Here the answer comes from this daemon's registry, because a local session
  // is not a dispatched turn: the --allow-yolo filter does not apply to it, but
  // the agent's own ladder does. The exact agent, not the collapsed family
  // representative — `droid` and `droid-acp` are one row in the picker and two
  // different ladders here, and offering the missing rung fails the turn.
  const taskLocalAgent = taskRunsHere ? agents.find((a) => a.id === task.agent) : undefined;
  const taskPermissionModes = permissionModesForAgent(
    taskMachineAgent ?? taskLocalAgent,
    taskRunsHere,
  );
  // A mode carried over from another session must not be sent to a machine that
  // will refuse it. Showing and sending the clamped mode keeps the control and
  // the request in agreement.
  const composerPermissionMode = taskPermissionModes.includes(composerPermission)
    ? composerPermission
    : "default";
  const hostAgentName = taskAgentMeta?.name ?? agentDisplayName(task.agent || "kin");
  const hostAgentAvatar = agentAvatarMeta(task.agent || "kin");
  const followUpDraft = getFollowUpDraft(task.id);

  /**
   * Phone-only back control (the surrounding link is `md:hidden`).
   *
   * It used to be a `Link to="/"`, which meant opening a session from the
   * phone's session list and pressing back dropped you on the new-chat screen
   * with your place in the list gone. History is the honest answer when there
   * is any — an approval opened from the inbox returns to the inbox — and the
   * session list is the right fallback for a cold deep link.
   *
   * `idx > 0`, not `location.key !== "default"`: a `<Navigate replace>` mints a
   * fresh key, so the key claims "we navigated here" even when the history is
   * empty at index 0. See the longer note in AppShell's `closeDraft`.
   */
  function goBack() {
    if ((window.history.state?.idx ?? 0) > 0) navigate(-1);
    else navigate("/sessions");
  }

  /**
   * The phone header keeps only what says *which* session this is — the agent
   * and the project — and moves the page's verbs into an action sheet. Four
   * chips plus a status plus a project name do not fit 390px; the row used to
   * answer by clipping its tail. From `md` up there is room, so the chips stay
   * and the sheet is not rendered as a second way to reach them.
   */
  const sessionActions: ActionSheetButton[] = [
    { text: tr("chat.find.menu"), handler: () => (openFindAfterSheet.current = true) },
    { text: tr("task.share"), handler: () => (openShareAfterSheet.current = true) },
    { text: tr("workspace.find.action"), handler: () => (openFileFinderAfterSheet.current = true) },
    { text: tr("workspace.title"), handler: () => togglePanel(id, "files") },
    { text: tr("pr.title"), handler: () => togglePrPanel() },
    ...(!terminal
      ? [
          {
            text: stopping ? tr("task.stopping") : tr("composer.stop"),
            role: "destructive" as const,
            disabled: stopping,
            handler: () => void onStop(),
          },
        ]
      : []),
    {
      text: task?.archived_at ? tr("task.unarchiveSession") : tr("task.archiveSession"),
      disabled: archiving,
      handler: () => void onToggleArchive(),
    },
    {
      text: tr("task.deleteSession"),
      role: "destructive" as const,
      disabled: deleting,
      handler: () => void onDelete(),
    },
    { text: tr("common.cancel"), role: "cancel" as const },
  ];

  return (
    <div className="flex-1 min-w-0 min-h-0 flex relative">
      <div className="flex-1 min-w-0 min-h-0 flex flex-col kin-surface-chat">
        {/*
          The phone's one bar: back, the session's title, and the ⋯ that opens
          the same action sheet the chip row used to. The chip row was a second
          44px line holding a host badge, a project link, a status word and the
          overflow trigger — on a 390px screen it took two rows and its own
          horizontal scroll, and the title above it was truncated to make room.
          The status survives as the subtitle; everything else is one tap away.
        */}
        <MobileHeader
          title={task.title || displayUserPrompt(task.prompt || "")}
          subtitle={
            // The project is what the session belongs to; the round's state is
            // appended while it is live rather than replacing the project, so
            // the second line still answers "which session is this" when a run
            // is in flight.
            [
              task.cwd ? project : undefined,
              !terminal ? (degraded ? tr("task.reconnect") : tr("task.running")) : undefined,
            ]
              .filter(Boolean)
              .join(" · ") || undefined
          }
          leading={
            <MobileHeaderButton label={tr("app.back")} onClick={goBack}>
              <IconBack size={20} strokeWidth={2} />
            </MobileHeaderButton>
          }
          trailing={
            <>
              {/* The phone's tab strip: everything open, plus what finished
                  while the reader was elsewhere. Lody puts this control
                  beside ⋯ for the same reason — it is a switch, not an
                  action on this session. */}
              {onOpenSessionSwitcher && (
                <MobileHeaderButton
                  // The dot is unreadable to a screen reader and the label is
                  // the only thing announced, so the state rides in the name.
                  label={tr(
                    switcherLabel.key,
                    switcherLabel.stateKey ? { state: tr(switcherLabel.stateKey) } : undefined,
                  )}
                  onClick={onOpenSessionSwitcher}
                  tone="muted"
                  dot={switcherMark}
                >
                  <IconSessions size={19} />
                </MobileHeaderButton>
              )}
              <MobileHeaderButton
                label={tr("task.sessionActions")}
                onClick={() => setActionsOpen(true)}
                tone="muted"
              >
                <IconMore size={19} />
              </MobileHeaderButton>
            </>
          }
        />

        {/* Desktop's bar. Same content as before; the phone branch above owns
            the small widths now, so the mobile-only controls are gone. */}
        <div
          className="hidden md:flex min-h-11 flex-none items-center px-5 border-b border-[var(--kin-hairline)]"
          style={{ WebkitAppRegion: "drag" } as CSSProperties}
        >
          <div className="min-w-0 flex-1">
            <div className="text-strong font-semibold text-kin-text truncate">
              {task.title || displayUserPrompt(task.prompt || "")}
            </div>
          </div>
          <div
            /* `min-w-0`, not `flex-none`: the row is desktop-only now, and a
               non-shrinking cluster whose natural width passes the window edge
               was clipped there instead of scrolling inside its own box. */
            className="ml-2 flex min-w-0 items-center gap-2 overflow-x-auto kin-scroll whitespace-nowrap text-body text-kin-muted"
            style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
          >
            <span
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--kin-hairline-strong)] bg-[var(--kin-fill)] px-2 py-1"
              title={tr("newChat.hostAgent", { name: hostAgentName })}
            >
              <span
                className={`w-4 h-4 rounded-md inline-flex items-center justify-center text-micro font-semibold ${hostAgentAvatar.className}`}
              >
                {hostAgentAvatar.initials}
              </span>
              <span>{tr("newChat.hostAgent", { name: hostAgentName })}</span>
            </span>
            <button
              type="button"
              onClick={() => {
                togglePanel(id, "files");
              }}
              className={[
                "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-body transition-colors",
                filesOpen
                  ? "border-kin-blue/50 bg-kin-blue/15 text-kin-text"
                  : "border-[var(--kin-hairline-strong)] bg-[var(--kin-fill)] text-kin-secondary hover:text-kin-text",
              ].join(" ")}
              title={tr("workspace.toggle")}
            >
              <IconPanel size={13} />
              <span>{tr("workspace.title")}</span>
            </button>
            <button
              type="button"
              onClick={togglePrPanel}
              className={[
                "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-body transition-colors",
                prOpen
                  ? "border-kin-blue/50 bg-kin-blue/15 text-kin-text"
                  : "border-[var(--kin-hairline-strong)] bg-[var(--kin-fill)] text-kin-secondary hover:text-kin-text",
              ].join(" ")}
              title={tr("pr.title")}
            >
              <IconPullRequest size={13} />
              <span>{tr("pr.title")}</span>
            </button>
            <button
              type="button"
              onClick={() => setShareOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--kin-hairline-strong)] bg-[var(--kin-fill)] px-2 py-1 text-body text-kin-secondary transition-colors hover:text-kin-text"
              title={tr("task.shareTitle")}
            >
              <IconShare size={13} />
              <span>{tr("task.share")}</span>
            </button>
            <button
              type="button"
              onClick={() => void onToggleArchive()}
              disabled={archiving}
              className="inline-flex items-center gap-1 rounded-md border border-[var(--kin-hairline-strong)] bg-[var(--kin-fill)] px-2 py-1 text-body text-kin-secondary transition-colors hover:text-kin-text disabled:opacity-40"
              title={task?.archived_at ? tr("task.unarchiveSession") : tr("task.archiveSession")}
              aria-label={
                task?.archived_at ? tr("task.unarchiveSession") : tr("task.archiveSession")
              }
            >
              {task?.archived_at ? <IconRestore size={13} /> : <IconArchive size={13} />}
            </button>
            <button
              type="button"
              onClick={() => void onDelete()}
              disabled={deleting}
              className="inline-flex items-center gap-1 rounded-md border border-[var(--kin-hairline-strong)] bg-[var(--kin-fill)] px-2 py-1 text-body text-kin-secondary hover:text-kin-red-ink hover:border-kin-red/35 disabled:opacity-40"
              title={tr("task.deleteSession")}
              aria-label={tr("task.deleteSession")}
            >
              <IconTrash size={13} />
            </button>
            {task.project_id ? (
              <Link
                to={`/projects/${encodeURIComponent(task.project_id)}`}
                title={project}
                className="max-w-[10rem] md:max-w-none truncate text-kin-secondary hover:text-kin-text hover:underline"
              >
                {project}
              </Link>
            ) : (
              <span className="max-w-[10rem] md:max-w-none truncate" title={project}>
                {project}
              </span>
            )}
            {!terminal && (
              <>
                <span className="text-kin-blue-ink tabular-nums">
                  {degraded ? tr("task.reconnect") : tr("task.running")}
                </span>
                <button
                  type="button"
                  onClick={() => void onStop()}
                  disabled={stopping}
                  className="text-body font-semibold text-kin-red-ink hover:bg-kin-red/15 disabled:opacity-40 px-1.5 py-0.5 rounded-md border border-kin-red/30 bg-kin-red/10"
                >
                  {stopping ? tr("task.stopping") : tr("composer.stop")}
                </button>
              </>
            )}
          </div>
        </div>

        {!wide && (
          <IonActionSheet
            isOpen={actionsOpen}
            onDidDismiss={() => {
              setActionsOpen(false);
              // The bar can only take focus once the sheet is gone; see
              // `openFindAfterSheet`.
              if (openFindAfterSheet.current) {
                openFindAfterSheet.current = false;
                setFindOpen(true);
              }
              if (openShareAfterSheet.current) {
                openShareAfterSheet.current = false;
                setShareOpen(true);
              }
              if (openFileFinderAfterSheet.current) {
                openFileFinderAfterSheet.current = false;
                setFileFinderOpen(true);
              }
            }}
            header={tr("task.sessionActions")}
            // Which machine is about to be acted on. The footer strip that named
            // it is below `md` too, and "stop this session" on an unnamed remote
            // machine is the decision this sheet exists for.
            subHeader={
              machine
                ? machine.known
                  ? tr("machine.runsOn", { name: machine.text })
                  : tr("machine.runsOnUnknown", { name: machine.text })
                : undefined
            }
            cssClass="kin-sheet"
            buttons={sessionActions}
          />
        )}
        <ShareDialog open={shareOpen} onClose={() => setShareOpen(false)} taskId={task.id} />

        {error && (
          <div
            className="flex-none border-b border-kin-red/30 bg-kin-red/10 px-4 py-2 text-body text-kin-red-ink"
            role="alert"
          >
            {error}
          </div>
        )}

        {/* Below the rail breakpoint: keep compact chips so usage/diff stay reachable without the rail. On a phone the usage bar is gone entirely — the
            transcript already shows the agent's own model line, and the
            reference keeps usage behind a popover at the input, not a bar
            across the reading. The phone's trigger lives in the composer
            footer. */}
        <div className="min-[1600px]:hidden flex-none border-b border-[var(--kin-hairline)]">
          <div className="max-md:hidden">
            <TaskUsageSummary usage={usage} loading={usageLoading} />
          </div>
          <ChangedFilesBar
            files={changedFiles}
            onOpenPath={onOpenWorkspacePath}
            onOpenPanel={openFilesPanel}
            reviewActions={terminal}
            onKeepAll={onKeepAllChanges}
            onDiscardAll={onDiscardAllChanges}
            actionsBusy={reviewBusy}
          />
        </div>

        <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            ref={scrollRef}
            onScroll={onChatScroll}
            className={
              scrollReady
                ? "flex-1 overflow-y-auto kin-scroll py-5 min-h-0"
                : "flex-1 overflow-y-auto kin-scroll py-5 min-h-0 invisible"
            }
          >
            <WorkerTimeline
              rows={workerRows}
              onOpenPath={onOpenWorkspacePath}
              // A settled task has nothing left to stop; a stale running row is
              // the poll's problem, not a button the reader can use.
              onStop={isTerminal(task.status) ? undefined : onStopWorker}
              stoppingKey={workerStoppingKey}
            />
            <ChatStream
              events={events}
              onOpenPath={onOpenWorkspacePath}
              fallbackUserPrompt={displayUserPrompt(task.prompt || "")}
              messageScope={task.id}
              loading={!detail.loaded || !terminal || sending || awaitingReply}
              loadingSpeaker={task.agent || "kin"}
              hostSpeaker={task.agent || "kin"}
              hostModel={task.model}
              queuedSeqs={queuedSeqs}
              onUnqueue={onWithdrawQueued}
              onEditQueued={onEditQueued}
              pendingSlots={pendingSlots}
              showMessageActions={terminal}
              actionsBusy={actionBusy}
              onRetry={(seq) => void onRetry(seq)}
              onFork={(seq) => void onFork(seq)}
              onSaveArtifact={(text) => void onSaveArtifact(text)}
              findOpen={findOpen}
              onFindOpenChange={setFindOpen}
              findShortcut={active && panel === null && !fileFinderOpen}
              findSeed={findSeed}
              trailing={
                <>
                  {unanchored.map((entry) => (
                    <div key={`${entry.kind}-${entry.id}`} className="mt-1">
                      {renderPendingCard(entry)}
                    </div>
                  ))}
                  {latestLimitHit && task && (
                    <div className="mt-2" key={`limit-${latestLimitHit.seq}`}>
                      <LimitCard
                        hit={latestLimitHit.payload}
                        wait={limitWait}
                        hostAgentId={task.agent || ""}
                        active={active}
                        agents={agents}
                        busy={limitBusy}
                        onWait={() => void onLimitAction("wait")}
                        onContinue={() => void onLimitAction("continue")}
                        onSwitch={(agentId) => void onLimitAction("switch", agentId)}
                        onDismiss={() => void onLimitAction("dismiss")}
                      />
                    </div>
                  )}
                  {needsYou.length > 0 && (
                    /*
                    A phone does not have these keys, and the line reads as an
                    instruction to press something that is not there. `sm` is
                    the same gate the composer's ⌘↵ hint uses (Composer.tsx)
                    rather than a pointer media query, so one codebase has one
                    answer to "the keyboard hint does not apply here".
                  */
                    <p className="hidden sm:block text-center text-caption text-kin-muted mt-2">
                      <kbd className="px-1 border border-[var(--kin-hairline-strong)] rounded">
                        A
                      </kbd>{" "}
                      {tr("chat.approve")} ·{" "}
                      <kbd className="px-1 border border-[var(--kin-hairline-strong)] rounded">
                        D
                      </kbd>{" "}
                      {tr("chat.deny")}
                      {" · "}
                      {tr("question.hintKeys")}
                    </p>
                  )}
                  <div ref={bottomRef} />
                </>
              }
            />
          </div>
          {/* The transcript stays invisible until its scroll is restored, so
              without a placeholder the content area reads as empty rather than
              loading. One centred indicator fills that gap; it unmounts with
              the detail, so success and failure both reveal what they should. */}
          {loading && (
            <div
              className="absolute inset-0 flex items-center justify-center"
              role="status"
              aria-label={tr("common.loading")}
            >
              <IconSpinner size={24} className="text-kin-muted motion-reduce:animate-none" />
            </div>
          )}
        </div>

        {/* `data-kin-bottom-chrome` is a contract with the shell's floating
            surfaces: this band is everything the page pins to the bottom
            (the waiting strip and the composer), so an overlay that has to
            stay clear of it measures this instead of guessing a height. Only
            the pane on screen marks itself — the session host keeps cached
            conversations mounted but hidden, and their bands have no box to
            measure. See FloatingApproval. */}
        <div
          data-kin-bottom-chrome={active ? "" : undefined}
          className="flex-none px-4 sm:px-7 pb-3 sm:pb-3.5 pt-1.5"
        >
          <div className="max-w-conversation mx-auto space-y-1.5">
            {needsYou.length > 0 && (
              <button
                type="button"
                onClick={revealFirstPending}
                className="w-full flex items-center justify-center gap-1.5 rounded-xl border border-kin-orange/40 bg-kin-orange/15 px-3 py-2 text-subtitle font-medium text-kin-orange-ink outline-none focus-visible:ring-2 focus-visible:ring-kin-focus-ring"
              >
                <IconAlert className="w-4 h-4 flex-none" />
                {tr("task.waitingOnYou", { count: String(needsYou.length) })}
              </button>
            )}
            <Composer
              key={task.id}
              agents={agents}
              roles={agentRoles}
              hostAgentId={task.agent || ""}
              fileSearch={searchSourceFiles}
              busy={sending}
              running={!terminal}
              stopping={stopping}
              disabled={sending || stopping || !detail.loaded}
              initialValue={followUpDraft.prompt}
              initialAttachments={followUpDraft.attachments}
              focusSignal={refill.taskID === task.id ? refill.n : 0}
              placeholder={
                !terminal
                  ? tr("composer.queuedWhileRunning")
                  : tr("composer.followUpPlaceholder", { name: hostAgentName })
              }
              onValueChange={(v) => persistFollowUpDraft(v)}
              onAttachmentsChange={(atts) => persistFollowUpDraft(draftPromptRef.current, atts)}
              onSubmit={onComposer}
              onStop={onStop}
              footer={
                // One control instead of a strip of chips: the face names the
                // agent, the model and the mode, and the sheet behind it owns
                // the two that can change. Desktop keeps the strip below. The
                // usage trigger rides beside it — the reference keeps usage at
                // the input, and the phone has no usage bar above the
                // transcript to read it from.
                <div className="flex min-w-0 flex-1 items-center gap-1">
                  <RunConfigControl
                    agentName={hostAgentName}
                    agentId={task.agent || ""}
                    agentAvatar={hostAgentAvatar}
                    model={composerModel}
                    models={taskAgentModels}
                    onModelChange={setComposerModel}
                    permission={composerPermissionMode}
                    permissionModes={taskPermissionModes}
                    onPermissionChange={setComposerPermission}
                    disabled={sending || stopping}
                    fallbackModelLabel={transcriptModel}
                  />
                  {!usageLoading && usage ? (
                    <TaskUsageSummary
                      usage={usage}
                      loading={usageLoading}
                      variant="phone"
                      className="flex-none"
                    />
                  ) : null}
                </div>
              }
            />
            {/* The desktop counterpart of the composer's run-config face: from
                `md` up this strip carries what the face carries (and the
                project, branch and machine beside it), and the face is hidden
                so the same two settings are not offered twice on one screen.
                One row, scrolled sideways when it does not fit — it has to
                overflow for that: an item allowed to shrink is squeezed to
                nothing first and paints its text over the chip next to it,
                which is what a long path next to a repository name did on a
                phone. */}
            <div className="hidden md:flex items-center gap-x-2 gap-y-1 px-0.5 min-w-0 overflow-x-auto kin-scroll whitespace-nowrap">
              {/* The host agent is this session's identity: the daemon has no
                  protocol to swap it, so it is named as a fact rather than a
                  disabled button. The phone's run sheet shows the same value
                  the same way. */}
              <span
                className="inline-flex flex-none items-center gap-1.5 text-caption font-medium text-kin-secondary"
                title={tr("runConfig.agentLocked")}
              >
                <span
                  className={`flex h-5 w-5 flex-none items-center justify-center rounded-md text-micro font-semibold ${hostAgentAvatar.className}`}
                >
                  {hostAgentAvatar.initials}
                </span>
                <span className="max-w-[8rem] truncate">{hostAgentName}</span>
              </span>
              <span className="text-kin-muted/50 flex-none select-none" aria-hidden>
                ·
              </span>
              <PermissionModePicker
                value={composerPermissionMode}
                modes={taskPermissionModes}
                disabled={sending || stopping}
                compact
                active={active}
                onChange={setComposerPermission}
              />
              <span className="text-kin-muted/50 flex-none select-none" aria-hidden>
                ·
              </span>
              <ModelPicker
                value={composerModel}
                models={taskAgentModels}
                source={taskAgentModelSource}
                status={taskAgentModelStatus}
                disabled={sending || stopping}
                compact
                fallbackDisplay={transcriptModel}
                onChange={setComposerModel}
              />
              {/* Where the work is — directory, repository, branch, machine —
                  describes the session rather than changing the next message,
                  and on a phone the four chips plus the two controls above do
                  not fit one line. They stay on `md` up, where the row has the
                  width; the project is named in the header and the machine in
                  the session-actions sheet. A div, not a span: CwdPicker renders
                  one, and a span may not contain it. */}
              <div className="hidden md:contents">
                <span className="text-kin-muted/50 flex-none select-none" aria-hidden>
                  ·
                </span>
                <CwdPicker
                  // The one item allowed to give way, because a path can be
                  // arbitrarily long: it shrinks to a readable floor and its path
                  // tag truncates inside that, rather than the row overflowing on
                  // a desktop window or the chip collapsing on a phone.
                  className="min-w-[6rem] max-w-inspector"
                  cwd={task.cwd}
                  locked
                  compact
                  onChange={() => undefined}
                />
                {/* Which repository the work is in. A session on this machine has
                  no recorded one and shows nothing here — its repository is the
                  one the pull-request panel looked up. A session on another
                  machine has one, because the Hub asked that machine when the
                  session started. */}
                <RepoChip repo={task.workspace_repo} />
                <BranchPicker
                  cwd={task.cwd}
                  // The task's cwd is on the machine that runs it, so the branches
                  // in the strip below are that machine's — not this one's, which
                  // for the same repository would read plausibly and be wrong.
                  device={task.executing_device_id}
                  locked
                  compact
                  className="flex-none"
                />
                {machine ? (
                  <>
                    <span className="text-kin-muted/50 flex-none select-none" aria-hidden>
                      ·
                    </span>
                    {/* Which machine the cwd above lives on. Without it the path in
                      this strip reads as a directory on the machine showing it. */}
                    <span
                      className="flex-none inline-flex items-center gap-1 text-caption text-kin-secondary"
                      title={tr("machine.remoteHint", { name: machine.text })}
                    >
                      <IconMachine size={12} />
                      {machine.known
                        ? tr("machine.runsOn", { name: machine.text })
                        : tr("machine.runsOnUnknown", { name: machine.text })}
                    </span>
                  </>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Session side rail — usage + diffs, floats over the chat instead of squeezing its width (Codex-style). */}
      <aside
        className="hidden min-[1600px]:flex absolute top-14 right-3 bottom-3 z-10 w-rail flex-col gap-2.5 rounded-xl bg-[var(--kin-inspector)] backdrop-blur-md shadow-e2 px-3 py-3 min-h-0 overflow-y-auto kin-scroll"
        aria-label={tr("task.sessionRail")}
      >
        <TaskUsageSummary usage={usage} loading={usageLoading} variant="card" />
        <ChangedFilesBar
          files={changedFiles}
          onOpenPath={onOpenWorkspacePath}
          onOpenPanel={openFilesPanel}
          reviewActions={terminal}
          onKeepAll={onKeepAllChanges}
          onDiscardAll={onDiscardAllChanges}
          actionsBusy={reviewBusy}
          variant="card"
        />
      </aside>

      {filesOpen && (
        <PanelSurface label={tr("workspace.title")}>
          <div className="h-full w-full">
            <WorkspacePanel
              taskId={task.id}
              cwd={task.cwd}
              openPath={workspaceOpenPath}
              openNonce={workspaceOpenNonce}
              events={events}
              changedFiles={changedFiles}
              selectedWorkspaceId={selectedWorkspaceId}
              currentWorkspaceId={task.current_workspace_id}
              onSelectWorkspace={setSelectedWorkspaceId}
              reviewActions={terminal}
              onDiscardAll={onDiscardAllChanges}
              actionsBusy={reviewBusy}
              // Publishing is offered for a session on another machine and no
              // other: the Hub refuses the write for a checkout it holds, and a
              // button that could only ever be refused is worse than no button.
              // Asked of the registry rather than of `machine`, so the rule has
              // one home — the same one `resolvePanel` just consulted.
              onPublish={isPanelAvailable("publish", panelCtx) ? openPublishPanel : undefined}
              onFindFile={() => setFileFinderOpen(true)}
              onClose={() => hidePanel(id)}
            />
          </div>
        </PanelSurface>
      )}

      {publishOpen && machine && (
        <PublishPanel
          taskId={task.id}
          machine={machine}
          // Where the Hub remembers the work being. It is what the machine
          // recorded when the session started (or the last publish corrected),
          // and the sheet says "unknown" rather than guessing when there is
          // nothing: only that machine can answer, and it answers when asked.
          repo={task.workspace_repo ?? undefined}
          branch={task.workspace_branch ?? undefined}
          draft={publishDraft}
          // Both answers that change the Hub's row — a publish, and the escape
          // that moves the checkout — land here, so the row under this page is
          // read again. The row is what the sheet opens with and what the
          // repository chip draws; the branch strip beside it asks the machine
          // on its own and is not this.
          onRowChanged={() => void liveResources.refreshTask(task.id, true)}
          onClose={() => hidePanel(id)}
        />
      )}

      {prOpen && (
        <PullRequestPanel
          taskId={task.id}
          active={active}
          // The panel reads this daemon's cache — the rows are the Hub's — and
          // the read behind a row was made by whichever machine holds the
          // checkout. Passing `machine` is what keeps an empty answer reading as
          // "not on this machine yet" instead of "nowhere", and what lets the
          // panel ask the machine that has it.
          elsewhere={machine}
          onClose={() => hidePanel(id)}
        />
      )}

      {/*
        Last, so it is painted over the panels and sheets it can be opened
        from. Selecting a row is what opens the files panel — not the other way
        round — which is why it lives on the page and not inside the panel.
      */}
      <FileQuickOpen
        taskId={task.id}
        open={fileFinderOpen}
        onClose={() => setFileFinderOpen(false)}
        onOpenPath={onQuickOpenPath}
      />
    </div>
  );
}

/** Extract speaker from a raw event payload for awaitingReply detection. */
function parsePayloadSpeaker(payload: unknown): string | undefined {
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    if (typeof p.speaker === "string") return p.speaker;
    if (typeof p.role === "string") return p.role;
  }
  return undefined;
}
