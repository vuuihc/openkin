import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ApiError,
  cancelTask,
  followUpPrompt,
  formatCost,
  formatElapsed,
  getTask,
  getToken,
  isTerminal,
  listEvents,
  type Task,
  type TaskEvent,
} from "../api/client";
import { SkeletonLine, SlowConnectHint } from "../components/Skeleton";
import StatusBadge from "../components/StatusBadge";
import Transcript from "../components/Transcript";
import Truncated from "../components/Truncated";
import { useSlowHint } from "../hooks/useSlowHint";
import { subscribeWS, useAppStore } from "../store/appStore";

export default function TaskDetailPage() {
  const { id = "" } = useParams();
  const [task, setTask] = useState<Task | null>(null);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [canceling, setCanceling] = useState(false);
  const [followUp, setFollowUp] = useState("");
  const [sending, setSending] = useState(false);
  const [now, setNow] = useState(Date.now());
  const maxSeq = useRef(0);
  const reconnectGen = useAppStore((s) => s.reconnectGen);
  const pushToast = useAppStore((s) => s.pushToast);
  const slow = useSlowHint(loading);

  const load = useCallback(async () => {
    if (!getToken()) return;
    try {
      const [t, evs] = await Promise.all([
        getTask(id),
        listEvents(id, maxSeq.current),
      ]);
      setTask(t);
      if (evs.length) {
        setEvents((prev) => mergeEvents(prev, evs));
        maxSeq.current = Math.max(maxSeq.current, ...evs.map((e) => e.seq));
      }
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      if (e instanceof ApiError && e.status === 404) {
        setError("Task not found");
      } else {
        setError(e instanceof Error ? e.message : "Failed to load");
      }
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    maxSeq.current = 0;
    setEvents([]);
    setLoading(true);
    void load();
  }, [load]);

  // Resync events via since_seq after WS reconnect.
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
    });
  }, [id]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  async function onCancel() {
    setCanceling(true);
    try {
      const t = await cancelTask(id);
      setTask(t);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Cancel failed";
      pushToast(msg, "error");
    } finally {
      setCanceling(false);
    }
  }

  async function onFollowUp(e: React.FormEvent) {
    e.preventDefault();
    const prompt = followUp.trim();
    if (!prompt) return;
    setSending(true);
    try {
      const t = await followUpPrompt(id, prompt);
      setTask(t);
      setFollowUp("");
      setError(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Follow-up failed";
      pushToast(msg, "error");
    } finally {
      setSending(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <SkeletonLine className="h-4 w-16" />
        <SkeletonLine className="h-7 w-2/3" />
        <SkeletonLine className="h-4 w-1/2" />
        <SkeletonLine className="h-16 w-full rounded-xl" />
        <SlowConnectHint show={slow} />
        <div className="space-y-2">
          <SkeletonLine className="h-20 w-full rounded-xl" />
          <SkeletonLine className="h-20 w-full rounded-xl" />
        </div>
      </div>
    );
  }

  if (error && !task) {
    return (
      <div className="space-y-3">
        <Link
          to="/"
          className="inline-flex min-h-[44px] items-center text-sm text-zinc-400 hover:text-accent"
        >
          ← Tasks
        </Link>
        <div
          className="rounded-xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-200"
          role="alert"
        >
          {error}
        </div>
      </div>
    );
  }

  if (!task) return null;

  const terminal = isTerminal(task.status);
  const canFollowUp = terminal && !!task.session_ref;

  return (
    <div className="space-y-4">
      <Link
        to="/"
        className="inline-flex min-h-[44px] items-center text-sm text-zinc-400 hover:text-accent"
      >
        ← Tasks
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <h1 className="text-xl font-semibold text-zinc-50 break-words" title={task.title}>
            {task.title}
          </h1>
          <p className="text-xs text-zinc-500 font-mono min-w-0">
            <Truncated text={task.cwd} expand className="block w-full" />
          </p>
        </div>
        <StatusBadge status={task.status} />
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-surface-border bg-surface-raised px-4 py-3 text-sm">
        <span className="text-zinc-400">
          Cost <span className="text-zinc-100">{formatCost(task.cost_usd)}</span>
        </span>
        <span className="text-zinc-600">·</span>
        <span className="text-zinc-400">
          Tokens{" "}
          <span className="text-zinc-100">
            {task.tokens_in} in / {task.tokens_out} out
          </span>
        </span>
        <span className="text-zinc-600">·</span>
        <span className="text-zinc-400">
          Elapsed <span className="text-zinc-100">{formatElapsed(task, now)}</span>
        </span>
        {!terminal && (
          <button
            type="button"
            onClick={onCancel}
            disabled={canceling}
            className="ml-auto min-h-[44px] rounded-lg border border-red-800/60 px-4 py-2 text-sm font-medium text-red-300 hover:bg-red-950/50 disabled:opacity-50"
          >
            {canceling ? "Canceling…" : "Cancel"}
          </button>
        )}
      </div>

      {error && (
        <div
          className="rounded-xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-200"
          role="alert"
        >
          {error}
        </div>
      )}

      <section>
        <h2 className="mb-3 text-sm font-medium text-zinc-400">Transcript</h2>
        <Transcript events={events} />
      </section>

      {canFollowUp && (
        <section className="rounded-xl border border-surface-border bg-surface-raised p-4 space-y-3">
          <h2 className="text-sm font-medium text-zinc-300">Follow-up</h2>
          <p className="text-xs text-zinc-500">
            Continues the same agent session (<span className="font-mono">--resume</span>).
          </p>
          <form onSubmit={onFollowUp} className="space-y-3">
            <textarea
              value={followUp}
              onChange={(e) => setFollowUp(e.target.value)}
              rows={3}
              placeholder="Send another prompt to this session…"
              className="w-full rounded-lg border border-surface-border bg-black/30 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-accent"
            />
            <button
              type="submit"
              disabled={sending || !followUp.trim()}
              className="min-h-[44px] w-full sm:w-auto rounded-xl bg-accent px-5 py-2.5 text-sm font-semibold text-black disabled:opacity-50 hover:brightness-110"
            >
              {sending ? "Sending…" : "Send follow-up"}
            </button>
          </form>
        </section>
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
