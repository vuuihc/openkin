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
import {
  ApiError,
  cancelTask,
  deleteTask,
  createArtifact,
  answerUserQuestion,
  decideApproval,
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
  type AgentInfo,
  type LimitHit,
  type QueuedPrompt,
  type TaskUsage,
  type TaskLimitWait,
  type Upload,
  type WorkerStep,
} from "../api/client";
import { liveResources } from "../api/liveResources";
import { usePendingResources, useTaskResource } from "../api/useLiveResources";
import ApprovalCard from "../components/cards/ApprovalCard";
import LimitCard from "../components/cards/LimitCard";
import UserQuestionCard from "../components/cards/UserQuestionCard";
import ChatStream from "../components/chat/ChatStream";
import { pendingRefSeqs } from "../components/chat/transcriptProjection";
import Composer from "../components/chat/Composer";
import BranchPicker from "../components/chat/BranchPicker";
import RepoChip from "../components/chat/RepoChip";
import CwdPicker from "../components/chat/CwdPicker";
import PermissionModePicker from "../components/chat/PermissionModePicker";
import ModelPicker from "../components/chat/ModelPicker";
import {
  IconAlert,
  IconBack,
  IconMachine,
  IconPanel,
  IconPullRequest,
  IconTrash,
} from "../components/icons";
import { SkeletonLine, SlowConnectHint } from "../components/Skeleton";
import PanelSurface from "../components/layout/PanelSurface";
import PullRequestPanel from "../components/pr/PullRequestPanel";
import PublishPanel from "../components/pr/PublishPanel";
import ChangedFilesBar from "../components/workspace/ChangedFilesBar";
import WorkspacePanel from "../components/workspace/WorkspacePanel";
import TaskUsageSummary from "../components/usage/TaskUsageSummary";
import WorkerTimeline from "../components/task/WorkerTimeline";
import { workerActivity } from "../components/task/workerActivity";
import { extractChangedFiles } from "../lib/changedFiles";
import { anchoredPendingIds, orderPending } from "../lib/needsYou";
import { queuedMessageSeqs } from "../lib/queuedPrompts";
import { publishDraftFrom } from "../lib/publishDraft";
import { useSlowHint } from "../hooks/useSlowHint";
import { useMachines } from "../hooks/useMachines";
import { remoteMachine } from "../lib/devices";
import { useT } from "../i18n/react";
import { agentAvatarMeta, agentDisplayName } from "../lib/agentMention";
import { projectLabel, toWorkspaceRelativePath } from "../lib/paths";
import { isKinDesktop } from "../lib/desktop";
import { normalizePermissionMode, type PermissionMode } from "../lib/permissionMode";
import { clearFollowUpDraft, getFollowUpDraft, setFollowUpDraft } from "../lib/followUpDraft";
import { clearSessionScroll, getSessionScroll, setSessionScroll } from "../lib/sessionScroll";
import { modelsForAgent } from "../lib/agentModels";
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
};

export default function TaskDetailPage({ taskId, active = true }: TaskDetailPageProps) {
  const { id: paramId = "" } = useParams();
  const id = taskId || paramId;
  const navigate = useNavigate();
  const tr = useT();
  const { machines } = useMachines();
  const detail = useTaskResource(id);
  const pending = usePendingResources();
  const task = detail.data.task;
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
  const [usage, setUsage] = useState<TaskUsage | null>(null);
  const [limitWait, setLimitWait] = useState<TaskLimitWait | null>(null);
  const [workerSteps, setWorkerSteps] = useState<WorkerStep[]>([]);
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedPrompt[]>([]);
  const [usageLoading, setUsageLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [awaitingReply, setAwaitingReply] = useState(false);
  const [composerModel, setComposerModel] = useState("");
  const [composerPermission, setComposerPermission] = useState<PermissionMode>("default");
  // Latest follow-up draft fields for this task (localStorage is source of truth).
  const draftPromptRef = useRef("");
  const draftAttachmentsRef = useRef<Upload[]>([]);
  const [stopping, setStopping] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [busy, setBusy] = useState<Record<string, "approved" | "denied">>({});
  const [answerBusy, setAnswerBusy] = useState<Record<string, boolean>>({});
  const [limitBusy, setLimitBusy] = useState<string | null>(null);
  const [focusIdx, setFocusIdx] = useState(0);
  const [agents, setAgents] = useState<AgentInfo[]>([]);

  // The panel's rows: the plan table (what each worker was asked) joined to
  // the tool calls on the event stream (what it is doing). Derived, because a
  // second copy of either source is a second thing to keep in step.
  const workerRows = useMemo(() => workerActivity(events, workerSteps), [events, workerSteps]);
  const [workspaceOpenPath, setWorkspaceOpenPath] = useState<string | null>(null);
  const [workspaceOpenNonce, setWorkspaceOpenNonce] = useState(0);
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
    lastObservedEventSeq.current = 0;
    setUsage(null);
    setLimitWait(null);
    setWorkerSteps([]);
    setQueuedPrompts([]);
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
          if (active) setQueuedPrompts(prompts);
        })
        .catch(() => {
          if (active) setQueuedPrompts([]);
        });
    };
    const timer = window.setTimeout(load, 250);
    const interval = isTerminal(task.status) ? undefined : window.setInterval(load, 3000);
    return () => {
      active = false;
      window.clearTimeout(timer);
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, [id, task?.id, task?.status, events.length]);

  // Stable identity, so the stream only re-renders when the queue really changed.
  const queuedSeqs = useMemo(() => queuedMessageSeqs(queuedPrompts), [queuedPrompts]);

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

  useEffect(() => {
    if (!active) return;
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      const list = needsYou;
      if (!list.length) return;
      if (e.key === "j" || e.key === "J") {
        setFocusIdx((i) => Math.min(list.length - 1, i + 1));
      } else if (e.key === "k" || e.key === "K") {
        setFocusIdx((i) => Math.max(0, i - 1));
      } else if (e.key === "a" || e.key === "A") {
        const cur = list[focusIdx] ?? list[0];
        if (cur?.kind === "approval") void onDecide(cur.id, "approved");
      } else if (e.key === "d" || e.key === "D") {
        const cur = list[focusIdx] ?? list[0];
        if (cur?.kind === "approval") void onDecide(cur.id, "denied");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, needsYou, focusIdx]);

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

  async function onDecide(approvalId: string, decision: "approved" | "denied") {
    setBusy((b) => ({ ...b, [approvalId]: decision }));
    try {
      const updated = await decideApproval(approvalId, decision);
      liveResources.applyMessage({ kind: "approval_update", data: updated });
    } catch (e) {
      pushToast(e instanceof Error ? e.message : tr("task.decisionFailed"), "error");
    } finally {
      setBusy((b) => {
        const next = { ...b };
        delete next[approvalId];
        return next;
      });
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

  function persistFollowUpDraft(prompt: string, attachments = draftAttachmentsRef.current) {
    if (!id) return;
    draftPromptRef.current = prompt;
    draftAttachmentsRef.current = attachments;
    setFollowUpDraft(id, { prompt, attachments });
  }

  async function onComposer(text: string, opts?: { interrupt?: boolean }) {
    if (!task) return;
    setSending(true);
    setAwaitingReply(true);
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
      if (composerPermission !== currentPerm) send.permission_mode = composerPermission;
      if (opts?.interrupt) send.interrupt = true;
      const t = await followUpPrompt(task.id, text, Object.keys(send).length ? send : undefined);
      liveResources.applyTaskSnapshot(t, requestRevision);
      clearFollowUpDraft(task.id);
      draftPromptRef.current = "";
      draftAttachmentsRef.current = [];
      if (wasRunning) {
        // Say which of the two things happened. The queue is the default, so
        // claiming an interrupt here would be a lie the user only discovers when
        // the round they thought they had stopped keeps going.
        pushToast(tr(opts?.interrupt ? "task.interruptedGuide" : "task.queuedGuide"), "info");
      }
    } catch (err) {
      // Re-throw so Composer restores the cleared input + draft, and shows the toast.
      throw err instanceof Error ? err : new Error(tr("task.sendFailed"));
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
        title: deriveArtifactTitle(content, task.title || tr("api.untitled")),
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

  function onOpenWorkspacePath(filePath: string) {
    if (!task) return;
    // If the path is already a canonical repo-relative path, use it directly.
    // Otherwise resolve against the task's cwd as legacy fallback.
    const next = toWorkspaceRelativePath(task.cwd, filePath);
    if (!next) {
      pushToast(tr("workspace.outsideWorkspace"), "error");
      return;
    }
    showPanel(id, "files");
    setWorkspaceOpenPath(next);
    // Bump the nonce so re-clicking the same path re-loads/focuses it.
    setWorkspaceOpenNonce((n) => n + 1);
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

  if (loading) {
    return (
      <div className="flex-1 flex flex-col min-h-0 bg-kin-bg">
        <div className="h-11 flex-none border-b border-[var(--kin-hairline)] px-5 flex items-center">
          <SkeletonLine className="h-4 w-40" />
        </div>
        <div className="flex-1 p-6 space-y-3 max-w-conversation mx-auto w-full">
          <SkeletonLine className="h-16 w-3/4 ml-auto rounded-2xl" />
          <SkeletonLine className="h-12 w-2/3 rounded-xl" />
          <SlowConnectHint show={slow} />
        </div>
      </div>
    );
  }

  if (error && !task) {
    return (
      <div className="flex-1 p-6 space-y-3">
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
      <div className="flex-1 p-6 space-y-3">
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
  const anchoredIds = anchoredPendingIds(needsYou);
  const pendingSlots: Record<string, ReactNode> = {};
  for (const entry of needsYou) {
    if (anchoredIds.has(entry.id)) pendingSlots[entry.id] = renderPendingCard(entry);
  }
  const unanchored = needsYou.filter((entry) => !anchoredIds.has(entry.id));

  function renderPendingCard(entry: NeedsYouEntry) {
    const focused = needsYou[focusIdx]?.id === entry.id;
    return (
      <div data-pending-id={entry.id}>
        {entry.kind === "approval" ? (
          <ApprovalCard
            approval={entry.item}
            focused={focused}
            busy={busy[entry.id] ?? null}
            onApprove={() => void onDecide(entry.id, "approved")}
            onDeny={() => void onDecide(entry.id, "denied")}
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
  const prOpen = panel === "pr";
  const publishOpen = panel === "publish";
  const project = projectLabel(task.cwd);
  const degraded = wsStatus !== "connected" && !terminal;
  const hostAgentName =
    agents.find((agent) => agent.id === task.agent)?.name ?? agentDisplayName(task.agent || "kin");
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

  return (
    <div className="flex-1 min-w-0 min-h-0 flex relative">
      <div className="flex-1 min-w-0 min-h-0 flex flex-col kin-surface-chat">
        {/*
          Two rows on a phone, one from `md` up.

          The controls are all `flex-none`, so on a 390px screen they could not
          shrink and the title — the only flexible item — absorbed the whole
          deficit: it rendered at 0px and the tail of the row (the project link,
          the status, and Stop) was cut off by `<main overflow-hidden>`. The
          phone's 44pt floor made each control wider, which is what turned a
          squeeze into a clip. `w-full` on the cluster sends it to its own line
          deterministically, so the title gets the full width.

          That was still not enough on a 320px screen, which is measurable now
          that a running session can be rendered on demand (the fixture daemon):
          with a live task the cluster wants 358px at 390 (it fits, exactly, 0px
          to spare) and at 320 its first child measured at x=-2 — clipped off
          the *left* edge, where no amount of scrolling can reach it, because
          `justify-end` overflows the start of the line. Hence the three
          classes below: `justify-start` (overflow goes right, where it can be
          scrolled to), `overflow-x-auto` (so it can be), and `whitespace-nowrap`
          (without it the labels wrap to two lines and the row grows instead).
        */}
        <div
          className="min-h-11 flex-none flex flex-wrap items-center px-4 sm:px-5 border-b border-[var(--kin-hairline)]"
          style={{ WebkitAppRegion: "drag" } as CSSProperties}
        >
          <button
            type="button"
            onClick={goBack}
            aria-label={tr("app.back")}
            className="md:hidden mr-2 text-kin-blue-ink min-w-[44px] min-h-11 -ml-2 flex items-center justify-center"
            style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
          >
            <IconBack size={18} strokeWidth={2} />
          </button>
          <div className="min-w-0 flex-1">
            <div className="text-strong font-semibold text-kin-text truncate">
              {task.title || displayUserPrompt(task.prompt || "")}
            </div>
          </div>
          <div
            className="w-full justify-start md:ml-2 md:w-auto flex items-center gap-2 overflow-x-auto kin-scroll whitespace-nowrap text-body text-kin-muted flex-none"
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
              <span className="hidden sm:inline">
                {tr("newChat.hostAgent", { name: hostAgentName })}
              </span>
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
                className="text-kin-secondary hover:text-kin-text hover:underline"
              >
                {project}
              </Link>
            ) : (
              <span>{project}</span>
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

        {error && (
          <div
            className="flex-none border-b border-kin-red/30 bg-kin-red/10 px-4 py-2 text-body text-kin-red-ink"
            role="alert"
          >
            {error}
          </div>
        )}

        {/* Below the rail breakpoint: keep compact chips so usage/diff stay reachable without the rail. */}
        <div className="min-[1600px]:hidden flex-none border-b border-[var(--kin-hairline)]">
          <TaskUsageSummary usage={usage} loading={usageLoading} />
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

        <div
          ref={scrollRef}
          onScroll={onChatScroll}
          className={
            scrollReady
              ? "flex-1 overflow-y-auto kin-scroll py-5 min-h-0"
              : "flex-1 overflow-y-auto kin-scroll py-5 min-h-0 invisible"
          }
        >
          <WorkerTimeline rows={workerRows} onOpenPath={onOpenWorkspacePath} />
          <ChatStream
            events={events}
            onOpenPath={onOpenWorkspacePath}
            fallbackUserPrompt={displayUserPrompt(task.prompt || "")}
            loading={!terminal || sending || awaitingReply}
            loadingSpeaker={task.agent || "kin"}
            hostSpeaker={task.agent || "kin"}
            hostModel={task.model}
            queuedSeqs={queuedSeqs}
            pendingSlots={pendingSlots}
            showMessageActions={terminal}
            actionsBusy={actionBusy}
            onRetry={(seq) => void onRetry(seq)}
            onFork={(seq) => void onFork(seq)}
            onSaveArtifact={(text) => void onSaveArtifact(text)}
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
                    <kbd className="px-1 border border-[var(--kin-hairline-strong)] rounded">A</kbd>{" "}
                    {tr("chat.approve")} ·{" "}
                    <kbd className="px-1 border border-[var(--kin-hairline-strong)] rounded">D</kbd>{" "}
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

        <div className="flex-none px-4 sm:px-7 pb-3 sm:pb-3.5 pt-1.5">
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
              hostAgentId={task.agent || ""}
              busy={sending}
              running={!terminal}
              stopping={stopping}
              disabled={sending || stopping}
              initialValue={followUpDraft.prompt}
              initialAttachments={followUpDraft.attachments}
              placeholder={
                !terminal
                  ? tr("composer.queuedWhileRunning")
                  : tr("composer.followUpPlaceholder", { name: hostAgentName })
              }
              onValueChange={(v) => persistFollowUpDraft(v)}
              onAttachmentsChange={(atts) => persistFollowUpDraft(draftPromptRef.current, atts)}
              onSubmit={onComposer}
              onStop={onStop}
            />
            {/* One row, scrolled sideways when it does not fit — it has to overflow
                for that: an item allowed to shrink is squeezed to nothing first
                and paints its text over the chip next to it, which is what a
                long path next to a repository name did on a phone. */}
            <div className="flex items-center gap-x-2 gap-y-1 px-0.5 min-w-0 overflow-x-auto kin-scroll">
              <PermissionModePicker
                value={composerPermission}
                disabled={sending || stopping}
                compact
                onChange={setComposerPermission}
              />
              <span className="text-kin-muted/50 flex-none select-none" aria-hidden>
                ·
              </span>
              <ModelPicker
                value={composerModel}
                models={modelsForAgent(agents, task.agent || "")}
                source={agents.find((agent) => agent.id === task.agent)?.model_list_source}
                status={agents.find((agent) => agent.id === task.agent)?.model_list_status}
                disabled={sending || stopping}
                compact
                onChange={setComposerModel}
              />
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
