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
  createArtifact,
  decideApproval,
  deriveArtifactTitle,
  detectArtifactKind,
  followUpPrompt,
  forkTask,
  getTask,
  getToken,
  isTerminal,
  listAgents,
  listApprovals,
  listEvents,
  retryTask,
  type AgentInfo,
  type Approval,
  type Task,
  type TaskEvent,
} from "../api/client";
import ApprovalCard from "../components/cards/ApprovalCard";
import ChatStream from "../components/chat/ChatStream";
import Composer from "../components/chat/Composer";
import CwdPicker from "../components/chat/CwdPicker";
import PermissionModePicker from "../components/chat/PermissionModePicker";
import { IconBack, IconPanel } from "../components/icons";
import { SkeletonLine, SlowConnectHint } from "../components/Skeleton";
import ChangedFilesBar from "../components/workspace/ChangedFilesBar";
import WorkspacePanel from "../components/workspace/WorkspacePanel";
import { extractChangedFiles } from "../lib/changedFiles";
import { useSlowHint } from "../hooks/useSlowHint";
import { t } from "../i18n";
import { useT } from "../i18n/react";
import { parseAgentDirective } from "../lib/agentMention";
import { projectLabel, toWorkspaceRelativePath } from "../lib/paths";
import { normalizePermissionMode } from "../lib/permissionMode";
import { subscribeWS, useAppStore } from "../store/appStore";

/**
 * Single-column chat: user talks to Kin; @agents are delegated as task workers.
 * Full event stream in the main column (no inspector three-pane).
 */
export default function TaskDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [task, setTask] = useState<Task | null>(null);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [busy, setBusy] = useState<Record<string, "approved" | "denied">>({});
  const [focusIdx, setFocusIdx] = useState(0);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [filesOpen, setFilesOpen] = useState(false);
  const [workspaceOpenPath, setWorkspaceOpenPath] = useState<string | null>(null);
  const [workspaceOpenNonce, setWorkspaceOpenNonce] = useState(0);
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
      if (e instanceof ApiError && e.status === 401) return;
      if (e instanceof ApiError && e.status === 404) setError(t("task.notFound"));
      else setError(e instanceof Error ? e.message : t("task.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    maxSeq.current = 0;
    setEvents([]);
    setLoading(true);
    setFilesOpen(false);
    setWorkspaceOpenPath(null);
    setWorkspaceOpenNonce(0);
    void load();
    listAgents()
      .then(setAgents)
      .catch(() => setAgents([]));
  }, [load]);

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
    void listApprovals("pending")
      .then((apps) => setApprovals(apps.filter((a) => a.task_id === id)))
      .catch(() => undefined);
  }, [reconnectGen, id]);

  useEffect(() => {
    return subscribeWS((msg) => {
      if (msg.kind === "task_update") {
        const t = msg.data as Task;
        if (t.id === id) setTask(t);
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
  }, [id]);

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

  async function onComposer(text: string) {
    if (!task) return;
    setSending(true);
    try {
      const availableIds = agents.filter((a) => a.available).map((a) => a.id);
      const plan = parseAgentDirective(text, availableIds);
      const mainAgent =
        agents.find((a) => a.available && a.default)?.id ||
        (availableIds.includes("kin") && "kin") ||
        availableIds[0];

      // Multi-@ → host on main agent (Kin or fallback CLI). Backend orchestrates.
      let agent: string | undefined;
      if (plan.multi && mainAgent) {
        agent = mainAgent;
      }

      // Non-terminal: backend interrupts the current turn then re-queues with this guide.
      const t = await followUpPrompt(
        task.id,
        text,
        agent && agent !== task.agent ? { agent } : undefined,
      );
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

  if (!task) return null;

  const terminal = isTerminal(task.status);
  const project = projectLabel(task.cwd);
  const degraded = wsStatus !== "connected" && !terminal;

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
            <span>{project}</span>
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

        <ChangedFilesBar
          files={changedFiles}
          onOpenPath={onOpenWorkspacePath}
          onOpenPanel={openFilesPanel}
        />

        <div className="flex-1 overflow-y-auto kin-scroll py-5 min-h-0">
          <ChatStream
            events={events}
            onOpenPath={onOpenWorkspacePath}
            fallbackUserPrompt={task.prompt}
            loading={!terminal}
            loadingSpeaker={task.agent || "kin"}
            hostSpeaker={task.agent || "kin"}
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
            <Composer
              agents={agents}
              busy={sending}
              running={!terminal}
              stopping={stopping}
              disabled={sending || stopping}
              placeholder={
                !terminal
                  ? tr("composer.guideWhileRunning")
                  : tr("composer.followUpPlaceholder")
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
            </div>
            <CwdPicker cwd={task.cwd} locked onChange={() => undefined} />
          </div>
        </div>
      </div>

      {filesOpen && (
        <div className="hidden md:flex w-[min(50vw,720px)] min-w-[360px] max-w-[50%] border-l border-[var(--kin-hairline)]">
          <WorkspacePanel
            taskId={task.id}
            cwd={task.cwd}
            openPath={workspaceOpenPath}
            openNonce={workspaceOpenNonce}
            onClose={() => setFilesOpen(false)}
          />
        </div>
      )}

      {filesOpen && (
        <div className="md:hidden fixed inset-0 z-40 bg-[rgba(14,14,16,.7)] backdrop-blur-[2px]">
          <div className="absolute inset-x-0 top-0 bottom-0 bg-[var(--kin-inspector)] safe-pad">
            <WorkspacePanel
              taskId={task.id}
              cwd={task.cwd}
              openPath={workspaceOpenPath}
              openNonce={workspaceOpenNonce}
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
