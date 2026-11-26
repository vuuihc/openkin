import { describe, expect, it, jest } from "@jest/globals";
import type { TaskEvent } from "../../../ui/src/api/contract";
import {
  createFetchStreamSource,
  eventFromFrame,
  eventsStreamUrl,
  startTaskStream,
  type StreamConnection,
  type StreamRequest,
  type StreamSource,
} from "./stream";

/**
 * KIN-MOBILE-001 R4 — the stream's identity and bounds.
 *
 * These are the R4 acceptance rows that are protocol, not screen: a chunk is
 * applied once, a reconnect resumes after the last seq, a closed stream's late
 * chunk is dropped, and a stalled stream reports offline instead of hanging.
 */

const TASK_ID = "task-1";
const ORIGIN = "https://kin.example.com";

function event(seq: number, type = "message", payload: TaskEvent["payload"] = {}): TaskEvent {
  return {
    task_id: TASK_ID,
    event_epoch: 0,
    seq,
    ts: 1_000 + seq,
    type,
    payload,
  };
}

function frame(value: TaskEvent): string {
  return `event: event\ndata: ${JSON.stringify({ kind: "event", data: value })}\n\n`;
}

type ChunkQueue = {
  iterable: AsyncIterable<string>;
  push(chunk: string): void;
  end(): void;
};

function chunkQueue(): ChunkQueue {
  const pending: string[] = [];
  let waiting: ((result: IteratorResult<string>) => void) | null = null;
  let ended = false;
  return {
    iterable: {
      [Symbol.asyncIterator](): AsyncIterator<string> {
        return {
          next(): Promise<IteratorResult<string>> {
            if (pending.length > 0) {
              return Promise.resolve({ done: false, value: pending.shift() as string });
            }
            if (ended) return Promise.resolve({ done: true, value: undefined });
            return new Promise((resolve) => {
              waiting = resolve;
            });
          },
        };
      },
    },
    push(chunk) {
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve({ done: false, value: chunk });
        return;
      }
      pending.push(chunk);
    },
    end() {
      ended = true;
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve({ done: true, value: undefined });
      }
    },
  };
}

type FakeStream = {
  source: StreamSource;
  requests: StreamRequest[];
  connections: Array<{ push(chunk: string): void; end(): void }>;
  failOpen(): void;
};

function fakeStream(): FakeStream {
  const requests: StreamRequest[] = [];
  const connections: Array<{ push(chunk: string): void; end(): void }> = [];
  let failing = false;
  return {
    requests,
    connections,
    failOpen() {
      failing = true;
    },
    source: {
      async open(request): Promise<StreamConnection> {
        requests.push(request);
        if (failing) throw new Error("unreachable");
        const queue = chunkQueue();
        connections.push({ push: queue.push, end: queue.end });
        return { status: 200, chunks: queue.iterable };
      },
    },
  };
}

/** Retries run on the microtask queue so a test never waits on wall clock. */
const immediate = (run: () => void): (() => void) => {
  queueMicrotask(run);
  return () => undefined;
};

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("KIN-MOBILE-001 R4 stream", () => {
  it("KIN-MOBILE-001 R4: reads only this task's event frames", () => {
    const mine = event(3);
    const other = { ...event(4), task_id: "task-2" };

    expect(eventFromFrame(frame(mine), TASK_ID)).toEqual(mine);
    expect(eventFromFrame(frame(other), TASK_ID)).toBeNull();
    expect(eventFromFrame(": ping\n\n", TASK_ID)).toBeNull();
  });

  it("KIN-MOBILE-001 R4: a duplicate seq is applied once", async () => {
    const fake = fakeStream();
    const seen: TaskEvent[] = [];
    const stream = startTaskStream({
      origin: ORIGIN,
      token: "token",
      taskId: TASK_ID,
      source: fake.source,
      onEvent: (value) => seen.push(value),
    });
    await settle();

    fake.connections[0].push(frame(event(3)));
    fake.connections[0].push(frame(event(3)));
    await settle();

    expect(seen.map((value) => value.seq)).toEqual([3]);
    stream.stop();
  });

  it("KIN-MOBILE-001 R4: a reconnect resumes after the last applied seq", async () => {
    const fake = fakeStream();
    const seen: TaskEvent[] = [];
    const stream = startTaskStream({
      origin: ORIGIN,
      token: "token",
      taskId: TASK_ID,
      source: fake.source,
      onEvent: (value) => seen.push(value),
      schedule: immediate,
    });
    await settle();

    fake.connections[0].push(frame(event(1)));
    fake.connections[0].push(frame(event(2)));
    await settle();
    fake.connections[0].end();
    await settle();

    expect(seen.map((value) => value.seq)).toEqual([1, 2]);
    expect(fake.requests.length).toBeGreaterThanOrEqual(2);
    expect(fake.requests[1].afterSeq).toBe(2);
    expect(fake.requests[1].url).toBe(`${eventsStreamUrl(ORIGIN)}?after_seq=2`);

    // The resumed connection replays an applied seq; it must not redraw it.
    fake.connections[1].push(frame(event(2)));
    fake.connections[1].push(frame(event(3)));
    await settle();
    expect(seen.map((value) => value.seq)).toEqual([1, 2, 3]);
    stream.stop();
  });

  it("KIN-MOBILE-001 R4: a snapshot resume drops a replayed seq at epoch 0", async () => {
    // A caller holding a snapshot starts at `afterSeq: 2`. The first live
    // event carries `event_epoch: 0`, the contract's first epoch; it must not
    // be mistaken for a rewritten tail that resets the cursor to 0.
    const fake = fakeStream();
    const seen: TaskEvent[] = [];
    const stream = startTaskStream({
      origin: ORIGIN,
      token: "token",
      taskId: TASK_ID,
      source: fake.source,
      afterSeq: 2,
      onEvent: (value) => seen.push(value),
    });
    await settle();

    expect(fake.requests[0].afterSeq).toBe(2);
    expect(stream.lastSeq()).toBe(2);
    fake.connections[0].push(frame(event(2)));
    fake.connections[0].push(frame(event(3)));
    await settle();

    expect(seen.map((value) => value.seq)).toEqual([3]);
    expect(stream.lastSeq()).toBe(3);
    stream.stop();
  });

  it("KIN-MOBILE-001 R4: a chunk from a closed stream's generation is dropped", async () => {
    const fake = fakeStream();
    const seen: TaskEvent[] = [];
    const stream = startTaskStream({
      origin: ORIGIN,
      token: "token",
      taskId: TASK_ID,
      source: fake.source,
      onEvent: (value) => seen.push(value),
    });
    await settle();
    const connection = fake.connections[0];

    stream.stop();
    connection.push(frame(event(9)));
    await settle();

    expect(seen).toEqual([]);
  });

  it("KIN-MOBILE-001 R4: gives up after the reconnect cap and reports offline", async () => {
    // Every open rejects, so the cap is the only thing that ends the loop.
    // The count is pinned literally, not from RECONNECT_MAX_ATTEMPTS: the
    // contract is the number the caller experiences (1 initial open + 5
    // retries), so weakening the constant must turn this red.
    const opens: StreamRequest[] = [];
    const source: StreamSource = {
      async open(request): Promise<StreamConnection> {
        opens.push(request);
        throw new Error("unreachable");
      },
    };
    const statuses: string[] = [];
    const onReconnect = jest.fn();
    const stream = startTaskStream({
      origin: ORIGIN,
      token: "token",
      taskId: TASK_ID,
      source,
      onEvent: () => undefined,
      onStatus: (status) => statuses.push(status),
      onReconnect,
      schedule: immediate,
    });
    await settle();
    stream.stop();

    expect(opens).toHaveLength(6);
    expect(onReconnect).not.toHaveBeenCalled();
    expect(statuses[statuses.length - 1]).toBe("offline");
  });

  it("KIN-MOBILE-001 R4: a stalled stream hits its bound and reports offline", async () => {
    // Accepts the connection and never writes a byte.
    const hangingFetch = jest.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const statuses: string[] = [];
    const source = createFetchStreamSource({
      fetchImpl: hangingFetch as unknown as typeof fetch,
      firstByteTimeoutMs: 20,
    });

    const stream = startTaskStream({
      origin: ORIGIN,
      token: "token",
      taskId: TASK_ID,
      source,
      onEvent: () => undefined,
      onStatus: (status) => statuses.push(status),
      backoff: { baseMs: 1, maxMs: 1, maxAttempts: 1 },
      schedule: immediate,
    });

    const deadline = Date.now() + 2_000;
    while (!statuses.includes("offline") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    stream.stop();

    expect(statuses).toContain("offline");
  });
});
