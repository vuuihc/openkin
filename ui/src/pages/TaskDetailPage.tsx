import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ApiError,
  cancelTask,
  connectWS,
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
import StatusBadge from "../components/StatusBadge";
import Transcript from "../components/Transcript";

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

  const load = useCallback(async () => {
    if (!getToken()) {
      setError("No auth token. Open the URL printed by `kin serve`.");
      setLoading(false);
      return;
    }
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
      if (e instanceof ApiError && e.status === 404) {
        setError("Task not found");
      } else if (e instanceof ApiError && e.status === 401) {
        setError("Unauthorized");
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

  useEffect(() => {
    return connectWS((msg) => {
      if (msg.kind === "task_update" && msg.data.id === id) {
        setTask(msg.data);
      }
      if (msg.kind === "event" && msg.data.task_id === id) {
        setEvents((prev) => {
          const next = mergeEvents(prev, [msg.data]);
          maxSeq.current = Math.max(maxSeq.current, msg.data.seq);
          return next;
        });
      }
    });
  }, [id]);

  // Re-sync via since_seq on reconnect: poll lightly when running.
  useEffect(() => {
    if (!task || isTerminal(task.status)) return;
    const t = setInterval(() => {
      void listEvents(id, maxSeq.current).then((evs) => {
        if (!evs.length) return;
        setEvents((prev) => mergeEvents(prev, evs));
        maxSeq.current = Math.max(maxSeq.current, ...evs.map((e) => e.seq));
      });
      void getTask(id).then(setTask).catch(() => undefined);
    }, 3000);
    return () => clearInterval(t);
  }, [id, task?.status]);

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
      setError(e instanceof Error ? e.message : "Cancel failed");
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
      setError(err instanceof Error ? err.message : "Follow-up failed");
    } finally {
      setSending(false);
    }
  }

  if (loading) {
    return (
      <p className="text-sm text-zinc-400" role="status">
        Loading task…
      </p>
    );
  }

  if (error && !task) {
    return (
      <div className="space-y-3">
        <Link to="/" className="text-sm text-zinc-400 hover:text-accent">
          ← Tasks
        </Link>
        <div className="rounded-xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-200" role="alert">
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
      <Link to="/" className="text-sm text-zinc-400 hover:text-accent">
        ← Tasks
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h1 className="text-xl font-semibold text-zinc-50 break-words">{task.title}</h1>
          <p className="text-xs text-zinc-500 font-mono break-all">{task.cwd}</p>
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
            className="ml-auto rounded-lg border border-red-800/60 px-3 py-1.5 text-xs font-medium text-red-300 hover:bg-red-950/50 disabled:opacity-50"
          >
            {canceling ? "Canceling…" : "Cancel"}
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-200" role="alert">
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
