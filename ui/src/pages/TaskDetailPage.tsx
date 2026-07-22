import {
  useCallback,
  useEffect,
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
  restoreTaskWorkspace,
  retryTask,
  createTaskRecycle,
  getTaskRecycle,
  type AgentInfo,
  type Approval,
  type ProjectRecycle,
  type Task,
  type TaskEvent,
  type TaskUsage,
} from "../api/client";
import RecycleReviewCard from "../components/project/RecycleReviewCard";
import ApprovalCard from "../components/cards/ApprovalCard";
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
import { useSlowHint } from "../hooks/useSlowHint";
import { t } from "../i18n";
import { useT } from "../i18n/react";
import { agentAvatarMeta, agentDisplayName } from "../lib/agentMention";
import { projectLabel, toWorkspaceRelativePath } from "../lib/paths";
import { normalizePermissionMode } from "../lib/permissionMode";
import { modelsForAgent } from "../lib/agentModels";
import { subscribeWS, useAppStore } from "../store/appStore";

/**
 * Single-column chat: user talks to the session host; @agents are task workers.
 * Full event stream in the main column (no inspector three-pane).
 */
export default function TaskDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [task, setTask] = useState<Task | null>(null);
  const [usage, setUsage] = useState<TaskUsage | null>(null);
  const [usageLoading, setUsageLoading] = useState(true);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [composerModel, setComposerModel] = useState("");
  const [stopping, setStopping] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [busy, setBusy] = useState<Record<string, "approved" | "denied">>({});
  const [focusIdx, setFocusIdx] = useState(0);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [filesOpen, setFilesOpen] = useState(false);
  const [workspaceOpenPath, setWorkspaceOpenPath] = useState<string | null>(null);
  const [workspaceOpenNonce, setWorkspaceOpenNonce] = useState(0);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [recycle, setRecycle] = useState<ProjectRecycle | null>(null);
  const [recycleOpen, setRecycleOpen] = useState(false);
  const [recycleLoading, setRecycleLoading] = useState(false);
  const [recycleError, setRecycleError] = useState<string | null>(null);
  const maxSeq = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const reconnectGen = useAppStore((s) => s.reconnectGen);
  const pushToast = useAppStore((s) => s.pushToast);
  const wsStatus = useAppStore((s) => s.wsStatus);
  const slow = useSlowHint(loading);
  const tr = useT();

  const load = useCallback(async () => {
    if (!getToken()) return;
    try {
      const [t, evs, apps] = await Promise.all([
        getTask(id),
        listEvents(id, maxSeq.current),
        listApprovals("pending"),
      ]);
      setTask(t);
      if (evs.length) {
        setEvents((prev) => mergeEvents(prev, evs));
        maxSeq.current = Math.max(maxSeq.current, ...evs.map((e) => e.seq));
      }
      setApprovals(apps.filter((a) => a.task_id === id));
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

  // Restore pending/resolved wrap-up for project tasks.
  useEffect(() => {
    if (!task?.project_id || !id) {
      setRecycle(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const rec = await getTaskRecycle(id);
        if (!cancelled) {
          setRecycle(rec);
          if (rec.status === "pending") setRecycleOpen(true);
        }
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 404) {
          setRecycle(null);
          return;
        }
        // Non-fatal: wrap-up is optional.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, task?.project_id]);

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
    setUsage(null);
    setLoading(true);
    setFilesOpen(false);
    setWorkspaceOpenPath(null);
    setWorkspaceOpenNonce(0);
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
        setEvents((prev) => mergeEvents(prev, evs));
        maxSeq.current = Math.max(maxSeq.current, ...evs.map((e) => e.seq));
      })
      .catch(() => undefined);
    void getTask(id).then(setTask).catch(() => undefined);
    void loadUsage();
    void listApprovals("pending")
      .then((apps) => setApprovals(apps.filter((a) => a.task_id === id)))
      .catch(() => undefined);
  }, [reconnectGen, id, loadUsage]);

  useEffect(() => {
    return subscribeWS((msg) => {
      if (msg.kind === "task_deleted") {
        const data = msg.data as { id?: string };
        if (data?.id && data.id === id) {
          setTask(null);
          setError(tr("task.notFound"));
          navigate("/");
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
          setEvents((prev) => {
            const next = mergeEvents(prev, [ev]);
            maxSeq.current = Math.max(maxSeq.current, ev.seq);
            return next;
          });
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
    });
  }, [id, loadUsage]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events, approvals, sending]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      const list = approvals;
      if (!list.length) return;
      if (e.key === "j" || e.key === "J") {
        setFocusIdx((i) => Math.min(list.length - 1, i + 1));
      } else if (e.key === "k" || e.key === "K") {
        setFocusIdx((i) => Math.max(0, i - 1));
      } else if (e.key === "a" || e.key === "A") {
        const a = list[focusIdx] ?? list[0];
        if (a) void onDecide(a.id, "approved");
      } else if (e.key === "d" || e.key === "D") {
        const a = list[focusIdx] ?? list[0];
        if (a) void onDecide(a.id, "denied");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [approvals, focusIdx]);

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

  // Keep model picker aligned with the task's effective model.
  useEffect(() => {
    if (!task) return;
    setComposerModel((task.model || "").trim());
  }, [task?.id, task?.model]);

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
      if (!isTerminal(task.status)) {
        pushToast(tr("task.interruptedGuide"), "info");
      }
    } catch (err) {
      pushToast(err instanceof Error ? err.message : tr("task.sendFailed"), "error");
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
    const title = (task.title || task.prompt || task.id).trim();
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
      maxSeq.current = evs.reduce((m, e) => Math.max(m, e.seq), 0);
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


  async function onRecycle() {
    if (!task?.project_id || recycleLoading) return;
    setRecycleLoading(true);
    setRecycleError(null);
    setRecycleOpen(true);
    try {
      const rec = await createTaskRecycle(task.id);
      setRecycle(rec);
    } catch (e) {
      setRecycleError(
        e instanceof Error ? e.message : tr("task.recycleGenerateFailed"),
      );
    } finally {
      setRecycleLoading(false);
    }
  }

  const canRecycle =
    !!task?.project_id &&
    (events.length > 0 || !!(task?.prompt || "").trim());


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
              {task.title || task.prompt}
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
            {canRecycle ? (
              <button
                type="button"
                onClick={() => void onRecycle()}
                disabled={recycleLoading}
                className="inline-flex items-center gap-1 rounded-md border border-kin-accent/40 bg-kin-accent/10 px-2 py-1 text-[12px] text-kin-text hover:bg-kin-accent/15 disabled:opacity-40"
                title={tr("task.recycle")}
              >
                {recycleLoading ? tr("task.recycleGenerating") : tr("task.recycle")}
              </button>
            ) : null}
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

        <div className="flex-1 overflow-y-auto kin-scroll py-5 min-h-0">
          <ChatStream
            events={events}
            onOpenPath={onOpenWorkspacePath}
            fallbackUserPrompt={task.prompt}
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
                {approvals.map((a, i) => (
                  <div key={a.id} className="mt-1">
                    <ApprovalCard
                      approval={a}
                      focused={i === focusIdx && approvals.length > 0}
                      busy={busy[a.id] ?? null}
                      onApprove={() => void onDecide(a.id, "approved")}
                      onDeny={() => void onDecide(a.id, "denied")}
                      onOpenPath={onOpenWorkspacePath}
                    />
                  </div>
                ))}
                {approvals.length > 0 && (
                  <p className="text-center text-[11.5px] text-kin-muted mt-2">
                    <kbd className="px-1 border border-[var(--kin-hairline-strong)] rounded">
                      A
                    </kbd>{" "}
                    {tr("chat.approve")} ·{" "}
                    <kbd className="px-1 border border-[var(--kin-hairline-strong)] rounded">
                      D
                    </kbd>{" "}
                    {tr("chat.deny")}
                  </p>
                )}
                <div ref={bottomRef} />
              </>
            }
          />
        </div>

        <div className="flex-none px-4 sm:px-7 pb-4 sm:pb-5 pt-2">
          <div className="max-w-[720px] mx-auto space-y-2">
            {(recycleOpen || recycleLoading || recycleError) && (
              <div className="space-y-2">
                {recycleLoading && !recycle ? (
                  <div className="rounded-2xl border border-kin-accent/30 bg-kin-panel px-4 py-3 text-[12.5px] text-kin-secondary">
                    {tr("task.recycleGenerating")}
                  </div>
                ) : null}
                {recycleError ? (
                  <div className="rounded-2xl border border-red-500/30 bg-kin-panel px-4 py-3">
                    <p className="text-[12.5px] text-red-500/90">{recycleError}</p>
                    <div className="mt-2 flex gap-2">
                      <button
                        type="button"
                        className="text-[12px] text-kin-accent hover:underline"
                        onClick={() => void onRecycle()}
                      >
                        {tr("task.recycleRetry")}
                      </button>
                      <button
                        type="button"
                        className="text-[12px] text-kin-muted hover:underline"
                        onClick={() => {
                          setRecycleError(null);
                          setRecycleOpen(false);
                        }}
                      >
                        {tr("common.close")}
                      </button>
                    </div>
                  </div>
                ) : null}
                {recycle ? (
                  <RecycleReviewCard
                    recycle={recycle}
                    onChange={setRecycle}
                    onClose={() => setRecycleOpen(false)}
                    onConflict={() =>
                      pushToast(tr("task.recycleConflict"), "error")
                    }
                  />
                ) : null}
              </div>
            )}
            <Composer
              agents={agents}
              hostAgentId={task.agent || ""}
              busy={sending}
              running={!terminal}
              stopping={stopping}
              disabled={sending || stopping}
              placeholder={
                !terminal
                  ? tr("composer.guideWhileRunning")
                  : tr("composer.followUpPlaceholder", { name: hostAgentName })
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

function mergeEvents(prev: TaskEvent[], incoming: TaskEvent[]): TaskEvent[] {
  const map = new Map<number, TaskEvent>();
  for (const e of prev) map.set(e.seq, e);
  for (const e of incoming) map.set(e.seq, e);
  return Array.from(map.values()).sort((a, b) => a.seq - b.seq);
}
