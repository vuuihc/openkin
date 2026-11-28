import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Link,
  useLocation,
  useNavigate,
  useNavigationType,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { goBackToList } from "../lib/phoneBack";
import { currentPhoneLocation, isPhoneLayout, phonePush } from "../lib/phoneNavigation";
import {
  ApiError,
  archiveTask,
  cancelTask,
  cancelWorkerStep,
  deleteTask,
  answerUserQuestion,
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
  reorderQueuedPrompts,
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
import { useCoarsePointer } from "../hooks/useMediaQuery";
import { usePendingResources, useTaskResource } from "../api/useLiveResources";
import { isImeKeyEvent } from "../lib/ime";
import { taskIdFromPathname } from "../lib/sessionCache";
import { runningSubagentCount } from "../lib/subagents";
import ApprovalCard from "../components/cards/ApprovalCard";
import LimitCard from "../components/cards/LimitCard";
import UserQuestionCard from "../components/cards/UserQuestionCard";
import ChatStream from "../components/chat/ChatStream";
import { findSpeakerModel, pendingRefSeqs } from "../components/chat/transcriptProjection";
import type { SubmitFailure } from "../components/chat/Composer";
import {
  forgetPendingSend,
  peekPendingSend,
  pendingSend,
  settlePendingSendList,
  type PendingSend,
} from "../lib/pendingSend";
import IosSpinner from "../components/IosSpinner";
import { SlowConnectHint } from "../components/Skeleton";
import ActionSheet, { type ActionSheetRow } from "../components/ui/ActionSheet";
import FileQuickOpen from "../components/workspace/FileQuickOpen";
import TaskComposerDock from "../components/task/TaskComposerDock";
import TaskPanels from "../components/task/TaskPanels";
import WorkerTimeline from "../components/task/WorkerTimeline";
import TaskHeader from "../components/task/TaskHeader";
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
  queueOrderAfterMove,
  queuePositions,
  startEdit,
  startWithdrawal,
  withoutWithdrawn,
} from "../lib/queuedPrompts";
import { publishDraftFrom } from "../lib/publishDraft";
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
import { panelForView, resolvePanel, type PanelContext } from "../lib/panels";
import { dropSearchParam, parseWorkspaceLink, patchWorkspaceLink } from "../lib/workspaceDeepLink";
import { useAppStore } from "../store/appStore";
import { parseUserPrompt } from "../lib/attachments";
import { taskDisplayTitle } from "../lib/taskTitle";

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

/** A modifier click opens the link the browser's way; the phone's in-app
 *  return must not swallow a new tab or window. */
function keepsBrowserLink(event: ReactMouseEvent): boolean {
  return event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
}

/** The same permutation, id for id. */
function sameOrder(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * The browser entry's index, or null when `window.history` is not this route's
 * stack.
 *
 * `BrowserRouter` keeps its entries in the document's history, so `idx` is the
 * reader's real stack. A `MemoryRouter` (tests, and the rare embedded host)
 * drives the router without moving the document: its `idx` would be some other
 * stack's, and popping it would leave the screen rather than go back.
 */
function routeHistoryIndex(pathname: string): number | null {
  if (typeof window === "undefined") return null;
  if (window.location.pathname !== pathname) return null;
  const idx = (window.history.state as { idx?: unknown } | null)?.idx;
  return typeof idx === "number" && Number.isFinite(idx) ? idx : null;
}

/** The conversation column's measured width (0 before its first report), so
 *  compact follows the column, not the window; 560 is the icon-only verb
 *  row's floor (title floor, five verbs, project, Stop). */
function useColumnWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect?.width;
      if (typeof next === "number" && next > 0) setWidth(next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

export default function TaskDetailPage({
  taskId,
  active = true,
  agentRoles = [],
  fallbackTask,
}: TaskDetailPageProps) {
  const { id: paramId = "" } = useParams();
  const id = taskId || paramId;
  const navigate = useNavigate();
  const location = useLocation();
  const tr = useT();
  const locationRef = useRef(location);
  locationRef.current = location;
  const activeRef = useRef(active);
  activeRef.current = active;
  const idRef = useRef(id);
  idRef.current = id;
  // The session-actions sheet is a phone surface; below `md` it is the way to
  // stop, share or find. It is mounted only there, so a Mac never carries the
  // sheet's Escape/Back handlers behind its chip row.
  const wide = useMinWidth(768);
  // Compact by column width OR a finger (an iPad is desktop-wide with touch),
  // never the viewport alone. The row itself gives up its words (container
  // query) before this fires, so 560 only compacts when even the icon row no
  // longer fits; at 760 it compacted an 1100 Mac that had room for the verbs.
  const columnRef = useRef<HTMLDivElement>(null);
  const columnWidth = useColumnWidth(columnRef);
  const coarsePointer = useCoarsePointer();
  const compact = !wide || coarsePointer || (columnWidth > 0 && columnWidth < 560);
  const { machines } = useMachines();
  const detail = useTaskResource(id);
  const pending = usePendingResources();
  // A cached list row is for drawing the chrome while the detail is on its
  // way; it must not keep a deleted conversation on screen. Deletion outranks
  // the cache, so the not-found branch below still owns that answer.
  const gone =
    detail.data.deleted || (detail.error instanceof ApiError && detail.error.status === 404);
  const task = detail.data.task ?? (gone ? null : fallbackTask) ?? null;
  const events = detail.data.events;
  // The header's one honest number: subagent calls the running turn still has
  // in flight. Read from the raw events, not the transcript projection — the
  // projection drops some task-only child tools and would undercount.
  const subagentsRunning = useMemo(() => runningSubagentCount(events), [events]);
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
   * The queued confirmation, as a row in the dock rather than a toast over the
   * composer. It goes up when this page queues a follow-up behind a running
   * round, and comes down when a queue read that *started after* that send
   * reports the queue drained — a read begun earlier cannot speak for it.
   */
  const [queuedGuide, setQueuedGuide] = useState(false);
  const queuedGuideSinceRef = useRef<number | null>(null);
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
  /**
   * The newest reorder request. Answers carry their request's number and only
   * the newest one may write the queue: a slow answer to an older tap
   * describes an order the reader has already replaced.
   */
  const queueMoveRequestRef = useRef(0);
  /**
   * The permutation the newest in-flight move sent, so a double tap is one
   * request. `startedAt` bounds it the way an edit is: `apiFetch` has no
   * timeout, and a request the network dropped must not suppress the queue
   * poll or refuse the arrows for the life of the page.
   */
  const pendingMoveRef = useRef<{ request: number; ids: number[]; startedAt: number } | null>(null);
  /** A queue read the poll skipped while a move was in flight. */
  const deferredQueueReadRef = useRef(false);
  // Invalidate callbacks before another conversation renders, on unmount, and
  // when the host hides this pane without changing its id (`active` false):
  // changing a dep runs the cleanup, so an answer that lands after the reader
  // left cannot paint or toast over whatever they are looking at now.
  useLayoutEffect(
    () => () => {
      queueMoveRequestRef.current += 1;
      pendingMoveRef.current = null;
      deferredQueueReadRef.current = false;
    },
    [active, id],
  );
  const [usageLoading, setUsageLoading] = useState(true);
  const [sending, setSending] = useState(false);
  /**
   * A send owns one pin of the transcript, not the whole in-flight window.
   *
   * `sending` can outlive the moment the reader reads: a queued message on a
   * round blocked by an approval is answered long after the send. Following
   * every event for that whole window dragged a reader who had scrolled up
   * back to the bottom — the transcript lost the place they chose, and a
   * conversation switch then restored that bottom instead of their line. The
   * send pins once, when its bubble lands; after that the reader's scroll wins.
   */
  const pinAfterSendRef = useRef(false);
  const [awaitingReply, setAwaitingReply] = useState(false);
  /**
   * Sends the transcript has not echoed yet. The composer clears the input the
   * moment the person submits, so without these the message they just wrote is
   * gone from the screen until the daemon's own event arrives.
   *
   * A brand-new conversation starts with one already: the draft route drew the
   * bubble, and the create answer handed it over so this route's first frame —
   * still before its detail GET — draws the same message instead of a
   * skeleton. Reading is pure; the effect below consumes the record.
   */
  const [pendingSends, setPendingSends] = useState<PendingSend[]>(() => {
    const handed = peekPendingSend(id);
    return handed ? [handed] : [];
  });
  /**
   * This conversation was entered from the draft composer, which was raised
   * while the person typed. Read once, at mount, before the effect below
   * forgets the record, and keyed to this pane by the mount itself. On a Mac
   * the composer starts in that same arrangement and takes the caret, so
   * Start does not resize the box the J3 hand-off sampler watches; on a phone
   * it stays compact and does not raise the keyboard.
   */
  const [enteredFromSend] = useState(() => peekPendingSend(id) !== null);
  /**
   * A list row navigates in with the shell's data but not the conversation's:
   * no events, no handed-off send, no failure yet. Until the detail answers
   * there is nothing truthful to draw in the transcript, and the scroller is
   * deliberately invisible until it can be positioned — so without this flag
   * the middle of the page is simply blank. The shell above and the composer
   * below keep drawing from `fallbackTask`.
   */
  const entryWait = !detail.loaded && events.length === 0 && pendingSends.length === 0 && !error;
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
  /**
   * Whether this pane is still the conversation in front. A cached pane keeps
   * its `taskId` prop forever, so the task id alone is not enough.
   */
  const taskInFront = (taskID: string): boolean =>
    activeRef.current &&
    idRef.current === taskID &&
    taskIdFromPathname(currentPhoneLocation()?.pathname ?? locationRef.current.pathname) === taskID;
  /**
   * The visit an answer belongs to. Leaving and reopening the same task, or
   * returning with Back, is a different visit even when the task id matches.
   */
  const viewOrigin = (taskID: string) => {
    const now = currentPhoneLocation();
    return {
      taskID,
      pathname: now?.pathname ?? locationRef.current.pathname,
      key: now?.key ?? locationRef.current.key,
      visit: now?.visit,
    };
  };
  const stillShowing = (origin: ReturnType<typeof viewOrigin>): boolean => {
    if (!taskInFront(origin.taskID)) return false;
    const now = currentPhoneLocation();
    const pathname = now?.pathname ?? locationRef.current.pathname;
    if (pathname !== origin.pathname) return false;
    if (origin.visit !== undefined && now?.visit !== undefined) {
      return now.visit === origin.visit;
    }
    return (now?.key ?? locationRef.current.key) === origin.key;
  };
  const [deleting, setDeleting] = useState(false);
  const [archiving, setArchiving] = useState(false);
  /** Phone-only overflow sheet; the same actions stay as chips from `md` up. */
  const [actionsOpen, setActionsOpen] = useState(false);
  /** The public-link dialog, reachable from the sheet and from the chip row. */
  const [shareOpen, setShareOpen] = useState(false);
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
  const [actionBusy, setActionBusy] = useState(false);
  // The same decision path the floating card uses, so a failure reads the same
  // wherever the reader answered from.
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
  // Bumped only when an applied link says the list (`panel=files`, no `file`):
  // the panel leaves whatever file it was showing. A file the reader picked is
  // the panel's own state, so this is the address's half of "Back to the list".
  const [workspaceShowListNonce, setWorkspaceShowListNonce] = useState(0);
  /**
   * The file finder, owned by the page rather than the files panel: the
   * shortcut works with the panel closed, and the phone's action sheet needs an
   * opener outside it. The panel's sidebar has one too, for the same reason the
   * sheet does.
   */
  const [fileFinderOpen, setFileFinderOpen] = useState(false);
  // A window can cross the breakpoint with the sheet open. The sheet is only
  // mounted below `md`, so widening unmounts it without its dismiss path; the
  // note saying "open find once the sheet is gone" would stay armed for a
  // sheet that is never coming back. Drop both with the sheet.
  useEffect(() => {
    if (!wide) return;
    setActionsOpen(false);
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
  /**
   * New output that arrived while the reader was reading above the fold.
   *
   * A running agent appends below the viewport; saying nothing is how a live
   * session looks stopped, and pinning anyway is how reading becomes
   * impossible. The count is only ever "is it nonzero" on screen, but it is
   * kept as a count so the pill's appearance is one comparison, not a second
   * boolean to keep in step with this one.
   */
  const [unseen, setUnseen] = useState(0);
  /** `events.length` as of the last render that followed or reported. */
  const seenEventCountRef = useRef(events.length);
  /** The task whose events `seenEventCountRef` counts. */
  const followedTaskIdRef = useRef(id);
  /** First paint of this mounted instance: jump to bottom once (no animation). */
  const didInitialScrollRef = useRef(false);
  /**
   * Last known scrollTop while this pane was visible.
   * display:none (keep-alive hide) resets DOM scrollTop, so we restore from here.
   */
  const savedScrollTopRef = useRef<number | null>(id ? getSessionScroll(id) : null);
  /**
   * A saved middle position the scroller could not reach when its pane was
   * shown again — the transcript had not been laid out to that depth yet.
   * Kept until it lands (or the reader scrolls) instead of recording the
   * clamped 0, which would look like "at the end" and let the next event pin
   * the reader to the bottom of a conversation they were reading.
   */
  const pendingRestoreRef = useRef<number | null>(null);
  /**
   * The `scrollTop` this page last set itself while restoring a place.
   *
   * A programmatic assignment fires the same async `scroll` event a reader's
   * scroll does — including one the transcript clamps short of its target.
   * That event is not the reader moving; reading it as one would clear the
   * pending restore and record the clamped position as their place. Dropped
   * as soon as its event arrives (or the task changes).
   */
  const programmaticScrollTopRef = useRef<number | null>(null);
  /**
   * The task this instance opened with.
   *
   * `id` can change under an instance the router reuses, and then everything
   * below has to reset. The *first* run is this pane's mount, though, and there
   * the opening restore owns `stickToBottomRef`: a restored middle place sets
   * it to false, and resetting it here a moment later would let the next event
   * pin the reader to the bottom they just left.
   */
  const mountedTaskIdRef = useRef(id);
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
  // Closing the files panel spends the open-file pulse. The panel consumes the
  // path once; keeping it would replay the last "open this file" on the next
  // open and land inside a file instead of on the list, which is what a fresh
  // open of Files means. Read from the store rather than from the rendered
  // panel because this hook has to run in every render (the page returns early
  // while the task loads), and the files panel is offered whenever there is a
  // task, so the store's answer is the panel's.
  const filesPanelOpen = shownPanel?.view === id && shownPanel.id === "files";
  // The PR and publish are tabs of that same panel, so being on either is not
  // leaving the files surface: the open file survives the visit and is still
  // open — and still in the address — when a lens tab (or the header's Files
  // button) comes back (TASTE 15).
  const prSurfaceOpen = shownPanel?.view === id && shownPanel.id === "pr";
  const publishSurfaceOpen = shownPanel?.view === id && shownPanel.id === "publish";
  // The conversation entry the panel's addresses are stacked on. One close
  // pops back to it instead of pushing a second conversation entry on top
  // (see `closeFilesPanel`).
  const panelBaseIdx = useRef<number | null>(null);
  useEffect(() => {
    if (!filesPanelOpen && !prSurfaceOpen && !publishSurfaceOpen) setWorkspaceOpenPath(null);
  }, [filesPanelOpen, prSurfaceOpen, publishSurfaceOpen]);
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
    const switched = mountedTaskIdRef.current !== id;
    mountedTaskIdRef.current = id;
    taskIdRef.current = id;
    lastObservedEventSeq.current = 0;
    setUsage(null);
    setLimitWait(null);
    setWorkerSteps([]);
    setQueuedPrompts([]);
    queuedPromptsRef.current = [];
    queuedGuideSinceRef.current = null;
    setQueuedGuide(false);
    withdrawnRef.current = new Set();
    setWorkspaceOpenPath(null);
    setWorkspaceOpenNonce(0);
    setWorkspaceShowListNonce(0);
    setSelectedWorkspaceId(undefined);
    // On mount the opening restore decides whether the transcript follows the
    // end; only a conversation swapped into an existing instance resets it.
    if (switched) stickToBottomRef.current = true;
    pendingRestoreRef.current = null;
    programmaticScrollTopRef.current = null;
    panelBaseIdx.current = null;
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
    if (!id || !task || !active) return;
    let live = true;
    const load = () => {
      // A read during a pending write could return the order before that write.
      // The skip is remembered, not just taken: a poll that would have re-read
      // the queue has to run once the move settles, or the queue a terminal
      // event just drained stays stale until the next interval. Past the edit
      // deadline the request no longer owns the queue — a hung move must not
      // suppress the poll for the life of the page.
      const pending = pendingMoveRef.current;
      if (pending && editStillRunning(pending.startedAt, Date.now())) {
        deferredQueueReadRef.current = true;
        return;
      }
      const request = ++queueMoveRequestRef.current;
      // A read is happening now; whatever an earlier poll deferred is covered.
      deferredQueueReadRef.current = false;
      const startedAt = Date.now();
      listQueuedPrompts(id)
        .then((prompts) => {
          if (!live || request !== queueMoveRequestRef.current) return;
          const next = withoutWithdrawn(prompts, withdrawnRef.current);
          queuedPromptsRef.current = next;
          setQueuedPrompts(next);
          // The queued row has done its job once the queue it was raised for
          // has drained. Only a read that began after the send can say that:
          // one already in flight describes the queue from before the message
          // was accepted.
          const guideSince = queuedGuideSinceRef.current;
          if (guideSince !== null && startedAt >= guideSince && next.length === 0) {
            queuedGuideSinceRef.current = null;
            setQueuedGuide(false);
          }
        })
        .catch(() => {
          if (!live || request !== queueMoveRequestRef.current) return;
          queuedPromptsRef.current = [];
          setQueuedPrompts([]);
        });
    };
    const timer = window.setTimeout(load, 250);
    const interval = isTerminal(task.status) ? undefined : window.setInterval(load, 3000);
    return () => {
      live = false;
      window.clearTimeout(timer);
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, [active, id, task?.id, task?.status, events.length, queueReload]);

  // Stable identity, so the stream only re-renders when the queue really changed.
  const queuedSeqs = useMemo(() => queuedMessageSeqs(queuedPrompts), [queuedPrompts]);

  /**
   * The place in line for each transcript message, keyed by its seq.
   *
   * The numbering comes from `queuePositions` over the queue as the daemon
   * sent it — never from a local sort. Rows with `user_seq = 0` are waiting
   * too and occupy a place, but have no transcript message to badge, so they
   * are skipped here and still counted in the length.
   */
  const queuePlaces = useMemo(() => {
    const byID = queuePositions(queuedPrompts);
    const bySeq = new Map<number, number>();
    for (const prompt of queuedPrompts) {
      if (typeof prompt.user_seq !== "number" || prompt.user_seq <= 0) continue;
      const place = byID.get(prompt.id);
      if (place !== undefined) bySeq.set(prompt.user_seq, place);
    }
    return bySeq;
  }, [queuedPrompts]);

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

  /**
   * The ‹ / › in a queued message's badge: move it one slot in the daemon's
   * order.
   *
   * The permutation is built by `queueOrderAfterMove` from the queue as
   * received — the row itself never re-sorts, and neither does this handler.
   * The PUT's answer replaces the whole queue, so what the badges number next
   * is the order the daemon accepted. A 409 means another device moved a row
   * between this console's read and its write: the list here is stale, so say
   * so and re-read instead of guessing. Answers carry their request number;
   * an older answer that lands after a newer one is dropped.
   */
  const onMoveQueued = useCallback(
    (seq: number, delta: -1 | 1) => {
      const queue = queuedPromptsRef.current;
      const row = queue.find((prompt) => prompt.user_seq === seq);
      if (!row) return;
      const order = queueOrderAfterMove(queue, row.id, delta);
      if (!order) return;
      // Two taps before the first answer describe one move, not two: sending
      // the same permutation twice would only make the second race the first.
      // Past the edit deadline the request no longer speaks for the queue, so
      // a tap is a new move again rather than a duplicate of a hung one.
      const pending = pendingMoveRef.current;
      if (
        pending &&
        editStillRunning(pending.startedAt, Date.now()) &&
        sameOrder(pending.ids, order)
      ) {
        return;
      }

      const request = ++queueMoveRequestRef.current;
      pendingMoveRef.current = { request, ids: order, startedAt: Date.now() };
      const settle = () => {
        if (pendingMoveRef.current?.request !== request) return;
        pendingMoveRef.current = null;
        // A poll skipped while this move was in flight asked for a read the
        // answer alone cannot give: another device may have changed the queue
        // meanwhile, and a failed move changes nothing at all. Run it now.
        if (deferredQueueReadRef.current) {
          deferredQueueReadRef.current = false;
          setQueueReload((n) => n + 1);
        }
      };
      reorderQueuedPrompts(id, order).then(
        (prompts) => {
          settle();
          if (request !== queueMoveRequestRef.current) return;
          const next = withoutWithdrawn(prompts, withdrawnRef.current);
          queuedPromptsRef.current = next;
          setQueuedPrompts(next);
        },
        (err: unknown) => {
          settle();
          if (request !== queueMoveRequestRef.current) return;
          if (err instanceof ApiError && err.status === 409) {
            pushToast(tr("chat.queueOrderChanged"), "info");
          } else {
            pushToast(tr("chat.queueMoveFailed"), "error");
          }
          setQueueReload((n) => n + 1);
        },
      );
    },
    [id, pushToast, tr],
  );

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
    if (!(detail.data.deleted && active)) return;
    if (isPhoneLayout()) goBackToList(navigate);
    else navigate("/");
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

  useEffect(() => {
    setPendingSends((current) => settlePendingSendList(current, events));
  }, [events]);

  useEffect(() => {
    // Once this conversation has adopted its handoff, forget the record: a
    // later visit to the same id — Back, a tab, a reload — must draw the
    // transcript, never replay a bubble from the first send.
    forgetPendingSend(id);
  }, [id]);

  const pendingUserMessages = useMemo(
    () => pendingSends.map((send) => ({ key: send.id, text: send.text, images: send.images })),
    [pendingSends],
  );

  // The first prompt drawn before its event lands. Parsed once here rather
  // than in the stream: the raw prompt is the only copy of the pictures, and
  // the normalised text the fallback row receives no longer names them.
  const fallbackPrompt = useMemo(() => parseUserPrompt(task?.prompt || ""), [task?.prompt]);

  const isNearBottom = useCallback((el: HTMLElement, threshold = 96) => {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
  }, []);

  const onChatScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // A position this page just applied is not the reader moving, even though
    // the browser fires `scroll` for it too. Drop the record (stale or not)
    // and the event it belongs to.
    const programmatic = programmaticScrollTopRef.current;
    programmaticScrollTopRef.current = null;
    if (programmatic != null && el.scrollTop === programmatic) return;
    // A hidden pane (display:none) reports 0 for scrollTop, scrollHeight and
    // clientHeight. The reset that clears the scroller — or a flick's last
    // event, delivered after the keep-alive host hid the pane — is not the
    // reader moving, and `isNearBottom` over zeros reads as "at the end".
    // Leave the intent alone: flipping it to "follow" here makes the next
    // show pin the reader to the bottom of the conversation they were reading.
    if (!active || el.clientHeight <= 0) return;
    stickToBottomRef.current = isNearBottom(el);
    // A send's pin belongs to the commit that lands its bubble. Once the
    // reader has taken the transcript somewhere else, that place wins: a
    // later growth must announce itself, never drag them back to the end.
    if (!stickToBottomRef.current) pinAfterSendRef.current = false;
    // Reading at the end is what "caught up" means: drop the offer to go
    // there, whether the reader scrolled down or the content shrank to fit.
    if (stickToBottomRef.current) setUnseen(0);
    // The reader has taken the scroller somewhere themselves; a restore
    // still waiting for layout must not overrule them later.
    pendingRestoreRef.current = null;
    savedScrollTopRef.current = el.scrollTop;
    if (id) setSessionScroll(id, el.scrollTop);
  }, [isNearBottom, active, id]);

  // First paint of this mounted instance: restore saved scroll, else jump to bottom.
  // Instant scrollTop (no smooth). Scroller stays invisible until positioned (scrollReady).
  // Keep-alive hides with display:none which clears DOM scrollTop — we re-apply from
  // savedScrollTopRef / localStorage on activate (see effect below).
  //
  // A handed-off first send is the one case that must not wait for the GET:
  // the bubble is already on screen and belongs under this scroller. Every
  // other entry keeps waiting for the transcript — laying out the empty seed
  // first would clamp a saved position to 0 and overwrite the bookmark.
  useLayoutEffect(() => {
    if (didInitialScrollRef.current) return;
    if (!task) return;
    const el = scrollRef.current;
    if (!el) return;

    if (loading && pendingSends.length === 0) return;
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
  }, [loading, task, events.length, id, isNearBottom, markScrollReady, pendingSends.length]);

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
        if (saved != null) {
          const before = node.scrollTop;
          node.scrollTop = saved;
          // The clamped value still fires `scroll`; remember it so the event
          // is not mistaken for the reader moving (see onChatScroll).
          if (node.scrollTop !== before) programmaticScrollTopRef.current = node.scrollTop;
          // The transcript can be shorter than the reader's place for a
          // frame while its rows lay out again. Keep the bookmark and the
          // reader's intent — recording the clamped position would read as
          // "at the end" and the next event would pin them to the bottom.
          if (node.scrollTop < saved) {
            pendingRestoreRef.current = saved;
            markScrollReady();
            return true;
          }
        }
      }
      pendingRestoreRef.current = null;
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

  // Follow new content only when user was already at bottom, or while the pin a
  // send is owed has not happened yet. Skip while keep-alive-hidden
  // (clientHeight 0); stickToBottomRef keeps intent for restore.
  // Instant pin — never smooth-scroll the main transcript.
  useLayoutEffect(() => {
    if (!didInitialScrollRef.current) return;
    // A place the pane could not reach when it was shown again lands as soon
    // as the transcript grows. It owns the position until then; a send's pin
    // waits behind the reader's own place.
    const pending = pendingRestoreRef.current;
    if (pending != null) {
      const node = scrollRef.current;
      if (!node || node.clientHeight <= 0) return;
      const before = node.scrollTop;
      node.scrollTop = pending;
      // A clamped reach still fires `scroll`; it is this restore, not the
      // reader leaving their place (see onChatScroll).
      if (node.scrollTop !== before) programmaticScrollTopRef.current = node.scrollTop;
      if (node.scrollTop >= pending) {
        pendingRestoreRef.current = null;
        stickToBottomRef.current = isNearBottom(node);
        savedScrollTopRef.current = node.scrollTop;
        if (id) setSessionScroll(id, node.scrollTop);
      }
      return;
    }
    if (!(stickToBottomRef.current || (sending && pinAfterSendRef.current))) return;
    // The send's pin belongs to the commit that lands its bubble. A pane that
    // cannot scroll right now (keep-alive-hidden) spends it rather than
    // deferring it to an unrelated event after the reader comes back.
    pinAfterSendRef.current = false;
    const el = scrollRef.current;
    if (!el || el.clientHeight <= 0) return;
    el.scrollTop = el.scrollHeight;
    stickToBottomRef.current = true;
    savedScrollTopRef.current = el.scrollTop;
    if (id) setSessionScroll(id, el.scrollTop);
  }, [events, approvals, isNearBottom, userQuestions, sending, id]);

  // New output that arrived while the reader was above the fold is reported
  // once, quietly, instead of merely landing out of sight. The pill is an
  // affordance, not a loading state: it is raised on growth and drops as soon
  // as the reader is back at the end, sends a follow-up, or changes session.
  useEffect(() => {
    const previous = seenEventCountRef.current;
    // Re-sync either way: a transcript that shrank (a reload, a lower epoch)
    // must not leave the counter above its new length, or every later growth
    // would look already seen.
    seenEventCountRef.current = events.length;
    if (events.length <= previous) return;
    const arrived = events.length - previous;
    // The opening layout already lands at the end (or is still on its way); a
    // keep-alive-hidden pane is not being read.
    if (!didInitialScrollRef.current || !active) return;
    const el = scrollRef.current;
    if (!el || el.clientHeight <= 0) return;
    // Everything is on screen: there is nothing below the fold to announce.
    if (el.scrollHeight <= el.clientHeight) return;
    // Ask the reader's own follow intent, not a fresh distance. `stickToBottom`
    // is written by the reader's scrolls and by the places this page chooses
    // (the send's pin, a restore, Show newest); the live distance is also moved
    // by things the reader did not choose — the bottom band is part of
    // `clientHeight`, so a composer that gives back a row, or a pill that
    // drops, shrinks the gap under the "caught up" line with no scroll at all,
    // and the arrival that lands next is filed as seen while it is still off
    // screen. That is the 820×1180 tablet's incoming-activity miss. The layout
    // effect above has already run for this commit, so a pin that placed these
    // rows reads as the end here; a pin still owed (a restore holding the
    // reader's place) or one the reader scrolled away from does not.
    if (stickToBottomRef.current) return;
    setUnseen((count) => count + arrived);
  }, [events.length, active]);

  // The counter belongs to the conversation it was raised for: another task
  // has its own transcript, its own place and its own unread output.
  useEffect(() => {
    if (followedTaskIdRef.current === id) return;
    followedTaskIdRef.current = id;
    seenEventCountRef.current = events.length;
    setUnseen(0);
  }, [id, events.length]);

  const showNewest = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Instant, like every other transcript position: the reader asked for the
    // end, not for a ride through the lines in between.
    el.scrollTop = el.scrollHeight;
    pendingRestoreRef.current = null;
    stickToBottomRef.current = true;
    savedScrollTopRef.current = el.scrollTop;
    if (id) setSessionScroll(id, el.scrollTop);
    setUnseen(0);
  }, [id]);

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

  // The band under the transcript names the oldest waiting approval and can
  // decide it — but the card in the transcript already carries Approve and
  // Deny, and two primaries for one decision is what the one-primary rule
  // forbids. So the page watches that card: while it is on screen the band
  // keeps its locator row and drops the duplicate. The card is observed at the
  // transcript scroller, which is what "visible" means here; scroll arithmetic
  // cannot answer it (a card taller than the viewport, a hidden pane, a
  // dislocated scroll position all lie).
  const oldestPending = needsYou[0] ?? null;
  const oldestPendingId =
    oldestPending !== null && oldestPending.kind === "approval" ? oldestPending.id : null;
  // Where the card sits in the stream. A late event can give an unanchored
  // card a place, which remounts its node; the observer has to follow it.
  const oldestPendingSeq = oldestPending?.seq ?? null;
  const [pendingCardOnScreen, setPendingCardOnScreen] = useState(false);
  useEffect(() => {
    // Off screen is the honest starting point, and the answer when the browser
    // has no observer: the band keeps the decision rather than losing it.
    setPendingCardOnScreen(false);
    if (!oldestPendingId) return;
    const root = scrollRef.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    let target: Element | null = null;
    for (const node of root.querySelectorAll("[data-pending-id]")) {
      if (node.getAttribute("data-pending-id") !== oldestPendingId) continue;
      target = node;
      break;
    }
    // A card that is not in the transcript cannot be seen by the reader; the
    // initial `false` already says so.
    if (!target) return;
    const observer = new IntersectionObserver(
      (entries) => {
        // Only this card speaks for this row. An entry about a node the page
        // has since replaced is stale and is dropped rather than deciding
        // whether the band shows its Approve.
        for (const entry of entries) {
          if (entry.target !== target) continue;
          setPendingCardOnScreen(entry.isIntersecting);
        }
      },
      { root },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [oldestPendingId, oldestPendingSeq]);

  // A notification names the card it is about (`/tasks/<id>?focus=<item>`),
  // because "open the conversation" alone makes a reader hunt for the answer
  // they were told was waiting. Consume it once the pending list can answer:
  // move the keyboard cursor to that card, bring it into view, and focus it.
  // The parameter is then dropped, so a refresh or Back does not pull the
  // reader to a card they already saw — and a later tap on the same banner is
  // a fresh navigation rather than a replay of this one.
  const [searchParams] = useSearchParams();
  const { pathname } = useLocation();
  const navigationType = useNavigationType();
  // The route names the conversation the tap was for. A pane kept alive out of
  // sight still renders while the next one loads (`TaskSessionHost`), and it
  // must not answer a link about a different conversation: consuming it there
  // would drop the parameter before the routed pane ever saw it.
  const routedId = taskIdFromPathname(pathname);
  const focusParam = searchParams.get("focus");
  const [revealId, setRevealId] = useState<string | null>(null);
  // The focus key whose post-navigation pending read has landed. State rather
  // than a ref: the answer is what lets the effect below conclude.
  const [pendingRead, setPendingRead] = useState<string | null>(null);
  const consumedFocus = useRef<string | null>(null);
  const requestedFocusRefresh = useRef<string | null>(null);
  const dropFocusParam = useCallback(() => {
    // Raw byte edit, not `URLSearchParams`: a neighbouring `?file=src/a%20b.ts`
    // would be re-encoded (`/` as `%2F`, `%20` as `+`) on its way through.
    const here = locationRef.current;
    const next = dropSearchParam(here.search, "focus");
    if (next === here.search) return;
    navigate({ pathname: here.pathname, search: next }, { replace: true });
  }, [navigate]);
  // The link stops naming an item once it is consumed. Clearing on the way out
  // is what makes a second tap on the same banner a new navigation instead of
  // a replay this pane silently swallows.
  useEffect(() => {
    if (focusParam) return;
    consumedFocus.current = null;
    requestedFocusRefresh.current = null;
    setPendingRead(null);
  }, [focusParam]);
  useEffect(() => {
    if (!active || !focusParam || routedId !== id) return;
    const key = `${id}:${focusParam}`;
    if (consumedFocus.current === key) return;
    const index = needsYou.findIndex((entry) => entry.id === focusParam);
    if (index >= 0) {
      consumedFocus.current = key;
      setFocusIdx(index);
      setRevealId(focusParam);
      dropFocusParam();
      return;
    }
    if (!detail.loaded || !pending.loaded) return;
    // The item is not in the snapshot — but "loaded" is not "fresh": a tap that
    // wakes the app can be judged against the list from before the push
    // arrived. Ask once for a read that starts after this link, and let that
    // answer decide whether the item is gone.
    if (requestedFocusRefresh.current !== key) {
      requestedFocusRefresh.current = key;
      void liveResources.refreshPending(true).finally(() => setPendingRead(key));
      return;
    }
    if (pendingRead !== key) return;
    // A read that followed the link still does not list it: answered on another
    // device, expired, or outside the window. The conversation is the right
    // landing, but the link names nothing now, so it stops claiming otherwise.
    consumedFocus.current = key;
    dropFocusParam();
  }, [
    active,
    routedId,
    focusParam,
    id,
    needsYou,
    detail.loaded,
    pending.loaded,
    pendingRead,
    dropFocusParam,
  ]);

  // `/tasks/<id>?panel=files&file=<path>` is an address, not a moment: a
  // refresh, a paste, a Forward and an arrival from anywhere else all land on
  // the same file. On arrival and on Back/Forward the URL owns the panel; the
  // page's own controls write it instead (and push, one entry per action).
  // A pane kept alive out of sight answers nothing here — the same guard the
  // `?focus=` link uses, because consuming the link there would drop it before
  // the routed pane ever saw it.
  const appliedWorkspaceKey = useRef<string | null>(null);
  /**
   * Remember the conversation entry the panel's addresses are stacked on.
   *
   * An opener calls this while the reader is still on the conversation. An
   * address that already names the panel (a cold deep link, a refresh, a
   * Forward) never passed an opener, so the trail the address implies supplies
   * the depth: a file is two stops above the conversation (the file list, then
   * the conversation), every other addressable surface one. Left null when the
   * document history is not this route's stack, where there is no browser
   * entry to pop.
   */
  const notePanelBase = useCallback((stopsAboveConversation = 0) => {
    if (panelBaseIdx.current !== null) return;
    const here = routeHistoryIndex(locationRef.current.pathname);
    if (here === null) return;
    panelBaseIdx.current = Math.max(0, here - stopsAboveConversation);
  }, []);
  const writeWorkspaceSearch = useCallback(
    (next: string, opts?: { replace?: boolean }) => {
      const here = locationRef.current;
      // Never navigate to the location already showing: React Router would
      // push a second, identical entry for a read that changed nothing.
      if (next === here.search) return;
      navigate({ pathname: here.pathname, search: next }, { replace: opts?.replace });
    },
    [navigate],
  );
  useEffect(() => {
    // A pane kept alive out of sight is not current: drop what it applied, so
    // Back onto the very entry it left re-reads the address instead of
    // trusting a key from before another conversation took the screen.
    if (!active || routedId !== id) {
      appliedWorkspaceKey.current = null;
      return;
    }
    if (!task) return;
    // The focus consumer owns its own key and must drop it first; two writers
    // on one location would put back the parameter the other just removed.
    if (focusParam) return;
    const here = locationRef.current;
    // Keyed by the location's key, which is read here as well as in the guard:
    // Back after a refresh, or two Backs in a row, leave the search and the
    // navigation type ("POP" both times) unchanged, so only the key says the
    // address moved and the newly applied entry still has to run.
    if (appliedWorkspaceKey.current === location.key) return;
    appliedWorkspaceKey.current = location.key;
    const link = parseWorkspaceLink(here.search);
    if (link === null) {
      // Back/Forward to a conversation: the address says no panel, so the pane
      // closes. A push the page made itself already closed it. Publish has no
      // address yet, so it is not this branch's to close.
      if (navigationType === "POP" && (filesPanelOpen || prSurfaceOpen)) {
        hidePanel(id);
        // The reader left the panel by the browser's own Back: the next open
        // starts a fresh stack, so the old conversation depth is not evidence.
        panelBaseIdx.current = null;
      }
      return;
    }
    if (!link.explicit) {
      // A stale `file` names no panel: drop only that key and open nothing.
      writeWorkspaceSearch(dropSearchParam(here.search, "file"), { replace: true });
      return;
    }
    if (link.panel === "pr") {
      // The PR tab is a place now: reading its address opens the surface and
      // rewrites no bytes and adds no entry. A remembered file is handed to
      // the panel as state — nothing opens on arrival, so no nonce bump.
      notePanelBase(1);
      showPanel(id, "pr");
      if (link.file) setWorkspaceOpenPath(link.file);
      return;
    }
    // The URL is canonical after this read (a refusal drops only `file`). It is
    // a no-op for a link that was already clean, so an arrival never grows the
    // history by one.
    writeWorkspaceSearch(patchWorkspaceLink(here.search, { panel: "files", file: link.file }), {
      replace: true,
    });
    notePanelBase(link.file ? 2 : 1);
    showPanel(id, "files");
    if (link.file) {
      if (workspaceOpenPath !== link.file) {
        // Same path + same nonce is ignored inside the panel; bump once per
        // arrival so Forward onto the same file opens it again.
        setWorkspaceOpenPath(link.file);
        setWorkspaceOpenNonce((n) => n + 1);
      }
    } else {
      // The applied link names the list. Whatever file the panel was showing
      // belongs to an entry the reader has left, so drop it — and drop the
      // pulse path too, or Forward onto the file would look like the file the
      // panel already shows and pulse nothing.
      setWorkspaceOpenPath(null);
      setWorkspaceShowListNonce((n) => n + 1);
    }
  }, [
    active,
    routedId,
    id,
    task,
    focusParam,
    navigationType,
    filesPanelOpen,
    prSurfaceOpen,
    hidePanel,
    showPanel,
    notePanelBase,
    workspaceOpenPath,
    writeWorkspaceSearch,
    location.key,
  ]);

  // The card exists only after the render that follows `setFocusIdx`; looking
  // for its node in the same effect would find the previous list. A real page
  // also lays out after that render: the transcript scroller is `invisible`
  // until it has positioned its scroll (`scrollReady`), and a node inside a
  // `visibility:hidden` subtree cannot take focus — `focus()` returns without
  // firing focusin. Keep the reveal pending and retry, rather than consuming
  // the link's landing on a focus call that silently did nothing.
  useEffect(() => {
    if (!revealId) return;
    let raf = 0;
    const deadline = Date.now() + 10000;
    const attempt = (): boolean => {
      const nodes = scrollRef.current?.querySelectorAll("[data-pending-id]") ?? [];
      for (const node of nodes) {
        if (node.getAttribute("data-pending-id") !== revealId) continue;
        node.scrollIntoView?.({ block: "nearest" });
        stickToBottomRef.current = false;
        if (node instanceof HTMLElement) node.focus({ preventScroll: true });
        if (document.activeElement === node) {
          setRevealId(null);
          return true;
        }
        return false;
      }
      return false;
    };
    if (attempt()) return;
    const retry = () => {
      if (attempt()) return;
      if (Date.now() >= deadline) {
        setRevealId(null);
        return;
      }
      raf = requestAnimationFrame(retry);
    };
    raf = requestAnimationFrame(retry);
    return () => cancelAnimationFrame(raf);
  }, [revealId]);

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
    const sent = pendingSend(text, events);
    setPendingSends((current) => [...current, sent]);
    // Sending is choosing the end of the conversation; the pill has nothing
    // left to offer, and the follow effect below pins the new bubble — once.
    setUnseen(0);
    pinAfterSendRef.current = true;
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
        // the round they thought they had stopped keeps going. The queue's
        // confirmation is a row in the dock: a toast sat over the composer for
        // five seconds, and the box the person sends from again is the one
        // surface it must not cover.
        if (opts?.interrupt) {
          pushToast(tr("task.interruptedGuide"), "info");
        } else {
          queuedGuideSinceRef.current = Date.now();
          setQueuedGuide(true);
          // Ask the queue now, not on the next three-second tick: the row is
          // tied to a real waiting prompt, and the read is what proves it.
          setQueueReload((n) => n + 1);
        }
      }
    } catch (err) {
      setPendingSends((current) => current.filter((item) => item.id !== sent.id));
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
      if (!wasArchived && taskInFront(task.id)) leaveConversation();
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
    // The prompt names the conversation the person is about to lose, so it
    // uses the same expression as the header behind it; the id is the last
    // resort because a prompt with no name at all names nothing.
    const title = taskDisplayTitle(task) || task.id;
    const ok = window.confirm(tr("task.deleteConfirm") + (title ? `\n\n${title}` : ""));
    if (!ok) return;
    setDeleting(true);
    try {
      await deleteTask(task.id);
      liveResources.applyMessage({ kind: "task_deleted", data: { id: task.id } });
      clearSessionScroll(task.id);
      clearFollowUpDraft(task.id);
      pushToast(tr("task.deleted"), "info");
      if (taskInFront(task.id)) leaveConversation();
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
    const origin = viewOrigin(task.id);
    setActionBusy(true);
    try {
      // Snapshot branch at this user message (no auto-run). User continues in the new session.
      const t = await forkTask(task.id, { from_seq: fromSeq });
      pushToast(tr("task.forkDone"), "info");
      if (!stillShowing(origin)) return;
      phonePush(navigate, location, `/tasks/${t.id}`);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : tr("task.forkFailed"), "error");
    } finally {
      setActionBusy(false);
    }
  }

  /**
   * A file picked inside the files panel — a tree row, a changed row, or a
   * comment pointing at another file.
   *
   * The panel has already loaded it; this only records the address: exactly
   * one push and one entry, and no arrival pulse, or the panel would read the
   * same file a second time. Two cases are not durable addresses and write the
   * list instead: a generation snapshot (its paths need not exist in the
   * checkout the address resolves against) and a path the checkout cannot
   * name. A link that lands on an error is worse than no link.
   */
  function onPanelSelectPath(filePath: string) {
    if (!task || routedId !== id) return;
    const next = toWorkspaceRelativePath(task.cwd, filePath);
    const file = !next || next === "." || selectedWorkspaceId ? null : next;
    // The workspace root is the panel's Back-to-files, not a new selection:
    // it names the list, and replacing the file entry is what makes Back
    // leave the panel for the conversation instead of cycling between list
    // and file. Any real path pushes one entry, as a pick always did.
    writeWorkspaceSearch(
      patchWorkspaceLink(locationRef.current.search, { panel: "files", file }),
      next === "." ? { replace: true } : undefined,
    );
    // No nonce bump: the panel loaded the file it just reported. Recording the
    // path is what keeps the arrival effect from pulsing it again.
    if (file) setWorkspaceOpenPath(file);
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
    notePanelBase();
    showPanel(id, "files");
    setWorkspaceOpenPath(next);
    // Bump the nonce so re-clicking the same path re-loads/focuses it.
    setWorkspaceOpenNonce((n) => n + 1);
    // A page-owned "open this file" is a user action: it writes the address
    // and pushes one entry. `.` is the checkout itself, not a file, so the URL
    // names the list while the panel still gets the pulse it always did.
    writeWorkspaceSearch(
      patchWorkspaceLink(locationRef.current.search, {
        panel: "files",
        file: next === "." ? null : next,
      }),
    );
    return true;
  }

  /**
   * Whether this task's checkout can name a path — the same rule
   * `onOpenWorkspacePath` applies, asked *before* a control is drawn.
   *
   * The transcript, the worker timeline, the changed-files bar and the approval
   * card all show paths the stream reported, and those paths are not always
   * inside the checkout (a worktree's own state file, an absolute path from a
   * neighbouring repo). A control there could only toast. They pass this
   * predicate instead of re-deriving it, so this function stays the one owner.
   * Absent for surfaces with no cwd (`FloatingApproval`, `ApprovalsPage`),
   * which keep the control they had.
   */
  function canOpenWorkspacePath(filePath: string): boolean {
    if (!task) return false;
    return toWorkspaceRelativePath(task.cwd, filePath) != null;
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

  // The agent's last answer, as the publish tab's opening draft. Recomputed
  // only when the stream changes, because it walks the whole transcript.
  const publishDraft = useMemo(() => publishDraftFrom(events), [events]);

  /** Opening the panel is a place the reader can share: one history entry. */
  function openFilesPanel() {
    notePanelBase();
    showPanel(id, "files");
    writeWorkspaceSearch(
      patchWorkspaceLink(locationRef.current.search, { panel: "files", file: null }),
    );
  }

  /**
   * Closing the panel returns to the entry it was opened from, not a new one.
   *
   * Opening pushed the panel's addresses on top of the conversation. Pushing
   * the conversation again on close would leave `?panel=…` directly beneath
   * the reader, so the phone's top-left Back would reopen the panel it just
   * closed instead of returning to the list (TASTE 15: a close is not a new
   * place). One POP removes every entry the panel added — the file list, a
   * file, a surface switch — in a single step. With no browser entry to pop
   * (the panel never pushed one, or a MemoryRouter drives the address) the
   * close replaces its own entry instead of appending.
   */
  function closeFilesPanel() {
    hidePanel(id);
    const base = panelBaseIdx.current;
    const current = routeHistoryIndex(locationRef.current.pathname);
    if (base !== null && current !== null && current > base) {
      navigate(base - current);
    } else if (current !== null) {
      writeWorkspaceSearch(patchWorkspaceLink(locationRef.current.search, null), {
        replace: true,
      });
    } else {
      // Not this router's browser stack: keep the router's own one-entry
      // contract rather than guessing at a `window.history` that is not ours.
      writeWorkspaceSearch(patchWorkspaceLink(locationRef.current.search, null));
    }
    panelBaseIdx.current = null;
  }

  function toggleFilesPanel() {
    if (filesPanelOpen) closeFilesPanel();
    // Coming back from the PR or publish tab is a change of view inside one
    // panel, so it keeps the file the reader had open (see `showFilesSurface`);
    // opening the panel from the conversation starts from the list.
    else if (prSurfaceOpen || publishSurfaceOpen) showFilesSurface();
    else openFilesPanel();
  }

  /**
   * A lens tab picked while the pull-request or publish tab was in front.
   *
   * The lenses and those surfaces are tabs of one panel, so choosing a lens is
   * choosing the files surface: the page records it the way a file pick does.
   * Unlike `openFilesPanel`, this keeps the file the reader had open in the
   * address — the tab changed the view, not the place (TASTE 15).
   */
  function showFilesSurface() {
    if (!task || routedId !== id) return;
    showPanel(id, "files");
    const open = workspaceOpenPath ? toWorkspaceRelativePath(task.cwd, workspaceOpenPath) : null;
    writeWorkspaceSearch(
      patchWorkspaceLink(locationRef.current.search, {
        panel: "files",
        // "." is the checkout itself, not a file; the address names the list.
        file: open === "." ? null : open,
      }),
    );
  }

  /**
   * The pull-request tab is a place the reader can share. Opening and closing
   * it push one entry each, so Back closes the panel instead of leaving the
   * conversation, and a refresh lands on the same surface. The file the panel
   * remembers stays in the address (TASTE 15); `closeFilesPanel` is still the
   * panel's one close and clears both keys.
   */
  function showPrSurface() {
    notePanelBase();
    showPanel(id, "pr");
    writeWorkspaceSearch(
      patchWorkspaceLink(locationRef.current.search, { panel: "pr", file: null }),
    );
  }

  function togglePrPanel() {
    if (prSurfaceOpen) closeFilesPanel();
    else showPrSurface();
  }

  /**
   * Publish is the workspace panel's fourth tab, so this only moves the surface
   * the one panel is showing — nothing is opened beside it, and the panel's one
   * close still closes it.
   */
  function openPublishPanel() {
    notePanelBase();
    showPanel(id, "publish");
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

  /*
    Who spends the phone's top inset on this route. While the link is down the
    shell's reconnect strip is the topmost element and pads itself for the
    notch (`AppShell`'s `max-md:pt-safe`), so these early returns and the
    `TaskHeader` below must leave it alone — two spenders start the page one
    inset below the strip.
  */
  if (loading && !task) {
    // A cold start lands here: the address is a conversation whose row has not
    // arrived yet. This used to draw a skeleton of the header and two bubbles —
    // a layout for a page that did not exist yet, animating while it waited.
    // The brand mark is what is actually true during that wait: the console is
    // restoring the session. It is one element, it fades in once, and the real
    // page replaces it as soon as the detail answers.
    // `max-md:pt-safe` unless the reconnect strip above already spent it: on
    // a phone this route reserves the inset itself, and centring the mark
    // under the sensor housing is not centred.
    return (
      <div
        className={[
          "flex-1 flex min-h-0 flex-col items-center justify-center gap-4 bg-kin-bg px-6",
          wsStatus === "disconnected" ? "" : "max-md:pt-safe",
        ].join(" ")}
      >
        <div role="status" aria-label={tr("common.loading")} className="kin-wait-enter">
          <IosSpinner />
        </div>
        <SlowConnectHint show={slow} />
      </div>
    );
  }

  if (error && !task) {
    return (
      <div
        className={[
          "flex-1 px-6 pb-6 space-y-3",
          wsStatus === "disconnected" ? "" : "max-md:pt-safe",
        ].join(" ")}
      >
        <Link
          to="/"
          onClick={(event) => {
            if (!isPhoneLayout() || keepsBrowserLink(event)) return;
            event.preventDefault();
            goBackToList(navigate);
          }}
          className="text-strong leading-5 text-kin-blue-ink"
        >
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
      <div
        className={[
          "flex-1 px-6 pb-6 space-y-3",
          wsStatus === "disconnected" ? "" : "max-md:pt-safe",
        ].join(" ")}
      >
        <Link
          to="/"
          onClick={(event) => {
            if (!isPhoneLayout() || keepsBrowserLink(event)) return;
            event.preventDefault();
            goBackToList(navigate);
          }}
          className="text-strong leading-5 text-kin-blue-ink"
        >
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
      <div
        data-pending-id={entry.id}
        // A focused node with no name announces nothing, and this wrapper is
        // what a notification focuses. The card's own title is the name; a
        // settled card is browseable, not a landing target, so it stays
        // unnamed.
        role="group"
        aria-label={
          settled
            ? undefined
            : tr(entry.kind === "approval" ? "approval.cardTitle" : "question.cardTitle")
        }
        // Focusable only by programmatic focus: a notification puts the reader
        // in the panel, and Esc hands the keyboard back to the conversation.
        // It is not a tab stop — the approve and deny buttons are.
        tabIndex={-1}
        className="outline-none"
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          scrollRef.current?.focus();
        }}
      >
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
            canOpenPath={canOpenWorkspacePath}
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
      node.scrollIntoView?.({ block: "nearest" });
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
  const prOpen = panel === "pr";
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
   * is any — a notification tap returns to wherever the reader was — and the
   * session list is the right fallback for a cold deep link.
   *
   * The fallback logic lives in `lib/phoneBack.ts`, shared with the shell's
   * header button, the edge swipe and the other detail screens: one rule, so
   * two back affordances on the same screen cannot disagree.
   */
  function goBack() {
    goBackToList(navigate);
  }

  function leaveConversation() {
    if (isPhoneLayout()) goBackToList(navigate);
    else navigate("/");
  }

  /**
   * The phone header keeps only what says *which* session this is — the agent
   * and the project — and moves the page's verbs into an action sheet. Four
   * chips plus a status plus a project name do not fit 390px; the row used to
   * answer by clipping its tail. From `md` up there is room, so the chips stay
   * and the sheet is not rendered as a second way to reach them.
   */
  const sessionActions: ActionSheetRow[] = [
    {
      id: "find",
      label: tr("chat.find.menu"),
      onSelect: () => setFindOpen(true),
    },
    { id: "share", label: tr("task.share"), onSelect: () => setShareOpen(true) },
    {
      id: "find-file",
      label: tr("workspace.find.action"),
      onSelect: () => setFileFinderOpen(true),
    },
    { id: "files", label: tr("workspace.title"), onSelect: () => toggleFilesPanel() },
    { id: "pr", label: tr("pr.title"), onSelect: () => togglePrPanel() },
    ...(!terminal
      ? [
          {
            id: "stop",
            label: stopping ? tr("task.stopping") : tr("composer.stop"),
            destructive: true,
            disabled: stopping,
            onSelect: () => void onStop(),
          },
        ]
      : []),
    {
      id: "archive",
      label: task?.archived_at ? tr("task.unarchiveSession") : tr("task.archiveSession"),
      disabled: archiving,
      onSelect: () => void onToggleArchive(),
    },
    {
      id: "delete",
      label: tr("task.deleteSession"),
      destructive: true,
      disabled: deleting,
      onSelect: () => void onDelete(),
    },
  ];

  return (
    /*
      The row an open panel becomes a column in. Below `lg` it stays the
      single conversation column it was — the panel is `absolute` there and
      takes itself out of this flex line — and from `lg` up the panel is a
      sibling with its own width (`PanelSurface` `shape="column"`), so the
      diff and the chat are readable at the same time.
    */
    <div className="flex-1 min-w-0 min-h-0 flex flex-col lg:flex-row relative">
      <div ref={columnRef} className="flex-1 min-w-0 min-h-0 flex flex-col kin-surface-chat">
        <TaskHeader
          task={task}
          hostAgentName={hostAgentName}
          hostAgentAvatar={hostAgentAvatar}
          project={project}
          terminal={terminal}
          degraded={degraded}
          // A finished turn has no live state, even if a stale event still
          // looks open: the header must not outlive the run it described.
          subagentsRunning={terminal ? 0 : subagentsRunning}
          filesOpen={filesOpen}
          prOpen={prOpen}
          panelOpen={panel !== null}
          archiving={archiving}
          deleting={deleting}
          stopping={stopping}
          onToggleWorkspace={() => {
            toggleFilesPanel();
          }}
          onTogglePr={() => togglePrPanel()}
          onShare={() => setShareOpen(true)}
          onToggleArchive={onToggleArchive}
          onDelete={onDelete}
          onStop={onStop}
          onBack={goBack}
          onOpenActions={() => setActionsOpen(true)}
          // The shell's reconnect strip, when shown, is the topmost element
          // and already spends the phone top inset; the bar yields to it.
          topInset={wsStatus !== "disconnected"}
          // One surface at a time: bringing the list back closes the panel
          // rather than leaving both columns to squeeze the conversation.
          onShowList={() => closeFilesPanel()}
          compact={compact}
          // One bar, chosen here: below `md` the phone bar, above it the
          // desktop bar. Rendering both and letting CSS hide one left two
          // Files and two Session actions controls in the accessible tree.
          phone={!wide}
          changedFileCount={changedFiles.length}
        />

        {/* The tablet's overflow is this same sheet; `anyWidth` keeps it
            visible above the phone breakpoint. */}
        {compact && (
          <ActionSheet
            open={actionsOpen}
            onClose={() => setActionsOpen(false)}
            anyWidth={wide}
            title={tr("task.sessionActions")}
            // Two facts this sheet has to answer before a destructive row: which
            // machine the actions run on, and (on a phone) which project the
            // conversation belongs to. The phone bar stopped carrying the second
            // one when it became one text line (KIN-QUALITY-001, D16); the footer
            // strip that used to name the machine is below `md` too.
            subtitle={
              project || machine ? (
                <span className="flex flex-col">
                  {project ? (
                    <span className="block truncate">
                      {[project, task?.workspace_branch].filter(Boolean).join(" · ")}
                    </span>
                  ) : null}
                  {machine ? (
                    <span className="block truncate">
                      {machine.known
                        ? tr("machine.runsOn", { name: machine.text })
                        : tr("machine.runsOnUnknown", { name: machine.text })}
                    </span>
                  ) : null}
                </span>
              ) : undefined
            }
            rows={sessionActions}
          />
        )}
        <ShareDialog open={shareOpen} onClose={() => setShareOpen(false)} taskId={task.id} />

        {/* One honest message, and only when the shell's reconnect strip is
            not already saying it; the content stays. */}
        {error && wsStatus !== "disconnected" && (
          <div
            className="flex-none border-b border-kin-red/30 bg-kin-red/10 px-4 py-2 text-body text-kin-red-ink"
            role="alert"
          >
            {error}
          </div>
        )}

        {/* The transcript slot; new activity is a row in the composer lane. */}
        <div className="flex-1 min-h-0 flex flex-col">
          {entryWait ? (
            /*
              The transcript slot's waiting state. It carries the region's own
              name because it is what the reader is waiting on, and it is the
              boot screen's tile rather than the blue action accent, so entering
              a conversation looks like the app starting. The scroller is not
              mounted here at all: its only waiting row (`chat.thinking`) would
              be invisible, and it would claim a conversation that may already
              be finished is still thinking.
            */
            <div
              role="region"
              aria-label={tr("task.transcript")}
              className="kin-wait-enter flex flex-1 min-h-0 flex-col items-center justify-center gap-4 px-6"
            >
              <div role="status" aria-label={tr("common.loading")}>
                <IosSpinner />
              </div>
            </div>
          ) : (
            <div
              ref={scrollRef}
              onScroll={onChatScroll}
              // The focus sink the approval panel hands the keyboard back to on
              // Esc; `-1` keeps a large scroll area out of the tab order.
              role="region"
              aria-label={tr("task.transcript")}
              tabIndex={-1}
              className={
                // `phone-approval-clearance` reserves the band the floating
                // 等待处理 strip publishes, so the last queued row can rest
                // above the strip instead of under it. Phone widths only; on
                // a wide screen the rule does not apply and the pane does not
                // move. Both branches name it: the invisible pre-positioning
                // scroller is the same element a frame later.
                scrollReady
                  ? "flex-1 overflow-y-auto kin-scroll py-5 min-h-0 phone-approval-clearance outline-none"
                  : "flex-1 overflow-y-auto kin-scroll py-5 min-h-0 phone-approval-clearance invisible outline-none"
              }
            >
              <WorkerTimeline
                rows={workerRows}
                onOpenPath={onOpenWorkspacePath}
                canOpenPath={canOpenWorkspacePath}
                // A settled task has nothing left to stop; a stale running row is
                // the poll's problem, not a button the reader can use.
                onStop={isTerminal(task.status) ? undefined : onStopWorker}
                stoppingKey={workerStoppingKey}
              />
              <ChatStream
                events={events}
                onOpenPath={onOpenWorkspacePath}
                canOpenPath={canOpenWorkspacePath}
                fallbackUserPrompt={fallbackPrompt.text}
                fallbackUserPromptImages={fallbackPrompt.images}
                messageScope={task.id}
                loading={!detail.loaded || !terminal || sending || awaitingReply}
                taskStatus={task.status}
                loadingSpeaker={task.agent || "kin"}
                hostSpeaker={task.agent || "kin"}
                hostModel={task.model}
                queuedSeqs={queuedSeqs}
                onUnqueue={onWithdrawQueued}
                onEditQueued={onEditQueued}
                queuePositions={queuePlaces}
                queueLength={queuedPrompts.length}
                onMoveQueued={onMoveQueued}
                pendingSlots={pendingSlots}
                showMessageActions={terminal}
                actionsBusy={actionBusy}
                onRetry={(seq) => void onRetry(seq)}
                onFork={(seq) => void onFork(seq)}
                findOpen={findOpen}
                onFindOpenChange={setFindOpen}
                findShortcut={active && panel === null && !fileFinderOpen}
                findSeed={findSeed}
                pendingUserMessages={pendingUserMessages}
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
          )}
        </div>

        <TaskComposerDock
          active={active}
          task={task}
          terminal={terminal}
          detailLoaded={detail.loaded}
          agents={agents}
          agentRoles={agentRoles}
          hostAgentName={hostAgentName}
          hostAgentAvatar={hostAgentAvatar}
          sending={sending}
          stopping={stopping}
          initialValue={followUpDraft.prompt}
          initialAttachments={followUpDraft.attachments}
          // A refill asks for the caret; so does arriving from Start, where
          // the draft composer was already raised. Only a Mac takes it
          // (`focusSignal` on a phone would raise the keyboard unasked).
          focusSignal={refill.taskID === task.id ? refill.n : wide && enteredFromSend ? 1 : 0}
          fileSearch={searchSourceFiles}
          onValueChange={(v) => persistFollowUpDraft(v)}
          onAttachmentsChange={(atts) => persistFollowUpDraft(draftPromptRef.current, atts)}
          onSubmit={onComposer}
          onStop={onStop}
          composerModel={composerModel}
          onComposerModelChange={setComposerModel}
          composerPermissionMode={composerPermissionMode}
          onComposerPermissionChange={setComposerPermission}
          taskAgentModels={taskAgentModels}
          taskAgentModelSource={taskAgentModelSource}
          taskAgentModelStatus={taskAgentModelStatus}
          taskPermissionModes={taskPermissionModes}
          transcriptModel={transcriptModel}
          usage={usage}
          usageLoading={usageLoading}
          machine={machine}
          waitingCount={needsYou.length}
          pendingIsApproval={needsYou[0]?.kind === "approval"}
          pendingCardOnScreen={pendingCardOnScreen}
          pendingApprovalBusy={needsYou[0] ? Boolean(busy[needsYou[0].id]) : false}
          onRevealFirstPending={revealFirstPending}
          unseen={unseen}
          showNewest={showNewest}
          queuedGuide={queuedGuide}
          // The oldest waiting decision, through the same path the inline card
          // uses: one decision implementation, two places to reach it.
          onApproveFirstPending={() => {
            const first = needsYou[0];
            if (first) void decideAndKeep(first.id, "approved");
          }}
        />
      </div>

      <TaskPanels
        task={task}
        machine={machine}
        panel={panel}
        active={active}
        topInset={wsStatus !== "disconnected"}
        panelCtx={panelCtx}
        usage={usage}
        usageLoading={usageLoading}
        events={events}
        changedFiles={changedFiles}
        reviewBusy={reviewBusy}
        terminal={terminal}
        workspaceOpenPath={workspaceOpenPath}
        workspaceOpenNonce={workspaceOpenNonce}
        workspaceShowListNonce={workspaceShowListNonce}
        selectedWorkspaceId={selectedWorkspaceId}
        onSelectWorkspace={setSelectedWorkspaceId}
        onOpenPath={onOpenWorkspacePath}
        onPanelSelectPath={onPanelSelectPath}
        onOpenFilesPanel={openFilesPanel}
        // The tab opens the surface; it does not toggle it. Only the header
        // button and the phone action sheet toggle, which is why the panel
        // itself cannot be the thing that decides.
        onOpenPr={showPrSurface}
        onShowFiles={showFilesSurface}
        onKeepAll={onKeepAllChanges}
        onDiscardAll={onDiscardAllChanges}
        onPublish={openPublishPanel}
        onFindFile={() => setFileFinderOpen(true)}
        onSendFollowUp={async (text) => {
          // Diff comments are one ordinary follow-up: same pending bubble, same
          // queue-vs-interrupt rule. A rejection travels back to the tray, which
          // keeps every comment and says on its own surface that the send
          // failed — there is no composer here to restore or toast from.
          await onComposer(text);
        }}
        onClosePanel={() => closeFilesPanel()}
        publishDraft={publishDraft}
        onPublishRowChanged={() => void liveResources.refreshTask(task.id, true)}
      />

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
