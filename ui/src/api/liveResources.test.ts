import { describe, expect, it, vi } from "vitest";
import type {
  Approval,
  Task,
  TaskEvent,
  UserQuestion,
} from "./client";
import {
  LiveResourceStore,
  taskListKey,
  type LiveResourceAPI,
} from "./liveResources";

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

function approval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "approval-1",
    task_id: "task-1",
    kind: "tool",
    payload: {},
    decision: "pending",
    created_at: 1,
    ...overrides,
  };
}

function question(overrides: Partial<UserQuestion> = {}): UserQuestion {
  return {
    id: "question-1",
    task_id: "task-1",
    payload: {
      question: "Choose",
      options: [{ label: "A" }, { label: "B" }],
    },
    status: "pending",
    created_at: 1,
    ...overrides,
  };
}

function event(seq: number, type = "message", eventEpoch = 0): TaskEvent {
  return {
    task_id: "task-1",
    event_epoch: eventEpoch,
    seq,
    ts: seq,
    type,
    payload: {},
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function api(overrides: Partial<LiveResourceAPI> = {}): LiveResourceAPI {
  return {
    listTasks: vi.fn(async () => []),
    getTask: vi.fn(async (id: string) => task({ id })),
    listEvents: vi.fn(async () => []),
    listApprovals: vi.fn(async () => []),
    listUserQuestions: vi.fn(async () => []),
    ...overrides,
  };
}

describe("LiveResourceStore", () => {
  it("refreshes all registered snapshots after reconnect", async () => {
    let tasks = [task()];
    let approvals = [approval()];
    let questions = [question()];
    let events = [event(1)];
    const client = api({
      listTasks: vi.fn(async () => tasks),
      getTask: vi.fn(async () => tasks[0]),
      listEvents: vi.fn(async (_id, since) =>
        events.filter((item) => item.seq > since),
      ),
      listApprovals: vi.fn(async () => approvals),
      listUserQuestions: vi.fn(async () => questions),
    });
    const store = new LiveResourceStore(client);
    const params = { limit: 50 };
    const releaseList = store.acquireTaskList(params);
    const releasePending = store.acquirePending();
    const releaseTask = store.acquireTask("task-1");
    await store.reconnect();

    tasks = [task({ status: "succeeded" })];
    approvals = [];
    questions = [];
    events = [event(1), event(2, "result")];
    await store.reconnect();

    expect(store.getTaskList(taskListKey(params)).data[0]?.status).toBe("succeeded");
    expect(store.getSnapshot().pending.data).toEqual({
      approvals: [],
      questions: [],
    });
    expect(store.getTaskDetail("task-1").data.events.map((item) => item.seq)).toEqual([
      1, 2,
    ]);

    releaseList();
    releasePending();
    releaseTask();
  });

  it("resets reused event sequences when another client advances the epoch", async () => {
    let epoch = 0;
    const listEvents = vi
      .fn<LiveResourceAPI["listEvents"]>()
      .mockResolvedValueOnce([event(1, "old-message"), event(2, "old-result")])
      .mockResolvedValueOnce([event(1, "retained-message")]);
    const store = new LiveResourceStore(
      api({
        getTask: vi.fn(async () => task({ event_epoch: epoch })),
        listEvents,
      }),
    );
    const release = store.acquireTask("task-1");
    await store.refreshTask("task-1");

    epoch = 1;
    store.applyMessage({
      kind: "task_update",
      data: task({ event_epoch: 1, status: "queued" }),
    });
    await vi.waitFor(() => expect(listEvents).toHaveBeenLastCalledWith("task-1", 0));
    await vi.waitFor(() =>
      expect(
        store.getTaskDetail("task-1").data.events.map((item) => item.type),
      ).toEqual(["retained-message"]),
    );
    release();
  });

  it("refetches events from zero when reconnect observes a newer epoch", async () => {
    let epoch = 0;
    const listEvents = vi
      .fn<LiveResourceAPI["listEvents"]>()
      .mockResolvedValueOnce([event(1, "old-message"), event(2, "old-result")])
      .mockResolvedValueOnce([event(1, "new-message")]);
    const getTask = vi.fn(async () =>
      task({ event_epoch: epoch, status: "succeeded" }),
    );
    const store = new LiveResourceStore(api({ getTask, listEvents }));
    const release = store.acquireTask("task-1");
    await store.refreshTask("task-1");

    epoch = 1;
    await store.reconnect();

    expect(listEvents).toHaveBeenLastCalledWith("task-1", 0);
    expect(
      store.getTaskDetail("task-1").data.events.map((item) => item.type),
    ).toEqual(["new-message"]);
    release();
  });

  it("retries when the event epoch changes between task reads", async () => {
    let taskReads = 0;
    const getTask = vi.fn(async () => {
      taskReads += 1;
      return task({
        event_epoch: taskReads >= 4 ? 1 : 0,
        status: "succeeded",
      });
    });
    const listEvents = vi
      .fn<LiveResourceAPI["listEvents"]>()
      .mockResolvedValueOnce([event(1, "old-message")])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([event(1, "new-message", 1)]);
    const store = new LiveResourceStore(api({ getTask, listEvents }));
    const release = store.acquireTask("task-1");
    await store.refreshTask("task-1");

    await store.reconnect();

    expect(listEvents).toHaveBeenLastCalledWith("task-1", 0);
    expect(
      store.getTaskDetail("task-1").data.events.map((item) => item.type),
    ).toEqual(["new-message"]);
    release();
  });

  it("issues a fresh snapshot after an in-flight request on reconnect", async () => {
    const oldTasks = deferred<Task[]>();
    const freshTasks = deferred<Task[]>();
    const listTasks = vi
      .fn<LiveResourceAPI["listTasks"]>()
      .mockImplementationOnce(() => oldTasks.promise)
      .mockImplementationOnce(() => freshTasks.promise);
    const store = new LiveResourceStore(api({ listTasks }));
    const params = { limit: 20 };
    const release = store.acquireTaskList(params);

    const reconnect = store.reconnect();
    expect(listTasks).toHaveBeenCalledTimes(1);
    oldTasks.resolve([task({ title: "stale" })]);
    await vi.waitFor(() => expect(listTasks).toHaveBeenCalledTimes(2));
    freshTasks.resolve([task({ title: "fresh" })]);
    await reconnect;

    expect(store.getTaskList(taskListKey(params)).data[0]?.title).toBe("fresh");
    release();
  });

  it("keeps a successful pending snapshot when its peer request fails", async () => {
    const store = new LiveResourceStore(
      api({
        listApprovals: vi.fn(async () => [approval()]),
        listUserQuestions: vi.fn(async () => {
          throw new Error("questions unavailable");
        }),
      }),
    );

    await store.refreshPending();

    expect(store.getSnapshot().pending.data.approvals).toEqual([approval()]);
    expect(store.getSnapshot().pending.data.questions).toEqual([]);
    expect(store.getSnapshot().pending.error).toEqual(
      new Error("questions unavailable"),
    );
  });

  it("deduplicates task and approval updates", async () => {
    const store = new LiveResourceStore(api());
    const params = { limit: 20 };
    const releaseList = store.acquireTaskList(params);
    const releasePending = store.acquirePending();
    await store.reconnect();
    const updatedTask = task({ title: "Newest" });
    const pendingApproval = approval();

    store.applyMessage({ kind: "task_update", data: updatedTask });
    store.applyMessage({ kind: "task_update", data: updatedTask });
    store.applyMessage({ kind: "approval_update", data: pendingApproval });
    store.applyMessage({ kind: "approval_update", data: pendingApproval });

    expect(store.getTaskList(taskListKey(params)).data).toEqual([updatedTask]);
    expect(store.getSnapshot().pending.data.approvals).toEqual([pendingApproval]);

    releaseList();
    releasePending();
  });

  it("does not inject live tasks outside a paginated cursor", async () => {
    const store = new LiveResourceStore(api());
    const params = { limit: 20, before: "task-5" };
    const release = store.acquireTaskList(params);
    await store.reconnect();

    store.applyMessage({
      kind: "task_update",
      data: task({ id: "task-6" }),
    });
    store.applyMessage({
      kind: "task_update",
      data: task({ id: "task-4" }),
    });

    expect(store.getTaskList(taskListKey(params)).data.map((item) => item.id)).toEqual([
      "task-4",
    ]);
    release();
  });

  it("does not let stale snapshots resurrect deleted or resolved resources", async () => {
    const tasksResponse = deferred<Task[]>();
    const approvalsResponse = deferred<Approval[]>();
    const questionsResponse = deferred<UserQuestion[]>();
    const store = new LiveResourceStore(
      api({
        listTasks: vi.fn(() => tasksResponse.promise),
        listApprovals: vi.fn(() => approvalsResponse.promise),
        listUserQuestions: vi.fn(() => questionsResponse.promise),
      }),
    );
    const params = { limit: 20 };
    const releaseList = store.acquireTaskList(params);
    const releasePending = store.acquirePending();
    const listRefresh = store.refreshTaskList(params);
    const pendingRefresh = store.refreshPending();

    store.applyMessage({ kind: "task_update", data: task() });
    store.applyMessage({ kind: "task_deleted", data: { id: "task-1" } });
    store.applyMessage({
      kind: "approval_update",
      data: approval({ decision: "approved" }),
    });
    store.applyMessage({
      kind: "user_question_update",
      data: question({ status: "answered" }),
    });

    tasksResponse.resolve([task({ title: "stale" })]);
    approvalsResponse.resolve([approval()]);
    questionsResponse.resolve([question()]);
    await Promise.all([listRefresh, pendingRefresh]);

    expect(store.getTaskList(taskListKey(params)).data).toEqual([]);
    expect(store.getSnapshot().pending.data).toEqual({
      approvals: [],
      questions: [],
    });

    releaseList();
    releasePending();
  });

  it("keeps accepted events immutable and recovers sequence gaps", async () => {
    const recovered = deferred<TaskEvent[]>();
    const listEvents = vi
      .fn<LiveResourceAPI["listEvents"]>()
      .mockResolvedValueOnce([event(1)])
      .mockImplementationOnce(() => recovered.promise);
    const store = new LiveResourceStore(api({ listEvents }));
    const release = store.acquireTask("task-1");
    await store.refreshTask("task-1");

    store.applyMessage({ kind: "event", data: event(1, "stale-duplicate") });
    store.applyMessage({ kind: "event", data: event(3, "result") });
    recovered.resolve([event(2), event(3, "stale-result")]);

    await vi.waitFor(() => {
      expect(
        store.getTaskDetail("task-1").data.events.map((item) => [
          item.seq,
          item.type,
        ]),
      ).toEqual([
        [1, "message"],
        [2, "message"],
        [3, "result"],
      ]);
    });
    expect(listEvents).toHaveBeenLastCalledWith("task-1", 1);

    release();
  });

  it("does not let an older HTTP mutation response overwrite a newer live task", async () => {
    const store = new LiveResourceStore(api());
    const params = { limit: 20 };
    const release = store.acquireTaskList(params);
    await store.reconnect();

    const requestRevision = store.currentRevision();
    store.applyMessage({
      kind: "task_update",
      data: task({ status: "succeeded" }),
    });
    store.applyTaskSnapshot(task({ status: "queued" }), requestRevision);

    expect(store.getTaskList(taskListKey(params)).data[0]?.status).toBe(
      "succeeded",
    );
    release();
  });

  it("replaces reused retry sequences while preserving newer live events", async () => {
    const client = api({
      listEvents: vi.fn(async () => [event(1), event(2, "old-result")]),
    });
    const store = new LiveResourceStore(client);
    const release = store.acquireTask("task-1");
    await store.refreshTask("task-1");

    const barrier = store.resetTaskEvents("task-1");
    store.applyMessage({ kind: "event", data: event(2, "new-result", 1) });
    store.replaceTaskEvents(
      "task-1",
      [event(1, "new-message", 1), event(2, "stale-result", 1)],
      barrier.revision,
    );

    expect(
      store.getTaskDetail("task-1").data.events.map((item) => item.type),
    ).toEqual(["new-message", "new-result"]);
    release();
  });

  it("can restore the prior transcript when a retry request fails", async () => {
    const store = new LiveResourceStore(
      api({ listEvents: vi.fn(async () => [event(1), event(2, "result")]) }),
    );
    const release = store.acquireTask("task-1");
    await store.refreshTask("task-1");

    const reset = store.resetTaskEvents("task-1");
    expect(store.getTaskDetail("task-1").data.events).toEqual([]);
    expect(store.restoreTaskEvents(reset)).toBe(true);
    expect(
      store.getTaskDetail("task-1").data.events.map((item) => item.seq),
    ).toEqual([1, 2]);
    release();
  });

  it("refuses to restore a retry transcript after authoritative updates", async () => {
    const store = new LiveResourceStore(
      api({ listEvents: vi.fn(async () => [event(1), event(2, "old-result")]) }),
    );
    const release = store.acquireTask("task-1");
    await store.refreshTask("task-1");

    const reset = store.resetTaskEvents("task-1");
    store.applyMessage({
      kind: "task_update",
      data: task({ event_epoch: 1, status: "queued" }),
    });
    store.applyMessage({
      kind: "event",
      data: event(1, "authoritative-message", 1),
    });

    expect(store.restoreTaskEvents(reset)).toBe(false);
    expect(store.getTaskDetail("task-1").data.task).toMatchObject({
      event_epoch: 1,
      status: "queued",
    });
    expect(store.getTaskDetail("task-1").data.events).toEqual([
      event(1, "authoritative-message", 1),
    ]);
    release();
  });

  it("rejects a speculative retry epoch when the server still has the old epoch", async () => {
    const store = new LiveResourceStore(
      api({
        getTask: vi.fn(async () =>
          task({ event_epoch: 0, status: "succeeded" }),
        ),
        listEvents: vi.fn(async () => [
          event(1, "old-message"),
          event(2, "old-result"),
        ]),
      }),
    );
    const release = store.acquireTask("task-1");
    await store.refreshTask("task-1");

    store.resetTaskEvents("task-1");
    await store.refreshTask("task-1", true);

    const detail = store.getTaskDetail("task-1");
    expect(detail.loading).toBe(false);
    expect(detail.error).toBeNull();
    expect(detail.data.events.map((item) => item.type)).toEqual([
      "old-message",
      "old-result",
    ]);
    release();
  });

  it("does not let a pre-retry refresh roll back a confirmed retry epoch", async () => {
    const oldTask = deferred<Task>();
    const getTask = vi
      .fn<LiveResourceAPI["getTask"]>()
      .mockResolvedValueOnce(task({ event_epoch: 0, status: "succeeded" }))
      .mockResolvedValueOnce(task({ event_epoch: 0, status: "succeeded" }))
      .mockImplementationOnce(() => oldTask.promise)
      .mockResolvedValueOnce(task({ event_epoch: 1, status: "queued" }))
      .mockResolvedValueOnce(task({ event_epoch: 1, status: "queued" }))
      .mockResolvedValueOnce(task({ event_epoch: 0, status: "succeeded" }));
    const listEvents = vi
      .fn<LiveResourceAPI["listEvents"]>()
      .mockResolvedValueOnce([event(1, "old-message")])
      .mockResolvedValueOnce([event(1, "new-message", 1)])
      .mockResolvedValueOnce([event(1, "stale-old-message")]);
    const store = new LiveResourceStore(api({ getTask, listEvents }));
    const release = store.acquireTask("task-1");
    await store.refreshTask("task-1");

    const oldRefresh = store.refreshTask("task-1");
    await vi.waitFor(() => expect(getTask).toHaveBeenCalledTimes(3));
    store.resetTaskEvents("task-1");
    await store.refreshTask("task-1");

    oldTask.resolve(task({ event_epoch: 0, status: "succeeded" }));
    await oldRefresh;

    const detail = store.getTaskDetail("task-1");
    expect(detail.data.task).toMatchObject({ event_epoch: 1, status: "queued" });
    expect(detail.data.events).toEqual([event(1, "new-message", 1)]);
    release();
  });

  it("ignores an old refresh after the retry event epoch changes", async () => {
    const oldEvents = deferred<TaskEvent[]>();
    const store = new LiveResourceStore(
      api({ listEvents: vi.fn(() => oldEvents.promise) }),
    );
    const release = store.acquireTask("task-1");
    const refresh = store.refreshTask("task-1");

    store.resetTaskEvents("task-1");
    store.applyMessage({
      kind: "event",
      data: event(1, "new-generation", 1),
    });
    oldEvents.resolve([event(1, "old-generation")]);
    await refresh;

    expect(store.getTaskDetail("task-1").data.events).toEqual([
      event(1, "new-generation", 1),
    ]);
    release();
  });

  it("starts a fresh task request when a released task is reacquired", async () => {
    const oldConfirmation = deferred<Task>();
    const freshEvents = deferred<TaskEvent[]>();
    const getTask = vi
      .fn<LiveResourceAPI["getTask"]>()
      .mockResolvedValueOnce(task({ title: "stale" }))
      .mockImplementationOnce(() => oldConfirmation.promise)
      .mockResolvedValueOnce(task({ title: "fresh" }))
      .mockResolvedValueOnce(task({ title: "fresh" }));
    const listEvents = vi
      .fn<LiveResourceAPI["listEvents"]>()
      .mockResolvedValueOnce([])
      .mockImplementationOnce(() => freshEvents.promise);
    const store = new LiveResourceStore(api({ getTask, listEvents }));

    const releaseOld = store.acquireTask("task-1");
    const oldRefresh = store.refreshTask("task-1");
    await vi.waitFor(() => expect(getTask).toHaveBeenCalledTimes(2));
    releaseOld();

    const releaseFresh = store.acquireTask("task-1");
    const freshRefresh = store.refreshTask("task-1");
    await vi.waitFor(() => expect(listEvents).toHaveBeenCalledTimes(2));
    store.applyMessage({
      kind: "event",
      data: event(1, "live-after-reacquire"),
    });
    freshEvents.resolve([]);
    await freshRefresh;

    oldConfirmation.resolve(task({ title: "stale" }));
    await oldRefresh;

    expect(getTask).toHaveBeenCalledTimes(4);
    expect(store.getTaskDetail("task-1").data.task?.title).toBe("fresh");
    expect(store.getTaskDetail("task-1").data.events).toEqual([
      event(1, "live-after-reacquire"),
    ]);
    releaseFresh();
  });

  it("ignores event recovery from a released task lease", async () => {
    const oldRecovery = deferred<TaskEvent[]>();
    const listEvents = vi
      .fn<LiveResourceAPI["listEvents"]>()
      .mockResolvedValueOnce([])
      .mockImplementationOnce(() => oldRecovery.promise)
      .mockResolvedValueOnce([]);
    const store = new LiveResourceStore(api({ listEvents }));
    const releaseOld = store.acquireTask("task-1");
    await store.refreshTask("task-1");

    store.applyMessage({ kind: "event", data: event(2, "old-gap") });
    await vi.waitFor(() => expect(listEvents).toHaveBeenCalledTimes(2));
    releaseOld();

    const releaseFresh = store.acquireTask("task-1");
    await store.refreshTask("task-1");
    store.applyMessage({
      kind: "event",
      data: event(1, "fresh-after-reacquire"),
    });
    oldRecovery.resolve([event(1, "stale-recovery"), event(2, "stale-recovery")]);
    await oldRecovery.promise;
    await Promise.resolve();

    expect(store.getTaskDetail("task-1").data.events).toEqual([
      event(1, "fresh-after-reacquire"),
    ]);
    releaseFresh();
  });

  it("evicts an unregistered task transcript", async () => {
    const store = new LiveResourceStore(
      api({ listEvents: vi.fn(async () => [event(1)]) }),
    );
    const release = store.acquireTask("task-1");
    await store.refreshTask("task-1");
    release();

    store.applyMessage({ kind: "event", data: event(2) });
    expect(store.getTaskDetail("task-1").loaded).toBe(false);
    expect(store.getTaskDetail("task-1").data.events).toEqual([]);
  });

  it("evicts an unregistered task-list query", async () => {
    const store = new LiveResourceStore(api());
    const params = { q: "temporary search", limit: 20 };
    const release = store.acquireTaskList(params);
    await store.refreshTaskList(params);
    release();

    expect(store.getSnapshot().taskLists[taskListKey(params)]).toBeUndefined();
  });
});
