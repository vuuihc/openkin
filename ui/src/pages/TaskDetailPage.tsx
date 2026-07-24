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
  getTask,
  getTaskUsage,
  getToken,
  isTerminal,
  listAgents,
  listApprovals,
  listEvents,
  listUserQuestions,
  restoreTaskWorkspace,
  retryTask,
  type AgentInfo,
  type Approval,
  type Task,
  type TaskEvent,
  type TaskUsage,
  type Upload,
  type UserQuestion,
} from "../api/client";
import ApprovalCard from "../components/cards/ApprovalCard";
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
import { extractChangedFiles } from "../lib/changedFiles";
import {
  hasSequenceGap,
  highestContiguousSeq,
  mergeEventsBySeq,
} from "../lib/eventStream";
import { useSlowHint } from "../hooks/useSlowHint";
import { t } from "../i18n";
import { useT } from "../i18n/react";
import { agentAvatarMeta, agentDisplayName } from "../lib/agentMention";
import { projectLabel, toWorkspaceRelativePath } from "../lib/paths";
import { normalizePermissionMode } from "../lib/permissionMode";
import {
  clearFollowUpDraft,
  getFollowUpDraft,
  setFollowUpDraft,
} from "../lib/followUpDraft";
import { modelsForAgent } from "../lib/agentModels";
import { subscribeWS, useAppStore } from "../store/appStore";
import { displayUserPrompt } from "../lib/attachments";

/**
 * Single-column chat: user talks to the session host; @agents are task workers.
 * Full event stream in the main column (no inspector three-pane).
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
  const [task, setTask] = useState<Task | null>(null);
  const [usage, setUsage] = useState<TaskUsage | null>(null);
  const [usageLoading, setUsageLoading] = useState(true);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [userQuestions, setUserQuestions] = useState<UserQuestion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [composerModel, setComposerModel] = useState("");
  // Latest follow-up draft fields for this task (localStorage is source of truth).
  const draftPromptRef = useRef("");
  const draftAttachmentsRef = useRef<Upload[]>([]);
  const [stopping, setStopping] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [busy, setBusy] = useState<Record<string, "approved" | "denied">>({});
  const [answerBusy, setAnswerBusy] = useState<Record<string, boolean>>({});
  const [focusIdx, setFocusIdx] = useState(0);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [filesOpen, setFilesOpen] = useState(false);
  const [workspaceOpenPath, setWorkspaceOpenPath] = useState<string | null>(null);
  const [workspaceOpenNonce, setWorkspaceOpenNonce] = useState(0);
  const [reviewBusy, setReviewBusy] = useState(false);
  const maxSeq = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** User is near the bottom → stick to new content. */
  const stickToBottomRef = useRef(true);
  /** First paint of this mounted instance: jump to bottom once (no animation). */
  const didInitialScrollRef = useRef(false);
  const reconnectGen = useAppStore((s) => s.reconnectGen);
  const pushToast = useAppStore((s) => s.pushToast);
  const wsStatus = useAppStore((s) => s.wsStatus);
  const slow = useSlowHint(loading);
  const tr = useT();

  const load = useCallback(async () => {
    if (!getToken()) return;
    try {
      const [t, evs, apps, qs] = await Promise.all([
        getTask(id),
        listEvents(id, maxSeq.current),
        listApprovals("pending"),
        listUserQuestions("pending").catch(() => [] as UserQuestion[]),
      ]);
      setTask(t);
      if (evs.length) {
        setEvents((prev) => {
          const next = mergeEventsBySeq(prev, evs);
          maxSeq.current = highestContiguousSeq(next);
          return next;
        });
      }
      setApprovals(apps.filter((a) => a.task_id === id));
      setUserQuestions(qs.filter((q) => q.task_id === id));
      setError(null);
    } catch (e) {
      // 401 still surfaces a recoverable empty state (App also flips to ConnectScreen).
      // Never leave loading=false + task=null + error=null — that paints a blank main pane.
      if (e instanceof ApiError && e.status === 404) setError(t("task.notFound"));
      else if (e instanceof ApiError && e.status === 401)
        setError(t("task.loadFailed"));
      else setError(e instanceof Error ? e.message : t("task.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [id]);

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
    maxSeq.current = 0;
    setEvents([]);
    setTask(null);
    setError(null);
    setApprovals([]);
    setUserQuestions([]);
    setUsage(null);
    setLoading(true);
    setFilesOpen(false);
    setWorkspaceOpenPath(null);
    setWorkspaceOpenNonce(0);
    stickToBottomRef.current = true;
    void load();
    void loadUsage();
    listAgents()
      .then(setAgents)
      .catch(() => setAgents([]));
  }, [load, loadUsage]);

  useEffect(() => {
    if (reconnectGen === 0) return;
    void listEvents(id, maxSeq.current)
      .then((evs) => {
        if (!evs.length) return;
        setEvents((prev) => {
          const next = mergeEventsBySeq(prev, evs);
          maxSeq.current = highestContiguousSeq(next);
          return next;
        });
      })
      .catch(() => undefined);
    void getTask(id).then(setTask).catch(() => undefined);
    void loadUsage();
    void listApprovals("pending")
      .then((apps) => setApprovals(apps.filter((a) => a.task_id === id)))
      .catch(() => undefined);
    void listUserQuestions("pending")
      .then((qs) => setUserQuestions(qs.filter((q) => q.task_id === id)))
      .catch(() => undefined);
  }, [reconnectGen, id, loadUsage]);

  useEffect(() => {
    return subscribeWS((msg) => {
      if (msg.kind === "task_deleted") {
        const data = msg.data as { id?: string };
        if (data?.id && data.id === id) {
          setTask(null);
          setError(tr("task.notFound"));
          // Only the visible session should hijack routing.
          if (active) navigate("/");
        }
        return;
      }
      if (msg.kind === "task_update") {
        const t = msg.data as Task;
        if (t.id === id) {
          setTask(t);
          void loadUsage();
        }
      }
      if (msg.kind === "event") {
        const ev = msg.data as TaskEvent;
        if (ev.task_id === id) {
          // Cursor is highest contiguous seq, not max observed.
          const contiguous = maxSeq.current;
          const gap = hasSequenceGap(contiguous, ev.seq);
          setEvents((prev) => {
            const next = mergeEventsBySeq(prev, [ev]);
            maxSeq.current = highestContiguousSeq(next);
            return next;
          });
          if (gap) {
            // Recover missing sequences from the durable log without blocking the bus.
            // Fetch from the last contiguous cursor so the hole is filled even when
            // the live event jumped ahead.
            void listEvents(id, contiguous)
              .then((evs) => {
                if (!evs.length) return;
                setEvents((prev) => {
                  const next = mergeEventsBySeq(prev, evs);
                  maxSeq.current = highestContiguousSeq(next);
                  return next;
                });
              })
              .catch(() => undefined);
          }
        }
      }
      if (msg.kind === "approval_update") {
        const a = msg.data as Approval;
        if (a.task_id !== id) return;
        setApprovals((prev) => {
          if (a.decision !== "pending") return prev.filter((x) => x.id !== a.id);
          const rest = prev.filter((x) => x.id !== a.id);
          return [a, ...rest];
        });
      }
      if (msg.kind === "user_question_update") {
        const q = msg.data as UserQuestion;
        if (q.task_id !== id) return;
        setUserQuestions((prev) => {
          if (q.status !== "pending") return prev.filter((x) => x.id !== q.id);
          const rest = prev.filter((x) => x.id !== q.id);
          return [q, ...rest];
        });
      }
    });
  }, [id, loadUsage, active]);

  const isNearBottom = useCallback((el: HTMLElement, threshold = 96) => {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
  }, []);

  const onChatScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = isNearBottom(el);
  }, [isNearBottom]);

  // First paint of this mounted instance jumps to bottom (instant, no smooth slide).
  // Keep-alive reuses the instance later; DOM scrollTop stays put — no save/restore.
  // Do not finalize until the scroller has a real viewport height and is actually at bottom
  // (or the thread is short enough that there is no overflow).
  useLayoutEffect(() => {
    if (didInitialScrollRef.current) return;
    if (loading || !task) return;
    const el = scrollRef.current;
    if (!el) return;

    const tryJump = (): boolean => {
      if (didInitialScrollRef.current) return true;
      const node = scrollRef.current;
      if (!node) return false;
      // Flex chain not ready yet — keep waiting (ResizeObserver / rAF will retry).
      if (node.clientHeight <= 0) return false;

      node.scrollTop = node.scrollHeight;
      stickToBottomRef.current = true;

      const overflow = node.scrollHeight - node.clientHeight;
      const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
      // Short thread (no overflow) or successfully pinned to bottom.
      if (overflow <= 1 || distance <= 4) {
        didInitialScrollRef.current = true;
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
      node.scrollTop = node.scrollHeight;
      stickToBottomRef.current = true;
      didInitialScrollRef.current = true;
      ro.disconnect();
    }, 1000);

    return () => {
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [loading, task, events.length]);

  // Follow new content only when user was already at bottom, or just sent a message.
  // Also runs while keep-alive-hidden (background tab left at bottom stays at bottom).
  useLayoutEffect(() => {
    if (!didInitialScrollRef.current) return;
    if (!(stickToBottomRef.current || sending)) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stickToBottomRef.current = true;
  }, [events, approvals, userQuestions, sending]);

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

  async function onDecide(approvalId: string, decision: "approved" | "denied") {
    setBusy((b) => ({ ...b, [approvalId]: decision }));
    try {
      await decideApproval(approvalId, decision);
      setApprovals((prev) => prev.filter((x) => x.id !== approvalId));
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
      await answerUserQuestion(questionId, body);
      setUserQuestions((prev) => prev.filter((x) => x.id !== questionId));
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
    try {
      // Non-terminal: backend interrupts the current turn then re-queues with this guide.
      // Include model when the picker differs from the task (or any explicit selection).
      const picked = composerModel.trim();
      const current = (task.model || "").trim();
      const modelOpts =
        picked !== current ? { model: picked } : undefined;
      const t = await followUpPrompt(task.id, text, modelOpts);
      setTask(t);
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
    try {
      const t = await cancelTask(task.id);
      setTask(t);
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
    try {
      const t = await retryTask(task.id, { from_seq: fromSeq });
      setTask(t);
      // Reload events after server truncated + re-seeded.
      const evs = await listEvents(task.id);
      setEvents(evs);
      maxSeq.current = highestContiguousSeq(evs);
      pushToast(tr("task.retryDone"), "info");
    } catch (err) {
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
        title: deriveArtifactTitle(content, task.title || "Untitled"),
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

        <div
          ref={scrollRef}
          onScroll={onChatScroll}
          className="flex-1 overflow-y-auto kin-scroll py-5 min-h-0"
        >
          <ChatStream
            events={events}
            onOpenPath={onOpenWorkspacePath}
            fallbackUserPrompt={displayUserPrompt(task.prompt || "")}
            loading={!terminal}
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

        <div className="flex-none px-4 sm:px-7 pb-4 sm:pb-5 pt-2">
          <div className="max-w-[720px] mx-auto space-y-2">
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
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-0.5">
              <PermissionModePicker
                value={normalizePermissionMode(task.permission_mode)}
                locked
                onChange={() => undefined}
              />
              <ModelPicker
                value={composerModel}
                models={modelsForAgent(agents, task.agent || "")}
                source={agents.find((agent) => agent.id === task.agent)?.model_list_source}
                status={agents.find((agent) => agent.id === task.agent)?.model_list_status}
                disabled={sending || stopping}
                onChange={setComposerModel}
              />
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 min-w-0">
              <CwdPicker
                className="flex-1 min-w-[12rem]"
                cwd={task.cwd}
                locked
                onChange={() => undefined}
              />
              <BranchPicker cwd={task.cwd} locked className="flex-none" />
            </div>
          </div>
        </div>
      </div>

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
