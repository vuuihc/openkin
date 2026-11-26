import { describe, expect, it, jest } from "@jest/globals";
import type { Task, TaskEvent } from "../../../ui/src/api/contract";
import {
  buildChatItems,
  groupIntoTurns,
  mergeProcessRuns,
  type Turn,
} from "../../../ui/src/components/chat/transcriptProjection";
import { createQueueMemory } from "./queueMemory";
import {
  createThread,
  loadThread,
  projectThread,
  type ThreadOptions,
  type ThreadState,
} from "./threadModel";
import type { StreamConnection, StreamSource } from "./stream";

/**
 * KIN-MOBILE-001 R4 — the headless conversation model.
 *
 * The history row compares against the shared projection itself, not a
 * hand-written expectation: R4's contract is that the phone groups the
 * transcript exactly as the web console does. The live round (streamed
 * appends, send queue, stop row) drives the same model through the stream
 * seam the R4a transport exposes.
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

// A transcript with the two things the shared projection reads differently on
// either side of the terminal status: an intermediate reasoning note and a
// tool call. Running, the note is body text and the tool is its own card;
// settled, both fold into one process card.
const HISTORY: TaskEvent[] = [
  event(1, "message", {
    speaker: "user",
    role: "user",
    content: "run the tests",
    visibility: { user: true, task: true },
  }),
  event(2, "task_started"),
  event(3, "message", {
    speaker: "kin",
    role: "reasoning",
    content: [{ type: "text", text: "checking the failing suite" }],
    partial: true,
    phase: "progress",
  }),
  event(4, "tool_use", {
    speaker: "kin",
    tool_use_id: "call-1",
    name: "bash",
    input: { command: "npm test" },
    visibility: { user: true, task: true },
  }),
  event(5, "tool_result", {
    speaker: "kin",
    tool_use_id: "call-1",
    name: "bash",
    output: "ok",
    ok: true,
    visibility: { user: true, task: true },
  }),
  event(6, "message", {
    speaker: "kin",
    content: "all green",
    visibility: { user: true, task: true },
  }),
  event(7, "result", { is_error: false }),
];

/** A round that is still open: what the queue and stop rows act on. */
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
  connections: Array<{ push(chunk: string): void; end(): void }>;
  failOpen(): void;
  allowOpen(): void;
};

function fakeStream(): FakeStream {
  const connections: Array<{ push(chunk: string): void; end(): void }> = [];
  let failing = false;
  return {
    connections,
    failOpen() {
      failing = true;
    },
    allowOpen() {
      failing = false;
    },
    source: {
      async open(): Promise<StreamConnection> {
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

/** The live-round model: the one task, the one fake stream, immediate retries. */
function liveThread(
  fetchImpl: typeof fetch,
  source: StreamSource,
  extra: Partial<ThreadOptions> = {},
) {
  return createThread({
    origin: ORIGIN,
    token: TOKEN,
    taskId: TASK_ID,
    fetchImpl,
    source,
    schedule: immediate,
    ...extra,
  });
}

/** The user bubbles' words, in transcript order. */
function userTexts(turns: readonly Turn[]): string[] {
  return turns.flatMap((turn) => (turn.kind === "user" ? [turn.item.text] : []));
}

/** The local copies of sends whose server message has not landed yet. */
function pendingTurns(turns: readonly Turn[]): Turn[] {
  return turns.filter((turn) => turn.kind === "user" && turn.item.key.startsWith("pending-"));
}

/** Meta keys anywhere in the turns (agent turns hold them in `items`). */
function metaKeys(turns: readonly Turn[]): string[] {
  const keys: string[] = [];
  for (const turn of turns) {
    const items = turn.kind === "agent" ? turn.items : [turn.item];
    for (const item of items) {
      if (item.kind === "meta") keys.push(item.key);
    }
  }
  return keys;
}

describe("KIN-MOBILE-001 R4 thread model", () => {
  it("KIN-MOBILE-001 R4: a running history is split exactly as the web transcript splits it", async () => {
    const fetchImpl = routedFetch((url) =>
      url.endsWith("/events") ? { body: HISTORY } : { body: task() },
    );

    const snapshot = await loadThread(ORIGIN, TOKEN, TASK_ID, { fetchImpl });
    const expected = groupIntoTurns(
      mergeProcessRuns(
        buildChatItems(HISTORY, "kin", "model-x", false, "running"),
        true,
      ),
      "kin",
      "model-x",
    );

    expect(snapshot.status).toBe("ready");
    expect(snapshot.turns).toEqual(expected);
    expect(snapshot.running).toBe(true);

    // The live split, not one collapsed card: the reasoning note is body text
    // and the tool keeps its own card. Without `mergeProcessRuns(..., true)`
    // the note folds into the tool card and this shape fails.
    const agent = snapshot.turns[1];
    if (agent?.kind !== "agent") throw new Error("expected an agent turn");
    const progress = agent.items.filter((item) => item.kind === "progress");
    expect(progress).toHaveLength(2);
    expect(progress[0]).toMatchObject({
      prose: true,
      steps: [{ kind: "note", text: "checking the failing suite" }],
    });
    expect(progress[1]).toMatchObject({
      steps: [{ kind: "tool", name: "bash", status: "done" }],
    });
  });

  it("KIN-MOBILE-001 R4: a settled history collapses exactly as the web transcript collapses it", async () => {
    const fetchImpl = routedFetch((url) =>
      url.endsWith("/events")
        ? { body: HISTORY }
        : { body: task({ status: "succeeded" }) },
    );

    const snapshot = await loadThread(ORIGIN, TOKEN, TASK_ID, { fetchImpl });
    const expected = groupIntoTurns(
      mergeProcessRuns(
        buildChatItems(HISTORY, "kin", "model-x", true, "succeeded"),
        false,
      ),
      "kin",
      "model-x",
    );

    expect(snapshot.status).toBe("ready");
    expect(snapshot.turns).toEqual(expected);
    expect(snapshot.running).toBe(false);

    const agent = snapshot.turns[1];
    if (agent?.kind !== "agent") throw new Error("expected an agent turn");
    const progress = agent.items.filter((item) => item.kind === "progress");
    expect(progress).toHaveLength(1);
    expect(progress[0]).toMatchObject({
      steps: [
        { kind: "note", text: "checking the failing suite" },
        { kind: "tool", name: "bash", status: "done" },
      ],
    });
  });

  it("KIN-MOBILE-001 §3: the read carries the task's title into the view state", async () => {
    const fetchImpl = routedFetch((url) =>
      url.endsWith("/events")
        ? { body: HISTORY }
        : { body: task({ title: "Release notes", status: "succeeded" }) },
    );
    const model = liveThread(fetchImpl, fakeStream().source);

    await model.load();

    expect(model.getState().status).toBe("ready");
    expect(model.getState().title).toBe("Release notes");
  });

  it("KIN-MOBILE-001 §3: a task with no title carries the empty string, not the id", async () => {
    const fetchImpl = routedFetch((url) =>
      url.endsWith("/events")
        ? { body: HISTORY }
        : { body: task({ title: "", status: "succeeded" }) },
    );
    const model = liveThread(fetchImpl, fakeStream().source);

    await model.load();

    expect(model.getState().title).toBe("");
    expect(model.getState().title).not.toBe(TASK_ID);
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
    await second;
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
    await first;

    const rendered = JSON.stringify(model.getState().turns);
    expect(rendered).toContain("second");
    expect(rendered).not.toContain("first answer");
    model.close();
  });

  it("KIN-MOBILE-001 R4: an unchanged turn keeps the previous object", () => {
    const first = projectThread(HISTORY, task());
    const again = projectThread(HISTORY, task(), first);
    expect(again).toHaveLength(first.length);
    again.forEach((turn, index) => {
      expect(turn).toBe(first[index]);
    });

    // A late event changes the agent turn and only that turn: the user turn
    // above it is reused, so a memoized row can skip the repaint.
    const changed = projectThread(
      [
        ...HISTORY,
        event(8, "message", {
          speaker: "kin",
          content: "one more thing",
          visibility: { user: true, task: true },
        }),
      ],
      task(),
      first,
    );
    expect(changed[0]).toBe(first[0]);
    expect(changed[1]).not.toBe(first[1]);
  });

  it("KIN-MOBILE-001 R4: a failed read is one error state with the transport's reason", async () => {
    const cases = [
      { status: 401, reason: "expired", banner: null },
      { status: 404, reason: "rejected", banner: null },
      { status: 500, reason: "unreachable", banner: "offline" },
    ] as const;
    for (const expected of cases) {
      const snapshot = await loadThread(ORIGIN, TOKEN, TASK_ID, {
        fetchImpl: routedFetch(() => ({ status: expected.status, body: {} })),
      });
      expect(snapshot).toMatchObject({
        taskId: TASK_ID,
        status: "error",
        turns: [],
        running: false,
        banner: expected.banner,
        reason: expected.reason,
        task: null,
        events: [],
      });
    }

    const network = await loadThread(ORIGIN, TOKEN, TASK_ID, {
      fetchImpl: (() =>
        Promise.reject(new TypeError("network down"))) as unknown as typeof fetch,
    });
    expect(network).toMatchObject({
      status: "error",
      banner: "offline",
      reason: "unreachable",
      turns: [],
      task: null,
      events: [],
    });
  });

  it("KIN-MOBILE-001 R4: an offline refresh keeps the turns already read", async () => {
    let call = 0;
    const fetchImpl = routedFetch((url) => {
      call += 1;
      if (call > 2) return { status: 500, body: {} };
      return url.endsWith("/events") ? { body: HISTORY } : { body: task() };
    });
    const model = createThread({
      origin: ORIGIN,
      token: TOKEN,
      taskId: TASK_ID,
      fetchImpl,
    });

    const read = await model.load();
    expect(read.status).toBe("ready");
    const priorTurns = read.turns;
    expect(priorTurns.length).toBeGreaterThan(0);

    const refresh = await model.load();
    expect(refresh.status).toBe("error");
    expect(refresh.reason).toBe("unreachable");
    expect(refresh.banner).toBe("offline");
    expect(refresh.turns).toBe(priorTurns);
    model.close();
  });

  it("KIN-MOBILE-001 R4: close drops a read still in flight", async () => {
    const gate = deferred<void>();
    const fetchImpl = jest.fn(async (url: string) => {
      await gate.promise;
      return url.endsWith("/events") ? ok([]) : ok(task());
    }) as unknown as typeof fetch;
    const model = createThread({
      origin: ORIGIN,
      token: TOKEN,
      taskId: TASK_ID,
      fetchImpl,
    });
    const seen: ThreadState[] = [];
    model.subscribe((state) => seen.push(state));

    const inFlight = model.load();
    expect(model.getState().status).toBe("loading");
    model.close();
    const atClose = seen.length;

    gate.resolve();
    await inFlight;

    expect(seen).toHaveLength(atClose);
    expect(model.getState().status).toBe("loading");
    expect(model.getState().turns).toEqual([]);
  });

  it("KIN-MOBILE-001 R4: a streamed chunk appends without redrawing earlier turns", async () => {
    const fake = fakeStream();
    const fetchImpl = routedFetch((url) =>
      url.endsWith("/events") ? { body: RUNNING } : { body: task() },
    );
    const model = liveThread(fetchImpl, fake.source);

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
    const model = liveThread(fetchImpl, fake.source);

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

  it("KIN-MOBILE-001 R4: send while running queues, then flushes one item per round in order", async () => {
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
    const model = liveThread(fetchImpl, fake.source);

    await model.start();
    await settle();
    expect(model.getState().running).toBe(true);

    expect(await model.send("first")).toEqual({ ok: true, queued: true });
    expect(await model.send("second")).toEqual({ ok: true, queued: true });
    expect(await model.send("third")).toEqual({ ok: true, queued: true });
    expect(prompts).toEqual([]);
    expect(model.getState().sendQueue.map((item) => item.text)).toEqual([
      "first",
      "second",
      "third",
    ]);

    // A queued item is cancellable while the round runs.
    const queued = model.getState().sendQueue[2];
    model.cancelQueued(queued.id);
    expect(model.getState().sendQueue.map((item) => item.text)).toEqual(["first", "second"]);

    // One round ends: exactly one queued prompt opens the next round; the
    // rest wait for that new round's own `result`.
    fake.connections[0].push(frame(event(4, "result", { is_error: false })));
    await settle();
    expect(prompts).toEqual(["first"]);
    expect(model.getState().sendQueue.map((item) => item.text)).toEqual(["second"]);
    expect(model.getState().running).toBe(true);

    fake.connections[0].push(frame(event(5, "result", { is_error: false })));
    await settle();
    expect(prompts).toEqual(["first", "second"]);
    expect(model.getState().sendQueue).toEqual([]);
    model.close();
  });

  it("KIN-MOBILE-001 R4: a send during a flush joins the queue instead of racing it", async () => {
    const fake = fakeStream();
    const prompts: string[] = [];
    const firstPrompt = deferred<Reply>();
    const fetchImpl = routedFetch((url, init) => {
      if (url.endsWith("/prompt")) {
        const body = JSON.parse(String(init?.body)) as { prompt: string };
        prompts.push(body.prompt);
        return prompts.length === 1 ? firstPrompt.promise : { body: task() };
      }
      return url.endsWith("/events") ? { body: RUNNING } : { body: task() };
    });
    const model = liveThread(fetchImpl, fake.source);

    await model.start();
    await settle();
    expect(await model.send("first")).toEqual({ ok: true, queued: true });

    // The round's result starts the flush; its POST is still in flight when
    // the person sends again, which must land behind the item being sent.
    fake.connections[0].push(frame(event(4, "result", { is_error: false })));
    await settle();
    expect(prompts).toEqual(["first"]);
    expect(await model.send("second")).toEqual({ ok: true, queued: true });
    // The item being posted stays visible (and cancellable) until its POST
    // answers; the new send lands behind it.
    expect(model.getState().sendQueue.map((item) => item.text)).toEqual(["first", "second"]);

    firstPrompt.resolve({ body: task() });
    await settle();
    expect(prompts).toEqual(["first"]);
    expect(model.getState().sendQueue.map((item) => item.text)).toEqual(["second"]);
    expect(model.getState().running).toBe(true);

    fake.connections[0].push(frame(event(5, "result", { is_error: false })));
    await settle();
    expect(prompts).toEqual(["first", "second"]);
    expect(model.getState().sendQueue).toEqual([]);
    model.close();
  });

  it("KIN-MOBILE-001 R4: a failed flush keeps the item queued and the next result retries it", async () => {
    const fake = fakeStream();
    const prompts: string[] = [];
    let promptCalls = 0;
    const fetchImpl = routedFetch((url, init) => {
      if (url.endsWith("/prompt")) {
        const body = JSON.parse(String(init?.body)) as { prompt: string };
        prompts.push(body.prompt);
        promptCalls += 1;
        return promptCalls === 1 ? { status: 404, body: {} } : { body: task() };
      }
      return url.endsWith("/events") ? { body: RUNNING } : { body: task() };
    });
    const model = liveThread(fetchImpl, fake.source);

    await model.start();
    await settle();
    expect(await model.send("keep")).toEqual({ ok: true, queued: true });

    // A rejected prompt is the person's text, not a lost send: it stays in
    // the queue (cancellable) and the round is not retried in a tight loop.
    fake.connections[0].push(frame(event(4, "result", { is_error: false })));
    await settle();
    expect(prompts).toEqual(["keep"]);
    expect(model.getState().sendQueue.map((item) => item.text)).toEqual(["keep"]);
    expect(model.getState().banner).toBeNull();

    // A new send behind a retained item keeps the queue's order instead of
    // posting past it.
    expect(await model.send("later")).toEqual({ ok: true, queued: true });
    expect(model.getState().sendQueue.map((item) => item.text)).toEqual(["keep", "later"]);
    const later = model.getState().sendQueue[1];
    model.cancelQueued(later.id);

    // The next round's end retries the retained item.
    fake.connections[0].push(frame(event(5, "result", { is_error: false })));
    await settle();
    expect(prompts).toEqual(["keep", "keep"]);
    expect(model.getState().sendQueue).toEqual([]);
    model.close();
  });

  it("KIN-MOBILE-001 §5 离开再回来: a queued message is still queued when the conversation is closed and reopened", async () => {
    const memory = createQueueMemory();
    const prompts: string[] = [];
    const fetchImpl = routedFetch((url, init) => {
      if (url.endsWith("/prompt")) {
        const body = JSON.parse(String(init?.body)) as { prompt: string };
        prompts.push(body.prompt);
        return { body: task() };
      }
      return url.endsWith("/events") ? { body: RUNNING } : { body: task() };
    });

    const firstFake = fakeStream();
    const first = liveThread(fetchImpl, firstFake.source, { queueMemory: memory });
    await first.start();
    await settle();
    expect(await first.send("first")).toEqual({ ok: true, queued: true });
    expect(await first.send("second")).toEqual({ ok: true, queued: true });
    const second = first.getState().sendQueue[1];
    first.cancelQueued(second.id);
    expect(first.getState().sendQueue.map((item) => item.text)).toEqual(["first"]);
    expect(memory.read(TASK_ID).map((item) => item.text)).toEqual(["first"]);

    // Back to the list: the whole route and its model go away.
    first.close();

    // The same conversation opened again lands on the same queue, with the
    // row still addressed by the id the withdraw control knows.
    const reopenedFake = fakeStream();
    const reopened = liveThread(fetchImpl, reopenedFake.source, { queueMemory: memory });
    await reopened.start();
    await settle();
    expect(reopened.getState().sendQueue.map((item) => item.text)).toEqual(["first"]);
    expect(reopened.getState().sendQueue[0]?.id).toBe(first.getState().sendQueue[0]?.id);
    // The round that was running is still running: reopening reads it, and
    // must not post the queued words a second time.
    expect(reopened.getState().running).toBe(true);
    expect(prompts).toEqual([]);

    // The reopened round ends: now the restored item is sent, exactly once.
    reopenedFake.connections[0].push(frame(event(4, "result", { is_error: false })));
    await settle();
    expect(prompts).toEqual(["first"]);
    expect(reopened.getState().sendQueue).toEqual([]);
    reopened.close();
  });

  it("KIN-MOBILE-001 §5 离开再回来: a restored queue on an idle conversation sends its first item once", async () => {
    const memory = createQueueMemory();
    memory.write(TASK_ID, [
      { id: "q1", text: "first" },
      { id: "q2", text: "second" },
    ]);
    const fake = fakeStream();
    const prompts: string[] = [];
    const fetchImpl = routedFetch((url, init) => {
      if (url.endsWith("/prompt")) {
        const body = JSON.parse(String(init?.body)) as { prompt: string };
        prompts.push(body.prompt);
        return { body: task() };
      }
      // The conversation was left after its round finished; nothing is running
      // to carry the queue, so the reopen itself is what has to send it.
      return url.endsWith("/events")
        ? { body: HISTORY }
        : { body: task({ status: "succeeded" }) };
    });
    const model = liveThread(fetchImpl, fake.source, { queueMemory: memory });

    await model.start();
    await settle();
    // One prompt opens one round; the rest waits for that round's `result`.
    expect(prompts).toEqual(["first"]);
    expect(model.getState().sendQueue.map((item) => item.text)).toEqual(["second"]);
    expect(memory.read(TASK_ID).map((item) => item.text)).toEqual(["second"]);

    fake.connections[0].push(frame(event(8, "result", { is_error: false })));
    await settle();
    expect(prompts).toEqual(["first", "second"]);
    expect(model.getState().sendQueue).toEqual([]);
    expect(memory.read(TASK_ID)).toEqual([]);
    model.close();
  });

  it("KIN-MOBILE-001 R4: a streamed result settles the task row the projection folds on", async () => {
    const openRound = HISTORY.slice(0, 6); // the same transcript, no `result` yet
    for (const expected of [
      { isError: false, status: "succeeded" as const },
      { isError: true, status: "failed" as const },
    ]) {
      const fake = fakeStream();
      const fetchImpl = routedFetch((url) =>
        url.endsWith("/events") ? { body: openRound } : { body: task() },
      );
      const model = liveThread(fetchImpl, fake.source);

      await model.start();
      await settle();

      const tail = event(7, "result", { is_error: expected.isError });
      fake.connections[0].push(frame(tail));
      await settle();

      expect(model.getState().running).toBe(false);
      // Without updating the task row first, the projection still sees a
      // running task and keeps the two process cards of the live split.
      expect(model.getState().turns).toEqual(
        projectThread([...openRound, tail], task({ status: expected.status })),
      );
      model.close();
    }
  });

  it("KIN-MOBILE-001 R4: a reconnect fills an empty epoch-0 history from the durable log", async () => {
    const fake = fakeStream();
    let eventReads = 0;
    const fetchImpl = routedFetch((url) => {
      if (url.endsWith("/events")) {
        eventReads += 1;
        return {
          body:
            eventReads === 1
              ? []
              : [
                  event(1, "message", {
                    speaker: "kin",
                    content: "recovered",
                    visibility: { user: true, task: true },
                  }),
                ],
        };
      }
      return { body: task() };
    });
    const model = liveThread(fetchImpl, fake.source);

    await model.start();
    await settle();
    expect(model.getState().turns).toEqual([]);

    // The first connection carried nothing and dropped. The retry's durable
    // catch-up is the only source of the missed event, and it is epoch 0:
    // an epoch seeded at -1 from the empty list would filter it out.
    fake.connections[0].end();
    await settle();

    expect(eventReads).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(model.getState().turns)).toContain("recovered");
    model.close();
  });

  it("KIN-MOBILE-001 R4: a skipped seq is filled from the durable log", async () => {
    const fake = fakeStream();
    const fetchImpl = routedFetch((url) => {
      if (url.includes("since_seq=3")) {
        return {
          body: [
            event(4, "message", {
              speaker: "kin",
              content: "four",
              visibility: { user: true, task: true },
            }),
          ],
        };
      }
      return url.endsWith("/events") ? { body: RUNNING } : { body: task() };
    });
    const model = liveThread(fetchImpl, fake.source);

    await model.start();
    await settle();

    fake.connections[0].push(
      frame(
        event(5, "message", {
          speaker: "kin",
          content: "five",
          visibility: { user: true, task: true },
        }),
      ),
    );
    await settle();

    const rendered = JSON.stringify(model.getState().turns);
    expect(rendered).toContain("four");
    expect(rendered).toContain("five");
    model.close();
  });

  it("KIN-MOBILE-001 R4: an epoch bump rewrites the tail and drops a repair for the old epoch", async () => {
    const fake = fakeStream();
    const catchUps: Array<{ url: string; reply: (body: TaskEvent[]) => void }> = [];
    const fetchImpl = jest.fn((input: string) => {
      const url = String(input);
      if (url.includes("since_seq=")) {
        return new Promise<Response>((resolve) => {
          catchUps.push({ url, reply: (body) => resolve(ok(body)) });
        });
      }
      return Promise.resolve(url.endsWith("/events") ? ok(RUNNING) : ok(task()));
    }) as unknown as typeof fetch;
    const model = liveThread(fetchImpl, fake.source);

    await model.start();
    await settle();

    // A hole starts a durable repair for epoch 0 and leaves it in flight.
    fake.connections[0].push(frame(event(6, "message", { speaker: "kin", content: "six" })));
    await settle();
    expect(catchUps).toHaveLength(1);

    // The daemon rewrote the tail: the transcript restarts at epoch 1.
    fake.connections[0].push(
      frame({
        ...event(1, "message", {
          speaker: "kin",
          content: "rewritten",
          visibility: { user: true, task: true },
        }),
        event_epoch: 1,
      }),
    );
    await settle();
    const rewritten = JSON.stringify(model.getState().turns);
    expect(rewritten).toContain("rewritten");
    expect(rewritten).not.toContain("do it");

    // A hole in the new epoch must start its own repair: the old-epoch one is
    // no longer the answer this model is waiting for.
    fake.connections[0].push(
      frame({ ...event(4, "message", { speaker: "kin", content: "four" }), event_epoch: 1 }),
    );
    await settle();
    expect(catchUps).toHaveLength(2);
    expect(catchUps[1].url).toContain("since_seq=1");

    // The old-epoch repair answering late cannot repaint the new tail, and it
    // must not clear the newer repair still in flight: another hole in the new
    // epoch has to reuse that repair, not open a third fetch.
    catchUps[0].reply([event(5, "message", { speaker: "kin", content: "stale" })]);
    await settle();
    fake.connections[0].push(
      frame({ ...event(6, "message", { speaker: "kin", content: "six" }), event_epoch: 1 }),
    );
    await settle();
    expect(catchUps).toHaveLength(2);

    // A late epoch-0 event from the stream is a downgrade and is dropped.
    fake.connections[0].push(frame(event(8, "message", { speaker: "kin", content: "downgrade" })));
    await settle();
    const after = JSON.stringify(model.getState().turns);
    expect(after).not.toContain("stale");
    expect(after).not.toContain("downgrade");
    expect(after).toContain("rewritten");
    model.close();
  });

  it("KIN-MOBILE-001 R4: a reconcile that recovers a result ends the round and flushes the queue", async () => {
    const fake = fakeStream();
    const prompts: string[] = [];
    const fetchImpl = routedFetch((url, init) => {
      if (url.endsWith("/prompt")) {
        const body = JSON.parse(String(init?.body)) as { prompt: string };
        prompts.push(body.prompt);
        return { body: task() };
      }
      if (url.includes("since_seq=")) {
        return { body: [event(4, "result", { is_error: false })] };
      }
      return url.endsWith("/events") ? { body: RUNNING } : { body: task() };
    });
    const model = liveThread(fetchImpl, fake.source);

    await model.start();
    await settle();
    expect(await model.send("after")).toEqual({ ok: true, queued: true });

    // The stream drops, so the round's `result` arrives only through the
    // reconnect's durable catch-up; the model must still end the round and
    // send the queued prompt.
    fake.connections[0].end();
    await settle();

    expect(prompts).toEqual(["after"]);
    expect(model.getState().sendQueue).toEqual([]);
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
    const model = liveThread(fetchImpl, fake.source);

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
      // The reconnect's durable catch-up carries `?since_seq=`, so match the
      // path rather than the suffix: both answers are the same event list.
      return url.includes("/events") ? { body: RUNNING } : { body: task() };
    });
    const model = liveThread(fetchImpl, fake.source, {
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

  it("KIN-MOBILE-001 R4: a retried start reopens the stream after it went offline", async () => {
    const fake = fakeStream();
    const fetchImpl = routedFetch((url) =>
      url.includes("/events") ? { body: RUNNING } : { body: task() },
    );
    const model = liveThread(fetchImpl, fake.source, {
      backoff: { baseMs: 1, maxMs: 1, maxAttempts: 1 },
    });

    await model.start();
    await settle();
    expect(fake.connections).toHaveLength(1);

    // The stream gives up for good: the model says offline and keeps the turns.
    fake.failOpen();
    fake.connections[0].end();
    await settle();
    expect(model.getState().banner).toBe("offline");

    // A retried start is a fresh subscription: the dead stream is replaced, a
    // second connection opens and the banner clears. Without the replacement,
    // `startStream` returns early and the model reports ready with no stream.
    fake.allowOpen();
    await model.start();
    await settle();
    expect(fake.connections).toHaveLength(2);
    expect(model.getState().banner).toBeNull();

    fake.connections[1].push(
      frame(
        event(4, "message", {
          speaker: "kin",
          content: "live again",
          visibility: { user: true, task: true },
        }),
      ),
    );
    await settle();
    expect(JSON.stringify(model.getState().turns)).toContain("live again");
    model.close();
  });

  it("KIN-MOBILE-001 R4: a chunk from a closed stream is dropped", async () => {
    const fake = fakeStream();
    const fetchImpl = routedFetch((url) =>
      url.endsWith("/events") ? { body: RUNNING } : { body: task() },
    );
    const model = liveThread(fetchImpl, fake.source);

    await model.start();
    await settle();
    const before = model.getState().turns;

    model.close();
    fake.connections[0].push(frame(event(4, "message", { speaker: "kin", content: "late" })));
    await settle();

    expect(model.getState().turns).toBe(before);
  });

  it("KIN-MOBILE-001 §5 立刻看到: the sent words are drawn while the prompt request is still unanswered", async () => {
    const answer = deferred<Reply>();
    const fetchImpl = routedFetch((url) => {
      if (url.endsWith("/prompt")) return answer.promise;
      return url.endsWith("/events") ? { body: HISTORY } : { body: task({ status: "succeeded" }) };
    });
    const model = liveThread(fetchImpl, fakeStream().source);
    await model.load();

    // The composer already cleared at tap; until the POST answers, this local
    // copy is the only thing the transcript can draw.
    const sending = model.send("ship it");

    const turns = model.getState().turns;
    const last = turns[turns.length - 1];
    expect(last).toMatchObject({
      kind: "user",
      item: { speaker: "user", text: "ship it", partial: false },
    });
    expect(userTexts(turns)).toEqual(["run the tests", "ship it"]);

    answer.resolve({ body: task() });
    await sending;
    model.close();
  });

  it("KIN-MOBILE-001 §5 立刻看到: the server's own message settles the local copy and the words are drawn once", async () => {
    const fake = fakeStream();
    const fetchImpl = routedFetch((url) => {
      if (url.endsWith("/prompt")) return { body: task() };
      return url.endsWith("/events") ? { body: HISTORY } : { body: task({ status: "succeeded" }) };
    });
    const model = liveThread(fetchImpl, fake.source);

    await model.start();
    await settle();
    await model.send("ship it");
    expect(pendingTurns(model.getState().turns)).toHaveLength(1);

    // The daemon writes the visible user event at accept time; when it lands,
    // the local copy hands over: one bubble, the server's.
    const landed = event(8, "message", {
      speaker: "user",
      role: "user",
      content: "ship it",
      visibility: { user: true, task: true },
    });
    fake.connections[0].push(frame(landed));
    await settle();
    expect(pendingTurns(model.getState().turns)).toEqual([]);
    expect(userTexts(model.getState().turns)).toEqual(["run the tests", "ship it"]);

    // A replayed event cannot settle a second time (there is nothing left to
    // settle) nor duplicate the bubble.
    fake.connections[0].push(frame(landed));
    await settle();
    expect(userTexts(model.getState().turns)).toEqual(["run the tests", "ship it"]);
    model.close();
  });

  it("KIN-MOBILE-001 §5 失败: a refused prompt drops the local copy so the restored draft is the only copy", async () => {
    const fetchImpl = routedFetch((url) => {
      if (url.endsWith("/prompt")) return { status: 500, body: {} };
      return url.endsWith("/events") ? { body: HISTORY } : { body: task({ status: "succeeded" }) };
    });
    const model = liveThread(fetchImpl, fakeStream().source);
    await model.load();
    const before = model.getState().turns;

    // The screen puts the words back in the composer on failure; a lingering
    // bubble would show them twice.
    expect(await model.send("ship it")).toEqual({ ok: false, reason: "unreachable" });
    expect(pendingTurns(model.getState().turns)).toEqual([]);
    expect(model.getState().turns).toEqual(before);
    model.close();
  });

  it("KIN-MOBILE-001 §5: an older message with the same words cannot settle a later send", async () => {
    const fake = fakeStream();
    const sameWords: TaskEvent[] = [
      event(1, "message", {
        speaker: "user",
        role: "user",
        content: "ok",
        visibility: { user: true, task: true },
      }),
      event(2, "result", { is_error: false }),
    ];
    const fetchImpl = routedFetch((url) => {
      if (url.endsWith("/prompt")) return { body: task() };
      return url.endsWith("/events") ? { body: sameWords } : { body: task({ status: "succeeded" }) };
    });
    const model = liveThread(fetchImpl, fake.source);

    await model.start();
    await settle();
    await model.send("ok");
    expect(userTexts(model.getState().turns)).toEqual(["ok", "ok"]);
    expect(pendingTurns(model.getState().turns)).toHaveLength(1);

    // History already holds "ok"; an event after the send but about something
    // else must not let that older copy settle the new bubble.
    fake.connections[0].push(
      frame(
        event(3, "message", {
          speaker: "kin",
          content: "working",
          visibility: { user: true, task: true },
        }),
      ),
    );
    await settle();
    expect(pendingTurns(model.getState().turns)).toHaveLength(1);

    // The send's own copy carries a seq after the send began: now it settles.
    fake.connections[0].push(
      frame(
        event(4, "message", {
          speaker: "user",
          role: "user",
          content: "ok",
          visibility: { user: true, task: true },
        }),
      ),
    );
    await settle();
    expect(pendingTurns(model.getState().turns)).toEqual([]);
    expect(userTexts(model.getState().turns)).toEqual(["ok", "ok"]);
    model.close();
  });

  it("KIN-MOBILE-001 §5: an epoch bump drops a local copy from the rewritten timeline", async () => {
    const fake = fakeStream();
    const answer = deferred<Reply>();
    const fetchImpl = routedFetch((url) => {
      if (url.endsWith("/prompt")) return answer.promise;
      return url.endsWith("/events") ? { body: HISTORY } : { body: task({ status: "succeeded" }) };
    });
    const model = liveThread(fetchImpl, fake.source);

    await model.start();
    await settle();
    const sending = model.send("ship it");
    expect(pendingTurns(model.getState().turns)).toHaveLength(1);

    // A retry rewrites the tail at a new epoch; the old seqs no longer mean
    // what they did, so a copy whose send began in the old timeline could
    // never be settled by anything in the new one.
    fake.connections[0].push(
      frame({
        ...event(1, "message", {
          speaker: "kin",
          content: "rewritten",
          visibility: { user: true, task: true },
        }),
        event_epoch: 1,
      }),
    );
    await settle();
    expect(pendingTurns(model.getState().turns)).toEqual([]);

    answer.resolve({ body: task() });
    await sending;
    expect(pendingTurns(model.getState().turns)).toEqual([]);
    model.close();
  });

  it("KIN-MOBILE-001 §5: a reload that finds a new epoch drops the local copy too", async () => {
    const answer = deferred<Reply>();
    let rewritten = false;
    const fetchImpl = routedFetch((url) => {
      if (url.endsWith("/prompt")) return answer.promise;
      if (url.endsWith("/events")) {
        return {
          body: rewritten
            ? [
                {
                  ...event(1, "message", {
                    speaker: "kin",
                    content: "rewritten",
                    visibility: { user: true, task: true },
                  }),
                  event_epoch: 1,
                },
              ]
            : HISTORY,
        };
      }
      return { body: task({ status: "succeeded", event_epoch: rewritten ? 1 : 0 }) };
    });
    const model = liveThread(fetchImpl, fakeStream().source);

    await model.load();
    const sending = model.send("ship it");
    expect(pendingTurns(model.getState().turns)).toHaveLength(1);

    // The read finds the rewritten timeline: the copy from the old one goes
    // with it, rather than sitting at the end of the new transcript forever.
    rewritten = true;
    await model.load();
    expect(pendingTurns(model.getState().turns)).toEqual([]);

    answer.resolve({ body: task() });
    await sending;
    model.close();
  });

  it("KIN-MOBILE-001 §5: a send during the first read stays drawn when that read lands", async () => {
    const firstTask = deferred<Reply>();
    const firstEvents = deferred<Reply>();
    let reads = 0;
    const fetchImpl = routedFetch((url) => {
      if (url.endsWith("/prompt")) return { body: task({ status: "succeeded" }) };
      reads += 1;
      // The first load's two GETs stay open until after the send.
      if (reads <= 2) {
        return url.endsWith("/events") ? firstEvents.promise : firstTask.promise;
      }
      return url.endsWith("/events") ? { body: HISTORY } : { body: task({ status: "succeeded" }) };
    });
    const model = liveThread(fetchImpl, fakeStream().source);

    // The composer is live while the shell's first read is in flight (signed
    // §3), and that read was served before the daemon accepted the prompt, so
    // the history it brings cannot carry the echo.
    const loading = model.load();
    await model.send("ship it");
    expect(pendingTurns(model.getState().turns)).toHaveLength(1);

    firstTask.resolve({ body: task({ status: "succeeded" }) });
    firstEvents.resolve({ body: HISTORY });
    await loading;

    // The first timeline lands under the copy, not over it: `startSeq 0` means
    // the copy's own echo can still settle it once the stream delivers it.
    expect(pendingTurns(model.getState().turns)).toHaveLength(1);
    expect(userTexts(model.getState().turns)).toEqual(["run the tests", "ship it"]);
    model.close();
  });

  it("KIN-MOBILE-001 §5: a flush whose echo lands before the POST answers still draws the words once", async () => {
    const fake = fakeStream();
    const answer = deferred<Reply>();
    const fetchImpl = routedFetch((url) => {
      if (url.endsWith("/prompt")) return answer.promise;
      return url.endsWith("/events") ? { body: RUNNING } : { body: task() };
    });
    const model = liveThread(fetchImpl, fake.source);

    await model.start();
    await settle();
    await model.send("flushed");

    fake.connections[0].push(frame(event(4, "result", { is_error: false })));
    await settle();
    // The daemon writes the visible user event at accept time, so the echo can
    // reach the stream while the flush's POST is still unanswered.
    fake.connections[0].push(
      frame(
        event(5, "message", {
          speaker: "user",
          role: "user",
          content: "flushed",
          visibility: { user: true, task: true },
        }),
      ),
    );
    await settle();
    expect(userTexts(model.getState().turns)).toEqual(["do it", "flushed"]);

    answer.resolve({ body: task() });
    await settle();

    expect(model.getState().sendQueue).toEqual([]);
    expect(pendingTurns(model.getState().turns)).toEqual([]);
    expect(userTexts(model.getState().turns)).toEqual(["do it", "flushed"]);
    model.close();
  });

  it("KIN-MOBILE-001 §5 离开再回来: closing the conversation drops the local copy", async () => {
    const answer = deferred<Reply>();
    const fetchImpl = routedFetch((url) => {
      if (url.endsWith("/prompt")) return answer.promise;
      return url.endsWith("/events") ? { body: HISTORY } : { body: task({ status: "succeeded" }) };
    });
    const model = liveThread(fetchImpl, fakeStream().source);
    await model.load();

    const sending = model.send("ship it");
    expect(pendingTurns(model.getState().turns)).toHaveLength(1);

    // Closing owns nothing: the bubble goes with the screen, and the late POST
    // answer cannot put it back (AGENTS.md §11).
    model.close();
    expect(pendingTurns(model.getState().turns)).toEqual([]);

    // A reopened conversation reads the durable log and draws no local copy.
    const reopened = liveThread(fetchImpl, fakeStream().source);
    await reopened.load();
    expect(userTexts(reopened.getState().turns)).toEqual(["run the tests"]);

    answer.resolve({ body: task() });
    await sending;
    expect(pendingTurns(model.getState().turns)).toEqual([]);
    reopened.close();
  });

  it("KIN-MOBILE-001 §5: a queued send draws only its queue row, not a transcript bubble", async () => {
    const fake = fakeStream();
    const fetchImpl = routedFetch((url) =>
      url.endsWith("/events") ? { body: RUNNING } : { body: task() },
    );
    const model = liveThread(fetchImpl, fake.source);

    await model.start();
    await settle();
    expect(await model.send("later")).toEqual({ ok: true, queued: true });

    expect(model.getState().sendQueue.map((item) => item.text)).toEqual(["later"]);
    expect(pendingTurns(model.getState().turns)).toEqual([]);
    expect(userTexts(model.getState().turns)).toEqual(["do it"]);
    model.close();
  });

  it("KIN-MOBILE-001 §5: a flushed queue item hands its words to the transcript in the same update that removes its queue row", async () => {
    const fake = fakeStream();
    const fetchImpl = routedFetch((url) => {
      if (url.endsWith("/prompt")) return { body: task() };
      return url.endsWith("/events") ? { body: RUNNING } : { body: task() };
    });
    const model = liveThread(fetchImpl, fake.source);

    await model.start();
    await settle();
    await model.send("flushed");
    expect(pendingTurns(model.getState().turns)).toEqual([]);

    // The round ends and the flush POST succeeds: the queue row it stood in
    // for goes away and the transcript takes the words in that same update.
    fake.connections[0].push(frame(event(4, "result", { is_error: false })));
    await settle();

    expect(model.getState().sendQueue).toEqual([]);
    expect(pendingTurns(model.getState().turns)).toHaveLength(1);
    expect(userTexts(model.getState().turns)).toEqual(["do it", "flushed"]);

    // The server's copy lands and settles the local one: still drawn once.
    fake.connections[0].push(
      frame(
        event(5, "message", {
          speaker: "user",
          role: "user",
          content: "flushed",
          visibility: { user: true, task: true },
        }),
      ),
    );
    await settle();
    expect(pendingTurns(model.getState().turns)).toEqual([]);
    expect(userTexts(model.getState().turns)).toEqual(["do it", "flushed"]);
    model.close();
  });
});
