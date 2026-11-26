/**
 * KIN-MOBILE-001 R4a — the RN task-event stream.
 *
 * The web console consumes `/api/events` with `EventSource`-shaped retries
 * (`ui/src/api/client.ts` `streamEvents`). React Native has no `EventSource`,
 * so this is the same protocol over a bounded `fetch` reader, behind a
 * `StreamSource` seam the tests inject chunks into.
 *
 * Every wait is bounded (AGENTS.md §13): the opening frame has its own
 * timeout and a live stream that goes quiet is aborted. A stream that gives up
 * reports `offline`; it never leaves the caller waiting.
 */

import { parseWSMessage, type TaskEvent } from "../../../ui/src/api/contract";
import { apiUrl } from "../api/transport";
import type { Session } from "../auth/tokenStore";

export type StreamStatus = "connecting" | "connected" | "offline";

export type StreamRequest = {
  /** Absolute stream URL, `after_seq` already applied. */
  url: string;
  /**
   * The stored session. A node sends its bearer; a Hub sends no header and
   * asks `fetch` for the native cookie jar where `kin_session` lives.
   */
  session?: Session | null;
  /** A one-shot bearer for a caller that has no session object. */
  token?: string;
  /** Highest applied seq; a reconnect resumes after it. */
  afterSeq: number;
  signal: AbortSignal;
};

export type StreamConnection = {
  status: number;
  chunks: AsyncIterable<string>;
};

/** The part of a fetch body reader this module uses. */
type StreamReader = {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
};

/** The seam tests replace: open a connection, then read decoded text chunks. */
export interface StreamSource {
  open(request: StreamRequest): Promise<StreamConnection>;
}

export const SSE_FIRST_BYTE_TIMEOUT_MS = 10_000;
export const SSE_IDLE_TIMEOUT_MS = 30_000;
export const RECONNECT_BASE_MS = 500;
export const RECONNECT_MAX_MS = 15_000;
export const RECONNECT_MAX_ATTEMPTS = 5;

/** `/api/events` with the shared URL builder; `after_seq` only when resuming. */
export function eventsStreamUrl(origin: string, afterSeq = 0): string {
  const url = apiUrl(origin, "/api/events");
  return afterSeq > 0 ? `${url}?after_seq=${afterSeq}` : url;
}

/**
 * One SSE frame -> the task event it carries, or null for heartbeats, other
 * message kinds, and events for a different task. The daemon's frame is
 * `data: {"kind":"event","data":{...}}`; `parseWSMessage` is the same
 * validator the web console uses, so an unknown shape is dropped rather than
 * trusted.
 */
export function eventFromFrame(frame: string, taskId: string): TaskEvent | null {
  let data = "";
  for (const raw of frame.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line === "" || line.startsWith(":")) continue;
    if (line.startsWith("data:")) data += line.slice(5).trimStart();
  }
  if (!data) return null;
  const message = parseWSMessage(data);
  if (!message || message.kind !== "event") return null;
  return message.data.task_id === taskId ? message.data : null;
}

export type FetchStreamOptions = {
  fetchImpl?: typeof fetch;
  firstByteTimeoutMs?: number;
  idleTimeoutMs?: number;
};

/**
 * The production source: `fetch` + a reader. The controller carries three
 * bounds — the caller's abort, the first-byte timeout, and the idle timeout —
 * so a proxy that accepts the connection and then says nothing is treated as
 * a dead stream instead of a healthy one.
 */
export function createFetchStreamSource(options: FetchStreamOptions = {}): StreamSource {
  const doFetch = options.fetchImpl ?? fetch;
  const firstByteMs = options.firstByteTimeoutMs ?? SSE_FIRST_BYTE_TIMEOUT_MS;
  const idleMs = options.idleTimeoutMs ?? SSE_IDLE_TIMEOUT_MS;

  return {
    async open(request) {
      const controller = new AbortController();
      const forwardAbort = (): void => controller.abort();
      if (request.signal.aborted) controller.abort();
      else request.signal.addEventListener("abort", forwardAbort);

      const headers: Record<string, string> = { Accept: "text/event-stream" };
      if (request.session?.kind === "node") {
        headers.Authorization = `Bearer ${request.session.token}`;
      } else if (request.session == null && request.token) {
        headers.Authorization = `Bearer ${request.token}`;
      }
      // A Hub's only credential is the session cookie; the native jar sends it
      // when the request asks for it explicitly.
      const credentials =
        request.session?.kind === "hub" ? "include" : undefined;
      // The daemon does not read this yet; it is the standard SSE resume marker
      // and the model still dedupes by seq, so sending it can only help.
      if (request.afterSeq > 0) headers["Last-Event-ID"] = String(request.afterSeq);

      const openTimer = setTimeout(() => controller.abort(), firstByteMs);
      let response: Response;
      try {
        response = await doFetch(request.url, {
          headers,
          signal: controller.signal,
          ...(credentials === undefined ? {} : { credentials }),
        });
      } catch (error) {
        clearTimeout(openTimer);
        request.signal.removeEventListener("abort", forwardAbort);
        throw error;
      }
      clearTimeout(openTimer);
      // Structural so the module does not depend on the DOM lib's exact
      // `ReadableStream` typings; RN's fetch body has the same reader shape.
      const body = response.body as unknown as { getReader(): StreamReader } | null;
      if (!body) {
        request.signal.removeEventListener("abort", forwardAbort);
        throw new Error("event stream has no body");
      }

      const reader = body.getReader();
      const decoder = new TextDecoder();
      return {
        status: response.status,
        chunks: (async function* readChunks(): AsyncGenerator<string> {
          try {
            for (;;) {
              const idleTimer = setTimeout(() => controller.abort(), idleMs);
              let next: { done: boolean; value?: Uint8Array };
              try {
                next = await reader.read();
              } finally {
                clearTimeout(idleTimer);
              }
              if (next.done) return;
              if (next.value && next.value.length > 0) {
                yield decoder.decode(next.value, { stream: true });
              }
            }
          } finally {
            request.signal.removeEventListener("abort", forwardAbort);
            controller.abort();
            try {
              await reader.cancel();
            } catch {
              // Already closed by the abort above.
            }
          }
        })(),
      };
    },
  };
}

export type Scheduler = (run: () => void, delayMs: number) => () => void;

const defaultSchedule: Scheduler = (run, delayMs) => {
  const timer = setTimeout(run, delayMs);
  return () => clearTimeout(timer);
};

export type TaskStreamOptions = {
  /** The session's origin is used when one is given. */
  origin?: string;
  session?: Session | null;
  /** A one-shot bearer; a session takes precedence. */
  token?: string;
  taskId: string;
  source: StreamSource;
  /** Resume cursor when a caller already holds a snapshot. */
  afterSeq?: number;
  onEvent: (event: TaskEvent) => void;
  onStatus?: (status: StreamStatus) => void;
  /** Before a reconnect opens, with the seq to resume after. */
  onReconnect?: (afterSeq: number) => void;
  backoff?: {
    baseMs?: number;
    maxMs?: number;
    maxAttempts?: number;
  };
  /** Tests drive retries deterministically. */
  schedule?: Scheduler;
};

export type TaskStream = {
  stop(): void;
  /** Highest applied seq; the resume cursor. */
  lastSeq(): number;
};

/**
 * Consume one task's events from the daemon stream.
 *
 * Identity is `(event_epoch, seq)`: a higher epoch is a rewritten tail, which
 * resets both the cursor and the seen set; a lower one is a stale chunk from a
 * stream the caller already left and is dropped. Within an epoch an applied
 * seq is never delivered twice, so a reconnect (or a daemon that replays) can
 * not redraw what the transcript already has.
 */
export function startTaskStream(options: TaskStreamOptions): TaskStream {
  const {
    session,
    token,
    taskId,
    source,
    onEvent,
    onStatus,
    onReconnect,
    schedule = defaultSchedule,
  } = options;
  const origin = session?.origin ?? options.origin;
  if (!origin) {
    throw new Error("startTaskStream needs an origin or a session");
  }
  const baseMs = options.backoff?.baseMs ?? RECONNECT_BASE_MS;
  const maxMs = options.backoff?.maxMs ?? RECONNECT_MAX_MS;
  const maxAttempts = options.backoff?.maxAttempts ?? RECONNECT_MAX_ATTEMPTS;

  let stopped = false;
  let generation = 0;
  let failures = 0;
  let everConnected = false;
  // `event_epoch >= 0` in the contract (`ui/src/api/contract.ts`), so 0 is the
  // first epoch: starting at -1 would treat a normal first event as a rewritten
  // tail and wipe the snapshot's `afterSeq`.
  let epoch = 0;
  let lastSeq = options.afterSeq ?? 0;
  let seen = new Set<number>();
  let cancelTimer: (() => void) | null = null;
  let activeController: AbortController | null = null;

  const scheduleRetry = (): void => {
    if (stopped) return;
    if (failures >= maxAttempts) {
      onStatus?.("offline");
      return;
    }
    const delay = Math.min(maxMs, baseMs * 2 ** Math.min(failures, 4));
    failures += 1;
    cancelTimer = schedule(run, delay);
  };

  const run = async (): Promise<void> => {
    if (stopped) return;
    const myGeneration = ++generation;
    cancelTimer = null;
    if (everConnected) onReconnect?.(lastSeq);
    onStatus?.("connecting");

    const controller = new AbortController();
    activeController = controller;
    let connection: StreamConnection;
    try {
      connection = await source.open({
        url: eventsStreamUrl(origin, lastSeq),
        session,
        token,
        afterSeq: lastSeq,
        signal: controller.signal,
      });
    } catch {
      if (stopped || myGeneration !== generation) return;
      scheduleRetry();
      return;
    }
    // stop() (or a newer run) while the connection was opening: its chunks
    // belong to a flow nobody is watching.
    if (stopped || myGeneration !== generation) {
      controller.abort();
      return;
    }
    if (connection.status === 401 || connection.status === 403) {
      // Retrying an unauthorized stream cannot fix it.
      stopped = true;
      controller.abort();
      onStatus?.("offline");
      return;
    }
    if (connection.status < 200 || connection.status >= 300) {
      controller.abort();
      scheduleRetry();
      return;
    }

    onStatus?.("connected");
    everConnected = true;

    let buffer = "";
    try {
      for await (const chunk of connection.chunks) {
        // A closed stream's late chunk carries an older generation and is
        // dropped before it can touch the transcript.
        if (stopped || myGeneration !== generation) return;
        failures = 0;
        buffer += chunk;
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const event = eventFromFrame(frame, taskId);
          if (event) apply(event);
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // Aborted by a bound, offline, or the node closed: all retried the same.
    }
    if (stopped || myGeneration !== generation) return;
    scheduleRetry();
  };

  const apply = (event: TaskEvent): void => {
    if (event.event_epoch < epoch) return;
    if (event.event_epoch > epoch) {
      epoch = event.event_epoch;
      lastSeq = 0;
      seen = new Set<number>();
    }
    if (event.seq <= lastSeq || seen.has(event.seq)) return;
    seen.add(event.seq);
    lastSeq = event.seq;
    onEvent(event);
  };

  void run();

  return {
    stop(): void {
      stopped = true;
      generation += 1;
      cancelTimer?.();
      cancelTimer = null;
      activeController?.abort();
    },
    lastSeq(): number {
      return lastSeq;
    },
  };
}
