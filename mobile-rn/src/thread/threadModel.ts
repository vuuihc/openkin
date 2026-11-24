/**
 * KIN-MOBILE-001 R4a — the headless conversation read model.
 *
 * The signed R4 row says the phone reads with the *same* projection the web
 * console uses. So nothing here re-derives the transcript: it loads the task
 * and its events through the RN transport, then calls `buildChatItems` ->
 * `groupIntoTurns` in place from `ui/src/components/chat/transcriptProjection.ts`.
 *
 * The screen layer (R4b) is pure presentation over `ThreadState`. The live
 * round — streamed appends, the send queue and the stop row — builds on this
 * read in the next slice; this module owns the read and the generation rule
 * that keeps a late answer from repainting a newer one.
 */

import type { Task, TaskEvent } from "../../../ui/src/api/contract";
import {
  buildChatItems,
  groupIntoTurns,
  normalizeModel,
  type Turn,
} from "../../../ui/src/components/chat/transcriptProjection";
import { apiFetch, type TransportReason } from "../api/transport";

export type ThreadStatus = "loading" | "ready" | "error";

export type ThreadBanner = "offline" | null;

export type QueuedSend = {
  id: string;
  text: string;
};

export type ThreadState = {
  taskId: string;
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
  const items = buildChatItems([...events], hostSpeaker, hostModel, finalized, task?.status ?? null);
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

export type ThreadOptions = {
  origin: string;
  token: string;
  taskId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  onState?: (state: ThreadState) => void;
};

export type Thread = {
  getState(): ThreadState;
  subscribe(listener: (state: ThreadState) => void): () => void;
  /** Read the history only; the stream and send land in the next slice. */
  load(): Promise<ThreadState>;
  close(): void;
};

export function createThread(options: ThreadOptions): Thread {
  const { origin, token, taskId, fetchImpl, timeoutMs } = options;

  let state = emptyState(taskId);
  // Every async answer carries the generation of the flow that asked for it
  // (AGENTS.md §11). A closed screen or a newer load bumps this, and the late
  // answer is dropped instead of repainting the conversation.
  let generation = 0;
  const listeners = new Set<(state: ThreadState) => void>();

  const publish = (patch: Partial<ThreadState>): void => {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener(state));
    options.onState?.(state);
  };

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
    publish({
      status: "ready",
      turns: projectThread(snapshot.events, snapshot.task, state.turns),
      running: snapshot.task ? !isTerminalStatus(snapshot.task.status) : false,
      banner: null,
      reason: null,
    });
    return state;
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

    close() {
      generation += 1;
      listeners.clear();
    },
  };
}
