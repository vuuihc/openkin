import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionChangePage, Task, WSMessage } from "./client";
import { LiveResourceStore, taskListKey, type LiveResourceAPI } from "./liveResources";
import { SessionSync } from "./sessionSync";
import { useAppStore } from "../store/appStore";

/**
 * The console's sync loop is the one place where "the Hub is the truth and the
 * stream is a hint" has to hold in code, so these tests are about ordering:
 * which request reads the cursor first, what moves it, and what happens on a
 * network that cannot keep a stream open.
 */

const client = vi.hoisted(() => ({
  getSessionCursor: vi.fn(),
  listSessions: vi.fn(),
  waitSessions: vi.fn(),
  streamEvents: vi.fn(),
}));

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, ...client };
});

type StreamOptions = {
  onMessage: (message: WSMessage) => void;
  onOpen?: () => void;
  onStatus?: (status: string) => void;
  onUnavailable?: () => void;
};

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Task",
    agent: "kin",
    cwd: "/tmp",
    prompt: "work",
    status: "running",
    tokens_in: 0,
    tokens_out: 0,
    created_at: 1,
    event_epoch: 0,
    ...overrides,
  };
}

function page(overrides: Partial<SessionChangePage> = {}): SessionChangePage {
  return {
    sessions: [],
    deleted: [],
    next_cursor: 1,
    has_more: false,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let stream: StreamOptions | null = null;

beforeEach(() => {
  stream = null;
  client.getSessionCursor.mockReset().mockResolvedValue(10);
  client.listSessions.mockReset().mockResolvedValue(page({ next_cursor: 10 }));
  // Idle by default: a Hub holds the request until something changes, and a
  // mock that answers instantly would spin the loop.
  client.waitSessions.mockReset().mockImplementation(() => new Promise(() => {}));
  client.streamEvents.mockReset().mockImplementation((options: StreamOptions) => {
    stream = options;
    return () => {
      stream = null;
    };
  });
});

afterEach(() => {
  useAppStore.setState({ wsStatus: "connecting" });
});

function harness() {
  const api: LiveResourceAPI = {
    listTasks: vi.fn(async () => []),
    getTask: vi.fn(async (id: string) => task({ id })),
    listEvents: vi.fn(async () => []),
    listApprovals: vi.fn(async () => []),
    listUserQuestions: vi.fn(async () => []),
  };
  const store = new LiveResourceStore(api);
  const messages: WSMessage[] = [];
  const sync = new SessionSync(store, {
    onMessage: (message) => messages.push(message),
  });
  return { store, sync, messages };
}

describe("SessionSync", () => {
  it("reads the cursor before it starts following the feed", async () => {
    const { store, sync, messages } = harness();
    const params = { limit: 50 };
    const release = store.acquireTaskList(params);
    await store.refreshTaskList(params);

    client.listSessions.mockResolvedValueOnce(
      page({ sessions: [task({ title: "renamed" })], next_cursor: 12 }),
    );
    sync.start();
    await vi.waitFor(() => expect(stream).not.toBeNull());
    stream?.onOpen?.();

    await vi.waitFor(() =>
      expect(store.getTaskList(taskListKey(params)).data[0]?.title).toBe("renamed"),
    );
    expect(client.getSessionCursor).toHaveBeenCalled();
    // The cursor is read first, then followed from there.
    expect(client.listSessions).toHaveBeenCalledWith({ updatedSince: 10, limit: 200 });
    expect(messages.map((message) => message.kind)).toEqual(["task_update"]);

    // The cursor is where the page ended, not where it started.
    client.listSessions.mockClear();
    stream?.onOpen?.();
    await vi.waitFor(() =>
      expect(client.listSessions).toHaveBeenCalledWith({ updatedSince: 12, limit: 200 }),
    );

    sync.stop();
    release();
  });

  it("drains every page before it settles", async () => {
    const { store, sync } = harness();
    const params = { limit: 50 };
    const release = store.acquireTaskList(params);
    await store.refreshTaskList(params);

    client.listSessions
      .mockResolvedValueOnce(page({ sessions: [task()], next_cursor: 11, has_more: true }))
      .mockResolvedValueOnce(page({ sessions: [task({ id: "task-2" })], next_cursor: 13 }));
    sync.start();
    await vi.waitFor(() => expect(stream).not.toBeNull());
    stream?.onOpen?.();

    await vi.waitFor(() =>
      expect(store.getTaskList(taskListKey(params)).data.map((t) => t.id)).toEqual([
        "task-1",
        "task-2",
      ]),
    );
    expect(client.listSessions).toHaveBeenLastCalledWith({
      updatedSince: 11,
      limit: 200,
    });

    sync.stop();
    release();
  });

  it("applies a deletion that happened while it was away", async () => {
    const { store, sync, messages } = harness();
    const params = { limit: 50 };
    const release = store.acquireTaskList(params);
    await store.refreshTaskList(params);

    client.listSessions.mockResolvedValueOnce(page({ deleted: ["task-9"], next_cursor: 20 }));
    sync.start();
    await vi.waitFor(() => expect(stream).not.toBeNull());
    stream?.onOpen?.();

    await vi.waitFor(() =>
      expect(messages).toEqual([{ kind: "task_deleted", data: { id: "task-9" } }]),
    );

    sync.stop();
    release();
  });

  it("keeps the cursor where it was when a live frame arrives", async () => {
    const { store, sync } = harness();
    const params = { limit: 50 };
    const release = store.acquireTaskList(params);
    await store.refreshTaskList(params);
    sync.start();
    await vi.waitFor(() => expect(stream).not.toBeNull());

    stream?.onMessage({ kind: "task_update", data: task({ status: "succeeded" }) });
    expect(store.getTaskList(taskListKey(params)).data[0]?.status).toBe("succeeded");

    // A frame is a hint, never a cursor: only a page read over HTTP moves it,
    // or a change missed between two frames would be missed forever.
    stream?.onOpen?.();
    await vi.waitFor(() => expect(client.listSessions).toHaveBeenCalledTimes(1));
    stream?.onOpen?.();
    await vi.waitFor(() => expect(client.listSessions).toHaveBeenCalledTimes(2));
    expect(client.listSessions).toHaveBeenLastCalledWith({
      updatedSince: 10,
      limit: 200,
    });

    sync.stop();
    release();
  });

  it("long-polls when the stream is not viable", async () => {
    const { store, sync } = harness();
    const params = { limit: 50 };
    const release = store.acquireTaskList(params);
    await store.refreshTaskList(params);
    const pending = deferred<SessionChangePage>();
    client.waitSessions.mockReturnValueOnce(pending.promise);
    sync.start();
    await vi.waitFor(() => expect(client.waitSessions).toHaveBeenCalled());

    // The stream dies mid-poll; the poll in flight is what carries the change,
    // which is exactly how a relay behaves.
    await vi.waitFor(() => expect(stream).not.toBeNull());
    stream?.onUnavailable?.();

    pending.resolve(page({ sessions: [task({ title: "from the poll" })], next_cursor: 30 }));
    await vi.waitFor(() =>
      expect(store.getTaskList(taskListKey(params)).data[0]?.title).toBe("from the poll"),
    );
    // Polling the feed is a working connection, not an outage.
    expect(useAppStore.getState().wsStatus).toBe("connected");
    expect(client.waitSessions).toHaveBeenCalledWith(
      expect.objectContaining({ updatedSince: 10, timeoutSeconds: 25 }),
    );

    sync.stop();
    release();
  });

  it("stops asking the Hub once it is stopped", async () => {
    const { sync } = harness();
    sync.start();
    await vi.waitFor(() => expect(client.getSessionCursor).toHaveBeenCalled());
    await vi.waitFor(() => expect(stream).not.toBeNull());
    sync.stop();

    client.listSessions.mockClear();
    client.waitSessions.mockClear();
    stream?.onOpen?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(client.listSessions).not.toHaveBeenCalled();
    expect(client.waitSessions).not.toHaveBeenCalled();
  });
});
