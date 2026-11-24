import { describe, expect, it, jest } from "@jest/globals";
import type { Task, TaskEvent } from "../../../ui/src/api/contract";
import {
  buildChatItems,
  groupIntoTurns,
  type Turn,
} from "../../../ui/src/components/chat/transcriptProjection";
import { createThread, loadThread } from "./threadModel";
import type { StreamConnection, StreamRequest, StreamSource } from "./stream";

/**
 * KIN-MOBILE-001 R4 — the headless conversation model.
 *
 * The history row compares against the shared projection itself, not a
 * hand-written expectation: R4's contract is that the phone groups the
 * transcript exactly as the web console does.
 */

const TASK_ID = "task-1";
const ORIGIN = "https://kin.example.com";
const TOKEN = "fixture-token-not-real";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    title: "A conversation",
    agent: "kin",
    cwd: "/work",
    prompt: "hello",
    model: "model-x",
    status: "running",
    tokens_in: 0,
    tokens_out: 0,
    created_at: 1,
    event_epoch: 0,
    ...overrides,
  };
}

function event(
  seq: number,
  type = "message",
  payload: TaskEvent["payload"] = {},
): TaskEvent {
  return {
    task_id: TASK_ID,
    event_epoch: 0,
    seq,
    ts: 1_000 + seq,
    type,
    payload,
  };
}

const HISTORY: TaskEvent[] = [
  event(1, "message", {
    speaker: "user",
    role: "user",
    content: "hello",
    visibility: { user: true, task: true },
  }),
  event(2, "task_started"),
  event(3, "message", {
    speaker: "kin",
    content: "hi there",
    visibility: { user: true, task: true },
  }),
  event(4, "result", { is_error: false }),
];

/** A round that is still open: what R4's queue and stop rows act on. */
const RUNNING: TaskEvent[] = [
  event(1, "message", {
    speaker: "user",
    role: "user",
    content: "do it",
    visibility: { user: true, task: true },
  }),
  event(2, "task_started"),
  event(3, "message", {
    speaker: "kin",
    content: "working",
    visibility: { user: true, task: true },
  }),
];

function frame(value: TaskEvent): string {
  return `event: event\ndata: ${JSON.stringify({ kind: "event", data: value })}\n\n`;
}

function ok(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

type Reply = { status?: number; body: unknown };
type Router = (url: string, init?: RequestInit) => Reply | Promise<Reply>;

function routedFetch(route: Router): typeof fetch {
  return jest.fn(async (input: string, init?: RequestInit) => {
    const reply = await route(input, init);
    return ok(reply.body, reply.status ?? 200);
  }) as unknown as typeof fetch;
}

type ChunkQueue = { iterable: AsyncIterable<string>; push(chunk: string): void; end(): void };

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

const immediate = (run: () => void): (() => void) => {
  queueMicrotask(run);
  return () => undefined;
};

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Meta keys anywhere in the turns (agent turns hold them in `items`). */
function metaKeys(turns: readonly Turn[]): string[] {
  const keys: string[] = [];
  for (const turn of turns) {
    const items =
      turn.kind === "agent" ? turn.items : turn.kind === "user" ? [turn.item] : [turn.item];
    for (const item of items) {
      if (item.kind === "meta") keys.push(item.key);
    }
  }
  return keys;
}

describe("KIN-MOBILE-001 R4 thread model", () => {
  it("KIN-MOBILE-001 R4: history is grouped by the shared projection", async () => {
    const fetchImpl = routedFetch((url) =>
      url.endsWith("/events") ? { body: HISTORY } : { body: task() },
    );

    const snapshot = await loadThread(ORIGIN, TOKEN, TASK_ID, { fetchImpl });
    const expected = groupIntoTurns(
      buildChatItems(HISTORY, "kin", "model-x", false, "running"),
      "kin",
      "model-x",
    );

    expect(snapshot.status).toBe("ready");
    expect(snapshot.turns).toEqual(expected);
    expect(snapshot.running).toBe(true);
  });

  it("KIN-MOBILE-001 R4: a streamed chunk appends without redrawing earlier turns", async () => {
    const fake = fakeStream();
    const fetchImpl = routedFetch((url) =>
      url.endsWith("/events") ? { body: RUNNING } : { body: task() },
    );
    const model = createThread({
      origin: ORIGIN,
      token: TOKEN,
      taskId: TASK_ID,
      fetchImpl,
      source: fake.source,
      schedule: immediate,
    });

    await model.start();
    await settle();
    const earlier = model.getState().turns[0];

    fake.connections[0].push(
      frame(
        event(4, "message", {
          speaker: "kin",
          content: "more",
          visibility: { user: true, task: true },
        }),
      ),
    );
    await settle();

    const after = model.getState().turns;
    expect(after[0]).toBe(earlier);
    expect(JSON.stringify(after)).toContain("more");
    model.close();
  });

  it("KIN-MOBILE-001 R4: a duplicate seq leaves the turns untouched", async () => {
    const fake = fakeStream();
    const fetchImpl = routedFetch((url) =>
      url.endsWith("/events") ? { body: RUNNING } : { body: task() },
    );
    const model = createThread({
      origin: ORIGIN,
      token: TOKEN,
      taskId: TASK_ID,
      fetchImpl,
      source: fake.source,
      schedule: immediate,
    });

    await model.start();
    await settle();
    const applied = model.getState().turns;

    fake.connections[0].push(frame(event(4, "message", { speaker: "kin", content: "once" })));
    await settle();
    fake.connections[0].push(frame(event(4, "message", { speaker: "kin", content: "once" })));
    await settle();

    const once = model.getState().turns;
    fake.connections[0].push(frame(event(4, "message", { speaker: "kin", content: "once" })));
    await settle();

    expect(model.getState().turns).toBe(once);
    expect(once).not.toBe(applied);
    model.close();
  });

  it("KIN-MOBILE-001 R4: send while running queues, then flushes in order", async () => {
    const fake = fakeStream();
    const prompts: string[] = [];
    const fetchImpl = routedFetch((url, init) => {
      if (url.endsWith("/prompt")) {
        const body = JSON.parse(String(init?.body)) as { prompt: string };
        prompts.push(body.prompt);
        return { body: task() };
      }
      return url.endsWith("/events") ? { body: RUNNING } : { body: task() };
    });
    const model = createThread({
      origin: ORIGIN,
      token: TOKEN,
      taskId: TASK_ID,
      fetchImpl,
      source: fake.source,
      schedule: immediate,
    });

    await model.start();
    await settle();
    expect(model.getState().running).toBe(true);

    expect(await model.send("first")).toEqual({ ok: true, queued: true });
    expect(await model.send("second")).toEqual({ ok: true, queued: true });
    expect(prompts).toEqual([]);
    expect(model.getState().sendQueue.map((item) => item.text)).toEqual(["first", "second"]);

    // A queued item is cancellable while the round runs.
    const queued = model.getState().sendQueue[1];
    model.cancelQueued(queued.id);
    expect(model.getState().sendQueue.map((item) => item.text)).toEqual(["first"]);

    fake.connections[0].push(frame(event(4, "result", { is_error: false })));
    await settle();

    expect(prompts).toEqual(["first"]);
    expect(model.getState().sendQueue).toEqual([]);
    // The accepted prompt opens the next round, so the server's status is live.
    expect(model.getState().running).toBe(true);
    model.close();
  });

  it("KIN-MOBILE-001 R4: stop posts the interrupt and leaves a meta row that survives reload", async () => {
    const fake = fakeStream();
    const canceled = task({ status: "canceled" });
    let stopped = false;
    const fetchImpl = routedFetch((url) => {
      if (url.endsWith("/cancel")) {
        stopped = true;
        return { body: canceled };
      }
      if (url.endsWith("/events")) return { body: RUNNING };
      // The task row carries the cancel after the POST, which is exactly what
      // makes the stopped meta row survive a reload.
      return { body: stopped ? canceled : task() };
    });
    const model = createThread({
      origin: ORIGIN,
      token: TOKEN,
      taskId: TASK_ID,
      fetchImpl,
      source: fake.source,
      schedule: immediate,
    });

    await model.start();
    await settle();
    expect(await model.stop()).toEqual({ ok: true });

    expect(stopped).toBe(true);
    expect(model.getState().running).toBe(false);
    const stoppedKeys = metaKeys(model.getState().turns).filter((key) =>
      key.startsWith("stopped-"),
    );
    expect(stoppedKeys).toHaveLength(1);

    // The row is derived from the task's persisted status, so a fresh read
    // shows it without any local memory of the tap.
    const reloaded = await loadThread(ORIGIN, TOKEN, TASK_ID, { fetchImpl });
    const reloadKeys = metaKeys(reloaded.turns).filter((key) => key.startsWith("stopped-"));
    expect(reloadKeys).toEqual(stoppedKeys);
    model.close();
  });

  it("KIN-MOBILE-001 R4: offline keeps the turns, blocks the send, and keeps the text", async () => {
    const fake = fakeStream();
    const prompts: string[] = [];
    const fetchImpl = routedFetch((url) => {
      if (url.endsWith("/prompt")) {
        prompts.push(String(url));
        return { body: task() };
      }
      return url.endsWith("/events") ? { body: RUNNING } : { body: task() };
    });
    const model = createThread({
      origin: ORIGIN,
      token: TOKEN,
      taskId: TASK_ID,
      fetchImpl,
      source: fake.source,
      schedule: immediate,
      backoff: { baseMs: 1, maxMs: 1, maxAttempts: 1 },
    });

    await model.start();
    await settle();
    const before = model.getState().turns;

    fake.failOpen();
    fake.connections[0].end();
    await settle();

    expect(model.getState().banner).toBe("offline");
    expect(model.getState().turns).toBe(before);
    expect(await model.send("keep me")).toEqual({ ok: false, reason: "offline" });
    expect(prompts).toEqual([]);
    expect(model.getState().sendQueue).toEqual([]);
    model.close();
  });

  it("KIN-MOBILE-001 R4: a chunk from a closed stream is dropped", async () => {
    const fake = fakeStream();
    const fetchImpl = routedFetch((url) =>
      url.endsWith("/events") ? { body: RUNNING } : { body: task() },
    );
    const model = createThread({
      origin: ORIGIN,
      token: TOKEN,
      taskId: TASK_ID,
      fetchImpl,
      source: fake.source,
      schedule: immediate,
    });

    await model.start();
    await settle();
    const before = model.getState().turns;

    model.close();
    fake.connections[0].push(frame(event(4, "message", { speaker: "kin", content: "late" })));
    await settle();

    expect(model.getState().turns).toBe(before);
  });

  it("KIN-MOBILE-001 R4: a late load answer does not repaint a newer one", async () => {
    type Pending = { url: string; resolve: (response: Response) => void };
    const pending: Pending[] = [];
    const fetchImpl = jest.fn(
      (url: string) =>
        new Promise<Response>((resolve) => {
          pending.push({ url, resolve });
        }),
    ) as unknown as typeof fetch;
    const model = createThread({
      origin: ORIGIN,
      token: TOKEN,
      taskId: TASK_ID,
      fetchImpl,
    });

    const first = model.load();
    const second = model.load();
    await settle();
    expect(pending).toHaveLength(4);

    const secondEvents = [
      event(1, "message", {
        speaker: "user",
        role: "user",
        content: "second answer",
        visibility: { user: true, task: true },
      }),
    ];
    pending[2].resolve(ok(task({ title: "newer" })));
    pending[3].resolve(ok(secondEvents));
    await settle();
    expect(JSON.stringify(model.getState().turns)).toContain("second");

    pending[0].resolve(ok(task({ title: "older" })));
    pending[1].resolve(
      ok([
        event(1, "message", {
          speaker: "user",
          role: "user",
          content: "first answer",
          visibility: { user: true, task: true },
        }),
      ]),
    );
    await settle();

    const rendered = JSON.stringify(model.getState().turns);
    expect(rendered).toContain("second");
    expect(rendered).not.toContain("first answer");
    await Promise.all([first, second]);
    model.close();
  });
});
