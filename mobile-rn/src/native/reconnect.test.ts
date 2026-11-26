import { describe, expect, it, jest } from "@jest/globals";
import {
  act,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react-native";
import { createElement } from "react";
import type { Task, TaskEvent } from "../../../ui/src/api/contract";
import { t } from "../i18n";
import ConversationScreen from "../screens/ConversationScreen";
import ConversationView from "../screens/ConversationView";
import { createThread, type ThreadState } from "../thread/threadModel";
import type {
  StreamConnection,
  StreamRequest,
  StreamSource,
} from "../thread/stream";
import {
  canRetry,
  shouldResume,
  type AppStateLike,
  type AppStateStatus,
} from "./reconnect";

/**
 * KIN-MOBILE-001 R7 — coming back to a live conversation.
 *
 * The story's 「离开再回来」beat: a foreground return continues the open
 * conversation from the last applied seq without replaying it, a failed
 * resume keeps what the reader already read and gives exactly one manual
 * retry, and a late answer never paints a conversation that closed
 * (AGENTS.md §11). The stream and the REST catch-up both go through the same
 * seams the R4 model tests use, so this suite drives the real model.
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

function userMessage(seq: number, content: string): TaskEvent {
  return event(seq, "message", {
    speaker: "user",
    role: "user",
    content,
    visibility: { user: true, task: true },
  });
}

function agentMessage(seq: number, content: string): TaskEvent {
  return event(seq, "message", {
    speaker: "kin",
    content,
    visibility: { user: true, task: true },
  });
}

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
type Router = (url: string) => Reply | Promise<Reply>;

function routedFetch(route: Router): typeof fetch {
  return jest.fn(async (input: string) => {
    const reply = await route(input);
    return ok(reply.body, reply.status ?? 200);
  }) as unknown as typeof fetch;
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
              return Promise.resolve({
                done: false,
                value: pending.shift() as string,
              });
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

type Opened = {
  afterSeq: number;
  url: string;
  push(chunk: string): void;
  end(): void;
};

/** Records every open request so a resume's cursor is measurable. */
function fakeStream(): {
  source: StreamSource;
  opened: Opened[];
  failOpen(): void;
  allowOpen(): void;
} {
  const opened: Opened[] = [];
  let failing = false;
  return {
    opened,
    failOpen() {
      failing = true;
    },
    allowOpen() {
      failing = false;
    },
    source: {
      async open(request: StreamRequest): Promise<StreamConnection> {
        if (failing) throw new Error("unreachable");
        const queue = chunkQueue();
        opened.push({
          afterSeq: request.afterSeq,
          url: request.url,
          push: queue.push,
          end: queue.end,
        });
        return { status: 200, chunks: queue.iterable };
      },
    },
  };
}

const immediate = (run: () => void): (() => void) => {
  queueMicrotask(run);
  return () => undefined;
};

/** The platform app-state port the screen subscribes to, drivable by a test. */
function fakeAppState(initial: AppStateStatus): {
  port: AppStateLike;
  emit(status: AppStateStatus): void;
  removals(): number;
} {
  const listeners = new Set<(status: AppStateStatus) => void>();
  let current = initial;
  let removed = 0;
  return {
    port: {
      get currentState() {
        return current;
      },
      addEventListener(_type, listener) {
        listeners.add(listener);
        return {
          remove() {
            removed += 1;
            listeners.delete(listener);
          },
        };
      },
    },
    emit(status) {
      current = status;
      for (const listener of [...listeners]) listener(status);
    },
    removals: () => removed,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function liveThread(fetchImpl: typeof fetch, source: StreamSource) {
  return createThread({
    origin: ORIGIN,
    token: TOKEN,
    taskId: TASK_ID,
    fetchImpl,
    source,
    schedule: immediate,
    backoff: { baseMs: 1, maxMs: 1, maxAttempts: 1 },
  });
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("KIN-MOBILE-001 R7 reconnect", () => {
  it("KIN-MOBILE-001 R7: a foreground return reopens the stream from the last applied seq and appends only the new event", async () => {
    const fake = fakeStream();
    const fetchImpl = routedFetch((url) => {
      if (url.includes("/events")) {
        // The resume's bounded catch-up: nothing was missed, so the live
        // stream is the only append.
        if (url.includes("since_seq=")) return { body: [] };
        return { body: [userMessage(1, "first question")] };
      }
      return { body: task() };
    });
    const model = liveThread(fetchImpl, fake.source);

    await model.start();
    await settle();
    expect(fake.opened).toHaveLength(1);
    expect(fake.opened[0].afterSeq).toBe(1);

    fake.opened[0].push(frame(agentMessage(2, "first answer")));
    await settle();
    const before = model.getState().turns;
    expect(count(JSON.stringify(before), "first answer")).toBe(1);

    // The stream gives up for good and the banner says offline.
    fake.failOpen();
    fake.opened[0].end();
    await settle();
    expect(model.getState().banner).toBe("offline");

    fake.allowOpen();
    await model.resume();
    await settle();

    // One replacement connection, resuming after the last applied seq — not
    // from zero (which would replay what the reader already read).
    expect(fake.opened).toHaveLength(2);
    expect(fake.opened[1].afterSeq).toBe(2);

    fake.opened[1].push(frame(userMessage(3, "next question")));
    await settle();

    const after = model.getState().turns;
    expect(after).toHaveLength(before.length + 1);
    expect(count(JSON.stringify(after), "first answer")).toBe(1);
    expect(count(JSON.stringify(after), "next question")).toBe(1);
    expect(model.getState().banner).toBeNull();
    model.close();
  });

  it("KIN-MOBILE-001 R7: a failed resume keeps the read content and the queued send", async () => {
    const fake = fakeStream();
    let reachable = true;
    const fetchImpl = routedFetch((url) => {
      if (!reachable) return { status: 500, body: {} };
      if (url.includes("/events")) {
        return {
          body: [
            userMessage(1, "do it"),
            event(2, "task_started"),
            agentMessage(3, "working"),
          ],
        };
      }
      return { body: task() };
    });
    const model = liveThread(fetchImpl, fake.source);

    await model.start();
    await settle();
    expect(await model.send("keep this draft")).toEqual({
      ok: true,
      queued: true,
    });
    expect(model.getState().sendQueue).toHaveLength(1);

    fake.failOpen();
    fake.opened[0].end();
    await settle();
    expect(model.getState().banner).toBe("offline");
    const beforeTurns = model.getState().turns;
    const beforeQueue = model.getState().sendQueue;

    // Both the live stream and the durable catch-up stay unreachable.
    reachable = false;
    await model.resume();
    await settle();

    const state = model.getState();
    expect(state.turns).toBe(beforeTurns);
    expect(state.sendQueue).toBe(beforeQueue);
    expect(state.sendQueue).toEqual([{ id: expect.any(String), text: "keep this draft" }]);
    expect(state.banner).toBe("offline");
    expect(fake.opened).toHaveLength(1);
    model.close();
  });

  it("KIN-MOBILE-001 R7: a healthy conversation is not reopened", async () => {
    const fake = fakeStream();
    const fetchImpl = routedFetch((url) =>
      url.includes("/events")
        ? { body: [userMessage(1, "hello")] }
        : { body: task() },
    );
    const model = liveThread(fetchImpl, fake.source);

    await model.start();
    await settle();
    expect(fake.opened).toHaveLength(1);

    // The transition the screen listens for is a resume trigger, but the
    // model already has a live stream: it must not open a second one.
    expect(shouldResume("background", "active")).toBe(true);
    const before = model.getState();
    const after = await model.resume();
    await settle();

    expect(after).toBe(before);
    expect(model.getState()).toBe(before);
    expect(fake.opened).toHaveLength(1);
    expect(model.getState().banner).toBeNull();
    model.close();
  });

  it("KIN-MOBILE-001 R7: the offline banner offers one retry that reopens the stream", async () => {
    expect(canRetry({ banner: "offline", status: "ready" })).toBe(true);
    expect(canRetry({ banner: null, status: "ready" })).toBe(false);
    // The blank/expired screen keeps its own full-screen retry.
    expect(canRetry({ banner: "offline", status: "error" })).toBe(false);

    const turns: ThreadState["turns"] = [
      {
        kind: "user",
        item: { kind: "message", key: "user-1", speaker: "you", text: "hello" },
      },
    ];
    const offline: ThreadState = {
      taskId: TASK_ID,
      title: "Morning planning",
      status: "ready",
      turns,
      running: false,
      sendQueue: [],
      banner: "offline",
      reason: "unreachable",
    };

    const onReconnect = jest.fn();
    const down = await render(
      createElement(ConversationView, {
        onBack: () => undefined,
        onReconnect,
        state: offline,
        t,
      }),
    );
    // The sentence the reader already had stays beside the one retry.
    expect(down.getByText(t("pairing.unreachable"))).toBeTruthy();
    expect(down.getByText(t("pairing.retry"))).toBeTruthy();
    await fireEvent.press(down.getByTestId("conversation:reconnect"));
    expect(onReconnect).toHaveBeenCalledTimes(1);
    await down.unmount();

    const up = await render(
      createElement(ConversationView, {
        onBack: () => undefined,
        onReconnect,
        state: { ...offline, banner: null, reason: null },
        t,
      }),
    );
    expect(up.queryByTestId("conversation:reconnect")).toBeNull();
    await up.unmount();
  });

  it("KIN-MOBILE-001 R7: a resume after close paints nothing", async () => {
    const fake = fakeStream();
    const fetchImpl = routedFetch((url) =>
      url.includes("/events")
        ? { body: [userMessage(1, "hello")] }
        : { body: task() },
    );
    const model = liveThread(fetchImpl, fake.source);
    const painted: ThreadState[] = [];
    model.subscribe((next) => painted.push(next));

    await model.start();
    await settle();
    const before = model.getState();
    expect(painted.length).toBeGreaterThan(0);

    model.close();
    painted.length = 0;
    const after = await model.resume();
    await settle();

    expect(painted).toEqual([]);
    expect(after).toBe(before);
    expect(model.getState()).toBe(before);
    expect(fake.opened).toHaveLength(1);
  });

  it("KIN-MOBILE-001 R7: a foreground return on the conversation screen reopens the dead stream", async () => {
    const fake = fakeStream();
    const appState = fakeAppState("active");
    const fetchImpl = routedFetch((url) => {
      if (url.endsWith("/api/approvals?status=pending")) return { body: [] };
      if (url.endsWith("/api/user-questions?status=pending")) return { body: [] };
      // A failed send is the fastest way to the offline banner without
      // waiting out the stream's five-attempt backoff.
      if (url.includes("/prompt")) return { status: 500, body: {} };
      if (url.includes("/events")) {
        if (url.includes("since_seq=")) return { body: [] };
        return { body: [userMessage(1, "hello")] };
      }
      return { body: task({ status: "succeeded" }) };
    });

    const screen = await render(
      createElement(ConversationScreen, {
        appState: appState.port,
        fetchImpl,
        onBack: () => undefined,
        readSessionImpl: async () => ({ origin: ORIGIN, token: TOKEN }),
        source: fake.source,
        taskId: TASK_ID,
      }),
    );
    await waitFor(() => expect(fake.opened).toHaveLength(1));
    await waitFor(() => expect(screen.getByText("hello")).toBeTruthy());

    await fireEvent.changeText(
      screen.getByTestId("conversation:composer"),
      "ping",
    );
    await fireEvent.press(screen.getByTestId("conversation:send"));
    await waitFor(() =>
      expect(screen.getByTestId("conversation:reconnect")).toBeTruthy(),
    );

    // Leaving and coming back is the R7 transition: the screen reopens the
    // stream from the last applied seq instead of replaying the conversation.
    await act(async () => {
      appState.emit("background");
      appState.emit("active");
    });
    await waitFor(() => expect(fake.opened).toHaveLength(2));
    expect(fake.opened[1].afterSeq).toBe(1);

    // The screen's own cleanup removes the platform subscription.
    await screen.unmount();
    expect(appState.removals()).toBe(1);
  });

  it("KIN-MOBILE-001 R7: a return to the foreground is the only transition that resumes", () => {
    expect(shouldResume("background", "active")).toBe(true);
    expect(shouldResume("inactive", "active")).toBe(true);
    expect(shouldResume("unknown", "active")).toBe(true);
    expect(shouldResume("active", "active")).toBe(false);
    expect(shouldResume("active", "background")).toBe(false);
    expect(shouldResume("active", "inactive")).toBe(false);
    expect(shouldResume("background", "inactive")).toBe(false);
  });
});
