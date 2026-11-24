import { describe, expect, it, jest } from "@jest/globals";
import type { Task, TaskEvent } from "../../../ui/src/api/contract";
import {
  buildChatItems,
  groupIntoTurns,
  mergeProcessRuns,
} from "../../../ui/src/components/chat/transcriptProjection";
import {
  createThread,
  loadThread,
  projectThread,
  type ThreadState,
} from "./threadModel";

/**
 * KIN-MOBILE-001 R4 — the headless conversation read model.
 *
 * The history row compares against the shared projection itself, not a
 * hand-written expectation: R4's contract is that the phone groups the
 * transcript exactly as the web console does. The live round (streamed
 * appends, send queue, stop row) lands in the next slice with its own suite.
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
});
