/**
 * KIN-MOBILE-001 R4a — the headless conversation read model.
 *
 * The signed R4 row says the phone reads with the *same* projection the web
 * console uses. So nothing here re-derives the transcript: it loads the task
 * and its events through the RN transport, then calls `buildChatItems` ->
 * `mergeProcessRuns` -> `groupIntoTurns` in place from
 * `ui/src/components/chat/transcriptProjection.ts`.
 *
 * The screen layer (R4b) is pure presentation over `ThreadState`; this module
 * also owns the stream append, the send queue and the stop row, plus the
 * generation rule that keeps a late answer from repainting a newer one.
 */

import type { Task, TaskEvent } from "../../../ui/src/api/contract";
import {
  buildChatItems,
  groupIntoTurns,
  mergeProcessRuns,
  normalizeModel,
  type Turn,
} from "../../../ui/src/components/chat/transcriptProjection";
import {
  hasSequenceGap,
  highestContiguousSeq,
  mergeEventsBySeq,
} from "../../../ui/src/lib/eventStream";
import { apiFetch, type TransportReason } from "../api/transport";
import {
  createFetchStreamSource,
  startTaskStream,
  type Scheduler,
  type StreamSource,
  type StreamStatus,
  type TaskStream,
} from "./stream";

export type ThreadStatus = "loading" | "ready" | "error";

export type ThreadBanner = "offline" | null;

export type QueuedSend = {
  id: string;
  text: string;
};

export type ThreadState = {
  taskId: string;
  /**
   * The task's name as the list knows it; `""` when the node reports none.
   * The header draws it, falling back to the catalogue's `sessions.untitled`.
   */
  title: string;
  status: ThreadStatus;
  turns: Turn[];
  running: boolean;
  sendQueue: QueuedSend[];
  banner: ThreadBanner;
  /** Why the last load or send failed; null while healthy. */
  reason: TransportReason | null;
};

/** The web client's `/api/tasks/:id/events` path and query, in one place. */
export function taskEventsPath(taskId: string, sinceSeq = 0): string {
  const query = sinceSeq > 0 ? `?since_seq=${sinceSeq}` : "";
  return `/api/tasks/${encodeURIComponent(taskId)}/events${query}`;
}

export function taskPath(taskId: string): string {
  return `/api/tasks/${encodeURIComponent(taskId)}`;
}

export function cancelTaskPath(taskId: string): string {
  return `/api/tasks/${encodeURIComponent(taskId)}/cancel`;
}

export function promptPath(taskId: string): string {
  return `/api/tasks/${encodeURIComponent(taskId)}/prompt`;
}

/** The web console's terminal set (`isTerminal` in `ui/src/api/client.ts`). */
export function isTerminalStatus(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}

/**
 * Turn an event list into turns exactly as the web transcript does. `previous`
 * lets a later read reuse the turn objects whose projected content did not
 * change, so an earlier turn is not redrawn (and a memoized row can skip).
 */
export function projectThread(
  events: readonly TaskEvent[],
  task: Pick<Task, "agent" | "model" | "status"> | null,
  previous: readonly Turn[] = [],
): Turn[] {
  const hostSpeaker = task?.agent || "kin";
  const hostModel = normalizeModel(task?.model);
  const finalized = task ? isTerminalStatus(task.status) : false;
  // While the turn runs, the projection keeps its notes as body text and its
  // tools in a card; a settled turn folds into one row. This is the same
  // `mergeProcessRuns(..., !finalized)` pair the web transcript builds
  // (`ui/src/components/chat/ChatStream.tsx`), so the phone cannot disagree
  // about where a process card begins or ends.
  const items = mergeProcessRuns(
    buildChatItems([...events], hostSpeaker, hostModel, finalized, task?.status ?? null),
    !finalized,
  );
  const next = groupIntoTurns(items, hostSpeaker, hostModel);
  return next.map((turn, index) => {
    const before = previous[index];
    return before && turnSignature(before) === turnSignature(turn) ? before : turn;
  });
}

function turnSignature(turn: Turn): string {
  return JSON.stringify(turn);
}

export type LoadThreadOptions = {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
};

/** The view state plus the snapshot it was projected from. */
export type ThreadSnapshot = ThreadState & {
  task: Task | null;
  events: TaskEvent[];
};

function emptyState(taskId: string): ThreadState {
  return {
    taskId,
    title: "",
    status: "loading",
    turns: [],
    running: false,
    sendQueue: [],
    banner: null,
    reason: null,
  };
}

/**
 * One read of a conversation. Both requests are bounded by the transport's
 * timeout. A failure is one whole-screen error, never a half transcript.
 */
export async function loadThread(
  origin: string,
  token: string,
  taskId: string,
  options: LoadThreadOptions = {},
): Promise<ThreadSnapshot> {
  const request = {
    token,
    fetchImpl: options.fetchImpl,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  };
  // The events are the transcript; the task row rides along because its status
  // is the durable running/stopped fact the projection needs (a canceled task
  // is what puts the stop row back after a reload), and it names the host
  // speaker/model the shared projection groups by.
  const [taskResult, eventsResult] = await Promise.all([
    apiFetch<Task>(origin, taskPath(taskId), request),
    apiFetch<TaskEvent[]>(origin, taskEventsPath(taskId), request),
  ]);

  if (!taskResult.ok || !eventsResult.ok) {
    const reason = !taskResult.ok ? taskResult.reason : !eventsResult.ok ? eventsResult.reason : null;
    return {
      ...emptyState(taskId),
      status: "error",
      banner: reason === "unreachable" ? "offline" : null,
      reason,
      task: null,
      events: [],
    };
  }

  const task = taskResult.data;
  const events = eventsResult.data;
  return {
    taskId,
    title: task.title ?? "",
    status: "ready",
    turns: projectThread(events, task),
    running: !isTerminalStatus(task.status),
    sendQueue: [],
    banner: null,
    reason: null,
    task,
    events,
  };
}

export type SendOutcome =
  | { ok: true; queued: boolean }
  | { ok: false; reason: TransportReason | "offline" | "empty" | "stale" };

export type StopOutcome =
  | { ok: true }
  | { ok: false; reason: TransportReason | "not_running" | "stale" };

export type ThreadOptions = {
  origin: string;
  token: string;
  taskId: string;
  fetchImpl?: typeof fetch;
  /** Tests inject a chunk source; production builds the fetch reader. */
  source?: StreamSource;
  schedule?: Scheduler;
  backoff?: { baseMs?: number; maxMs?: number; maxAttempts?: number };
  firstByteTimeoutMs?: number;
  idleTimeoutMs?: number;
  timeoutMs?: number;
  newId?: () => string;
  onState?: (state: ThreadState) => void;
};

export type Thread = {
  getState(): ThreadState;
  subscribe(listener: (state: ThreadState) => void): () => void;
  /** Read the history and begin streaming. */
  start(): Promise<ThreadState>;
  /** Read the history only; `start()` also opens the stream. */
  load(): Promise<ThreadState>;
  /**
   * Rejoin a conversation whose live stream gave up, without the visible
   * re-read `start()` does: the new connection resumes from the last applied
   * seq and one bounded catch-up repairs what the dead stream missed. A no-op
   * while the stream is healthy, before the first read, or after `close()`.
   */
  resume(): Promise<ThreadState>;
  send(text: string): Promise<SendOutcome>;
  cancelQueued(id: string): void;
  stop(): Promise<StopOutcome>;
  close(): void;
};

let nextFallbackId = 0;

export function createThread(options: ThreadOptions): Thread {
  const { origin, token, taskId, fetchImpl, schedule, timeoutMs } = options;
  const newId = options.newId ?? (() => `send-${++nextFallbackId}`);

  let state = emptyState(taskId);
  let events: TaskEvent[] = [];
  let task: Task | null = null;
  let epoch = -1;
  // Every async answer carries the generation of the flow that asked for it
  // (AGENTS.md §11). A closed screen or a newer load bumps this, and the late
  // answer is dropped instead of repainting the conversation.
  let generation = 0;
  let closed = false;
  let stream: TaskStream | null = null;
  let flushing = false;
  let recovering: Promise<void> | null = null;
  const listeners = new Set<(state: ThreadState) => void>();

  const publish = (patch: Partial<ThreadState>): void => {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener(state));
    options.onState?.(state);
  };

  const request = { token, fetchImpl, timeoutMs };

  // One read, generation-guarded, through the same `loadThread` the tests call
  // so the model and the pure read cannot disagree about the projection.
  const read = async (): Promise<ThreadState> => {
    const myGeneration = ++generation;
    publish({ status: "loading", reason: null });
    const snapshot = await loadThread(origin, token, taskId, { fetchImpl, timeoutMs });
    if (myGeneration !== generation) return state;
    if (snapshot.status === "error") {
      // An offline read keeps whatever the screen already had.
      publish({
        status: "error",
        banner: snapshot.banner,
        reason: snapshot.reason,
        turns: state.turns,
      });
      return state;
    }
    const loadedTask = snapshot.task;
    task = loadedTask;
    events = snapshot.events;
    // The task row carries the current epoch (`event_epoch >= 0` in the
    // contract). Deriving it from the events alone left `-1` on an empty
    // history, so a gap-fill filtered out every real epoch-0 event.
    epoch = loadedTask?.event_epoch ?? 0;
    publish({
      status: "ready",
      title: loadedTask?.title ?? "",
      turns: projectThread(events, loadedTask, state.turns),
      running: loadedTask ? !isTerminalStatus(loadedTask.status) : false,
      banner: null,
      reason: null,
    });
    return state;
  };

  // The stream can skip a seq (a reconnect, a daemon that replays past the
  // cursor). The durable log is the repair: one REST catch-up at the contiguous
  // cursor, filtered to the epoch the stream is delivering.
  const applyGapFill = async (afterSeq: number, myGeneration: number): Promise<void> => {
    const result = await apiFetch<TaskEvent[]>(
      origin,
      taskEventsPath(taskId, afterSeq),
      request,
    );
    if (myGeneration !== generation) return;
    if (!result.ok) {
      if (result.reason === "unreachable") publish({ banner: "offline" });
      return;
    }
    const incoming = result.data.filter((event) => event.event_epoch === epoch);
    if (incoming.length === 0) return;
    const merged = mergeEventsBySeq(events, incoming);
    // Nothing new: do not repaint a transcript that is already correct.
    if (merged.length === events.length) return;
    events = merged;
    // A recovered `result` is the round's durable end even when the live
    // stream skipped it: settle the task row before projecting (the shared
    // projection folds the settled process card on that status), stop the
    // round, and let the queue send its next item. The last recovered result
    // is the round end that matters when the catch-up spans several rounds.
    const ended = incoming.reduce<TaskEvent | undefined>(
      (found, event) => (event.type === "result" ? event : found),
      undefined,
    );
    if (ended && task) {
      task = {
        ...task,
        status: ended.payload.is_error === true ? "failed" : "succeeded",
      };
    }
    publish({
      turns: projectThread(events, task, state.turns),
      ...(ended ? { running: false } : {}),
    });
    if (ended) void flushQueue();
  };

  const recoverGap = (afterSeq: number): Promise<void> => {
    if (recovering) return recovering;
    const myGeneration = generation;
    const pending = applyGapFill(afterSeq, myGeneration).finally(() => {
      // Only the repair still in the slot may clear it: an epoch bump or a
      // newer gap may already have put a fresh catch-up there.
      if (recovering === pending) recovering = null;
    });
    recovering = pending;
    return pending;
  };

  const applyEvent = (event: TaskEvent): void => {
    if (event.task_id !== taskId) return;
    if (event.event_epoch < epoch) return;
    if (event.event_epoch > epoch) {
      // A retry rewrote the tail: earlier seqs no longer mean what they did,
      // and a repair still fetching the old epoch must not answer for the new
      // one, so drop it from the slot before the next gap asks.
      epoch = event.event_epoch;
      events = [];
      recovering = null;
    }
    const cursor = highestContiguousSeq(events);
    const merged = mergeEventsBySeq(events, [event]);
    if (merged.length === events.length) return; // duplicate seq
    events = merged;
    const roundEnded = event.type === "result" || event.type === "error";
    if (event.type === "result" && task) {
      // The task row is the durable fact the shared projection folds a settled
      // process card on; leaving it at `running` kept the card open after the
      // round's own `result` arrived.
      task = {
        ...task,
        status: event.payload.is_error === true ? "failed" : "succeeded",
      };
    }
    publish({
      turns: projectThread(events, task, state.turns),
      ...(roundEnded ? { running: false } : {}),
      banner: null,
    });
    if (hasSequenceGap(cursor, event.seq)) void recoverGap(cursor);
    if (roundEnded) void flushQueue();
  };

  const onStreamStatus = (status: StreamStatus): void => {
    if (status === "offline") publish({ banner: "offline" });
    if (status === "connected" && state.banner === "offline") publish({ banner: null });
  };

  const startStream = (afterSeq = highestContiguousSeq(events)): void => {
    if (stream) return;
    stream = startTaskStream({
      origin,
      token,
      taskId,
      source:
        options.source ??
        createFetchStreamSource({
          fetchImpl,
          firstByteTimeoutMs: options.firstByteTimeoutMs,
          idleTimeoutMs: options.idleTimeoutMs,
        }),
      afterSeq,
      onEvent: applyEvent,
      onStatus: onStreamStatus,
      onReconnect: (afterSeq) => {
        // Web parity: a reconnect catches up through the durable cursor
        // (`listEvents(since_seq)`) before the new connection replays anything.
        void recoverGap(afterSeq);
      },
      schedule,
      backoff: options.backoff,
    });
  };

  const postPrompt = (text: string) =>
    apiFetch<Task>(origin, promptPath(taskId), {
      ...request,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: text }),
    });

  const postStop = () =>
    apiFetch<Task>(origin, cancelTaskPath(taskId), {
      ...request,
      method: "POST",
    });

  // Strictly one at a time, in order. A failure keeps the item (it is still
  // visible text the person can cancel) and stops the flush.
  const flushQueue = async (): Promise<void> => {
    if (flushing) return;
    flushing = true;
    try {
      while (state.sendQueue.length > 0) {
        if (state.banner === "offline") return;
        const item = state.sendQueue[0];
        if (!item) return;
        const myGeneration = generation;
        const result = await postPrompt(item.text);
        if (myGeneration !== generation) return;
        if (!result.ok) {
          if (result.reason === "unreachable") publish({ banner: "offline" });
          return;
        }
        task = result.data;
        const running = !isTerminalStatus(result.data.status);
        publish({
          sendQueue: state.sendQueue.filter((queued) => queued.id !== item.id),
          running,
        });
        // One prompt per round: an accepted prompt opens a new round, so the
        // rest of the queue waits for that round's `result` (which flushes
        // this loop again). Draining it here sent several prompts into one
        // round and raced a concurrent `send` past the queue.
        if (running) return;
      }
    } finally {
      flushing = false;
    }
  };

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    load: read,

    async start() {
      const next = await read();
      if (next.status === "ready") {
        // A stream that gave up (`offline`) is dead but still in the slot, and
        // `startStream` returns early on a non-null handle. A retried `start()`
        // is a fresh subscription: replace the dead stream rather than report
        // ready with nothing listening.
        stream?.stop();
        stream = null;
        startStream();
      }
      return state;
    },

    async resume() {
      // A closed screen owns nothing: its listeners are gone and the
      // conversation may already be open elsewhere (AGENTS.md §11).
      if (closed) return state;
      // Before the first read there is nothing to continue, and the
      // blank/expired screen keeps its own full-screen retry (`canRetry` in
      // native/reconnect.ts), so neither is a resume.
      if (state.status !== "ready") return state;
      // Healthy: a live stream is in the slot and nothing says offline. A
      // foreground return must not open a second connection.
      if (state.banner !== "offline" && stream) return state;

      // Resume from the last applied seq, not from zero: replaying would
      // redraw what the reader already read. The dead stream is replaced (a
      // no-op if it already stopped itself) and the bounded catch-up repairs
      // what it missed while the screen was away.
      const resumeAfter = highestContiguousSeq(events);
      stream?.stop();
      stream = null;
      startStream(resumeAfter);
      // No `status: "loading"` here, by design: the story asks for a silent
      // refresh, and `turns`, `sendQueue`, `task` and `running` stay as they
      // are. An unreachable catch-up only re-publishes the offline banner.
      await applyGapFill(resumeAfter, generation);
      return state;
    },

    async send(text) {
      const trimmed = text.trim();
      if (!trimmed) return { ok: false, reason: "empty" };
      if (state.banner === "offline") return { ok: false, reason: "offline" };
      // A queue that still holds items (a failed flush keeps them) must keep
      // its order: a direct post here would jump ahead of the queue.
      if (state.running || flushing || state.sendQueue.length > 0) {
        publish({ sendQueue: [...state.sendQueue, { id: newId(), text: trimmed }] });
        return { ok: true, queued: true };
      }
      const myGeneration = generation;
      const result = await postPrompt(trimmed);
      if (myGeneration !== generation) return { ok: false, reason: "stale" };
      if (!result.ok) {
        publish({
          banner: result.reason === "unreachable" ? "offline" : state.banner,
          reason: result.reason,
        });
        return { ok: false, reason: result.reason };
      }
      task = result.data;
      publish({
        running: !isTerminalStatus(result.data.status),
        reason: null,
        banner: null,
      });
      return { ok: true, queued: false };
    },

    cancelQueued(id) {
      publish({ sendQueue: state.sendQueue.filter((item) => item.id !== id) });
    },

    async stop() {
      if (!state.running) return { ok: false, reason: "not_running" };
      const myGeneration = generation;
      const result = await postStop();
      if (myGeneration !== generation) return { ok: false, reason: "stale" };
      if (!result.ok) {
        publish({
          banner: result.reason === "unreachable" ? "offline" : state.banner,
          reason: result.reason,
        });
        return { ok: false, reason: result.reason };
      }
      task = result.data;
      // The durable fact is the task's status. Projecting the events we hold
      // with that status is what puts the stopped meta row on the transcript,
      // and the same call after a reload puts the same row back.
      publish({
        running: false,
        sendQueue: [],
        turns: projectThread(events, result.data, state.turns),
        banner: null,
        reason: null,
      });
      return { ok: true };
    },

    close() {
      closed = true;
      generation += 1;
      stream?.stop();
      stream = null;
      listeners.clear();
    },
  };
}
