import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
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
  getToken,
  isTerminal,
  listAgents,
  listEvents,
  listWorkerSteps,
  limitContinue,
  restoreTaskWorkspace,
  retryTask,
  type AgentInfo,
  type LimitHit,
  type TaskUsage,
  type TaskLimitWait,
  type Upload,
  type WorkerStep,
} from "../api/client";
import { liveResources } from "../api/liveResources";
import {
  usePendingResources,
  useTaskResource,
} from "../api/useLiveResources";
import ApprovalCard from "../components/cards/ApprovalCard";
import LimitCard from "../components/cards/LimitCard";
import UserQuestionCard from "../components/cards/UserQuestionCard";
import ChatStream from "../components/chat/ChatStream";
import Composer from "../components/chat/Composer";
import BranchPicker from "../components/chat/BranchPicker";
import CwdPicker from "../components/chat/CwdPicker";
import PermissionModePicker from "../components/chat/PermissionModePicker";
import ModelPicker from "../components/chat/ModelPicker";
import { IconBack, IconPanel, IconTrash } from "../components/icons";
import { SkeletonLine, SlowConnectHint } from "../components/Skeleton";
import ChangedFilesBar from "../components/workspace/ChangedFilesBar";
import WorkspacePanel from "../components/workspace/WorkspacePanel";
import TaskUsageSummary from "../components/usage/TaskUsageSummary";
import WorkerTimeline from "../components/task/WorkerTimeline";
import { extractChangedFiles } from "../lib/changedFiles";
import { useSlowHint } from "../hooks/useSlowHint";
import { useT } from "../i18n/react";
import { agentAvatarMeta, agentDisplayName } from "../lib/agentMention";
import { projectLabel, toWorkspaceRelativePath } from "../lib/paths";
import {
  normalizePermissionMode,
  type PermissionMode,
} from "../lib/permissionMode";
import {
  clearFollowUpDraft,
  getFollowUpDraft,
  setFollowUpDraft,
} from "../lib/followUpDraft";
import {
  clearSessionScroll,
  getSessionScroll,
  setSessionScroll,
} from "../lib/sessionScroll";
import { modelsForAgent } from "../lib/agentModels";
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
  const [usageLoading, setUsageLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [awaitingReply, setAwaitingReply] = useState(false);
  const [composerModel, setComposerModel] = useState("");
  const [composerPermission, setComposerPermission] =
    useState<PermissionMode>("default");
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
  const [filesOpen, setFilesOpen] = useState(false);
  const [workspaceOpenPath, setWorkspaceOpenPath] = useState<string | null>(null);
  const [workspaceOpenNonce, setWorkspaceOpenNonce] = useState(0);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<
    string | null | undefined
  >(undefined);
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
  const savedScrollTopRef = useRef<number | null>(
    id ? getSessionScroll(id) : null,
  );
  const markScrollReady = useCallback(() => {
    setScrollReady((prev) => (prev ? prev : true));
  }, []);
  const pushToast = useAppStore((s) => s.pushToast);
  const wsStatus = useAppStore((s) => s.wsStatus);
  const slow = useSlowHint(loading);

  const loadUsage = useCallback(async () => {
    if (!getToken()) return;
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
    setFilesOpen(false);
    setWorkspaceOpenPath(null);
    setWorkspaceOpenNonce(0);
    setSelectedWorkspaceId(undefined);
    stickToBottomRef.current = true;
    listAgents()
      .then(setAgents)
      .catch(() => setAgents([]));
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

  useEffect(() => {
    if (!task) return;
    void loadUsage();
  }, [
    loadUsage,
    task?.status,
    task?.tokens_in,
    task?.tokens_out,
    task?.cost_usd,
  ]);

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

    const saved =
      savedScrollTopRef.current ?? (id ? getSessionScroll(id) : null);

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
        const saved =
          savedScrollTopRef.current ?? (id ? getSessionScroll(id) : null);
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
    const a = approvals.map((item) => ({
      kind: "approval" as const,
      id: item.id,
      created_at: item.created_at,
      item,
    }));
    const q = userQuestions.map((item) => ({
      kind: "question" as const,
      id: item.id,
      created_at: item.created_at,
      item,
    }));
    return [...a, ...q].sort((x, y) => x.created_at - y.created_at);
  }, [approvals, userQuestions]);

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


  async function onLimitAction(
    action: "wait" | "continue" | "switch" | "dismiss",
    agent?: string,
  ) {
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

  async function onAnswer(
    questionId: string,
    body: { selected: string[]; other_text: string },
  ) {
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

  function persistFollowUpDraft(
    prompt: string,
    attachments = draftAttachmentsRef.current,
  ) {
    if (!id) return;
    draftPromptRef.current = prompt;
    draftAttachmentsRef.current = attachments;
    setFollowUpDraft(id, { prompt, attachments });
  }

  async function onComposer(text: string) {
    if (!task) return;
    setSending(true);
    setAwaitingReply(true);
    const requestRevision = liveResources.currentRevision();
    try {
      // Non-terminal: backend interrupts the current turn then re-queues with this guide.
      // Send model / permission only when the picker differs from the task.
      const picked = composerModel.trim();
      const current = (task.model || "").trim();
      const currentPerm = normalizePermissionMode(task.permission_mode);
      const opts: { model?: string; permission_mode?: string } = {};
      if (picked !== current) opts.model = picked;
      if (composerPermission !== currentPerm)
        opts.permission_mode = composerPermission;
      const t = await followUpPrompt(
        task.id,
        text,
        Object.keys(opts).length ? opts : undefined,
      );
      liveResources.applyTaskSnapshot(t, requestRevision);
      clearFollowUpDraft(task.id);
      draftPromptRef.current = "";
      draftAttachmentsRef.current = [];
      if (!isTerminal(task.status)) {
        pushToast(tr("task.interruptedGuide"), "info");
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
    const ok = window.confirm(
      tr("task.deleteConfirm") + (title ? `\n\n${title}` : ""),
    );
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
      pushToast(
        err instanceof Error ? err.message : tr("task.saveArtifactFailed"),
        "error",
      );
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
    setFilesOpen(true);
    setWorkspaceOpenPath(next);
    // Bump the nonce so re-clicking the same path re-loads/focuses it.
    setWorkspaceOpenNonce((n) => n + 1);
  }

  const changedFiles = useMemo(() => extractChangedFiles(events), [events]);

  function openFilesPanel() {
    setFilesOpen(true);
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
        <div className="flex-1 p-6 space-y-3 max-w-[720px] mx-auto w-full">
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
        <Link to="/" className="text-sm text-kin-blue">
          {tr("task.home")}
        </Link>
        <div
          className="rounded-xl border border-kin-red/40 bg-[rgba(255,69,58,.08)] px-4 py-3 text-sm text-[#ff8a80]"
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
        <Link to="/" className="text-sm text-kin-blue">
          {tr("task.home")}
        </Link>
        <div
          className="rounded-xl border border-[var(--kin-hairline)] bg-[var(--kin-fill)] px-4 py-3 text-sm text-kin-secondary"
          role="status"
        >
          {tr("task.loadFailed")}
        </div>
      </div>
    );
  }

  const terminal = isTerminal(task.status);
  const project = projectLabel(task.cwd);
  const degraded = wsStatus !== "connected" && !terminal;
  const hostAgentName =
    agents.find((agent) => agent.id === task.agent)?.name ??
    agentDisplayName(task.agent || "kin");
  const hostAgentAvatar = agentAvatarMeta(task.agent || "kin");
  const followUpDraft = getFollowUpDraft(task.id);

  return (
    <div className="flex-1 min-w-0 min-h-0 flex relative">
      <div className="flex-1 min-w-0 min-h-0 flex flex-col kin-surface-chat">
        <div
          className="h-11 flex-none flex items-center px-4 sm:px-5 border-b border-[var(--kin-hairline)]"
          style={{ WebkitAppRegion: "drag" } as CSSProperties}
        >
          <Link
            to="/"
            className="md:hidden mr-2 text-kin-blue min-w-[36px] min-h-[36px] flex items-center justify-center"
            style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
          >
            <IconBack size={18} strokeWidth={2} />
          </Link>
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px] font-semibold text-kin-text truncate">
              {task.title || displayUserPrompt(task.prompt || "")}
            </div>
          </div>
          <div
            className="ml-2 flex items-center gap-2 text-[12px] text-kin-muted flex-none"
            style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
          >
            <span
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--kin-hairline-strong)] bg-[var(--kin-fill)] px-2 py-1"
              title={tr("newChat.hostAgent", { name: hostAgentName })}
            >
              <span
                className={`w-4 h-4 rounded-[5px] inline-flex items-center justify-center text-[8px] font-semibold ${hostAgentAvatar.className}`}
              >
                {hostAgentAvatar.initials}
              </span>
              <span className="hidden sm:inline">
                {tr("newChat.hostAgent", { name: hostAgentName })}
              </span>
            </span>
            <button
              type="button"
              onClick={() => setFilesOpen((open) => !open)}
              className={[
                "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] transition-colors",
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
              onClick={() => void onDelete()}
              disabled={deleting}
              className="inline-flex items-center gap-1 rounded-md border border-[var(--kin-hairline-strong)] bg-[var(--kin-fill)] px-2 py-1 text-[12px] text-kin-secondary hover:text-[#ff8a80] hover:border-[rgba(255,69,58,.35)] disabled:opacity-40"
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
                <span className="text-kin-blue tabular-nums">
                  {degraded ? tr("task.reconnect") : tr("task.running")}
                </span>
                <button
                  type="button"
                  onClick={() => void onStop()}
                  disabled={stopping}
                  className="text-[12px] font-semibold text-[#ff8a80] hover:text-[#ffb4ad] disabled:opacity-40 px-1.5 py-0.5 rounded-md border border-[rgba(255,69,58,.3)] bg-[rgba(255,69,58,.08)]"
                >
                  {stopping ? tr("task.stopping") : tr("composer.stop")}
                </button>
              </>
            )}
          </div>
        </div>

        {error && (
          <div
            className="flex-none border-b border-kin-red/30 bg-[rgba(255,69,58,.08)] px-4 py-2 text-[12px] text-[#ff8a80]"
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
          <WorkerTimeline steps={workerSteps} />
          <ChatStream
            events={events}
            onOpenPath={onOpenWorkspacePath}
            fallbackUserPrompt={displayUserPrompt(task.prompt || "")}
            loading={!terminal || sending || awaitingReply}
            loadingSpeaker={task.agent || "kin"}
            hostSpeaker={task.agent || "kin"}
            hostModel={task.model}
            showMessageActions={terminal}
            actionsBusy={actionBusy}
            onRetry={(seq) => void onRetry(seq)}
            onFork={(seq) => void onFork(seq)}
            onSaveArtifact={(text) => void onSaveArtifact(text)}
            trailing={
              <>
                {needsYou.map((entry, i) => (
                  <div key={`${entry.kind}-${entry.id}`} className="mt-1">
                    {entry.kind === "approval" ? (
                      <ApprovalCard
                        approval={entry.item}
                        focused={i === focusIdx && needsYou.length > 0}
                        busy={busy[entry.id] ?? null}
                        onApprove={() => void onDecide(entry.id, "approved")}
                        onDeny={() => void onDecide(entry.id, "denied")}
                        onOpenPath={onOpenWorkspacePath}
                      />
                    ) : (
                      <UserQuestionCard
                        question={entry.item}
                        focused={i === focusIdx && needsYou.length > 0}
                        busy={Boolean(answerBusy[entry.id])}
                        onAnswer={(body) => void onAnswer(entry.id, body)}
                      />
                    )}
                  </div>
                ))}
                {latestLimitHit && task && (
                  <div className="mt-2" key={`limit-${latestLimitHit.seq}`}>
                    <LimitCard
                      hit={latestLimitHit.payload}
                      wait={limitWait}
                      hostAgentId={task.agent || ""}
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
                  <p className="text-center text-[11.5px] text-kin-muted mt-2">
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

        <div className="flex-none px-4 sm:px-7 pb-3 sm:pb-3.5 pt-1.5">
          <div className="max-w-[720px] mx-auto space-y-1.5">
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
                  ? tr("composer.guideWhileRunning")
                  : tr("composer.followUpPlaceholder", { name: hostAgentName })
              }
              onValueChange={(v) => persistFollowUpDraft(v)}
              onAttachmentsChange={(atts) =>
                persistFollowUpDraft(draftPromptRef.current, atts)
              }
              onSubmit={onComposer}
              onStop={onStop}
            />
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
                className="min-w-0 max-w-[min(40%,18rem)]"
                cwd={task.cwd}
                locked
                compact
                onChange={() => undefined}
              />
              <BranchPicker
                cwd={task.cwd}
                locked
                compact
                className="flex-none"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Session side rail — usage + diffs, floats over the chat instead of squeezing its width (Codex-style). */}
      <aside
        className="hidden min-[1600px]:flex absolute top-14 right-3 bottom-3 z-10 w-[300px] flex-col gap-2.5 rounded-xl border border-[var(--kin-hairline)] bg-[var(--kin-inspector)]/95 backdrop-blur-md shadow-lg px-3 py-3 min-h-0 overflow-y-auto kin-scroll"
        aria-label={tr("task.sessionRail")}
      >
        <TaskUsageSummary
          usage={usage}
          loading={usageLoading}
          variant="card"
        />
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
        <div
          className="absolute inset-0 z-40 bg-[var(--kin-inspector)] safe-pad"
          role="complementary"
          aria-label={tr("workspace.title")}
        >
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
              onClose={() => setFilesOpen(false)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/** Extract speaker from a raw event payload for awaitingReply detection. */
function parsePayloadSpeaker(payload: unknown): string | undefined {
  if (payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>;
    if (typeof p.speaker === 'string') return p.speaker;
    if (typeof p.role === 'string') return p.role;
  }
  return undefined;
}
