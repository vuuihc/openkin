import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import {
  createResumeController,
  MAX_RESUME_ATTEMPTS,
  RESUME_THRESHOLD_MS,
  RETRY_BASE_MS,
  RETRY_CAP_MS,
  type AppStateLike,
  type AppStateStatus,
  type RefreshOutcome,
  type ResumeStatus,
} from "./resume";

/**
 * KIN-MOBILE-001 R7 — the JS half of background reconnect.
 *
 * The story's 「离开再回来」beats are the contract: coming back after a real
 * absence refreshes and continues from the last applied seq without replay;
 * the reader's place is not thrown away. All waits here are fake timers, so
 * the backoff is measured rather than slept through.
 */

function fakeAppState(): {
  port: AppStateLike;
  emit: (status: AppStateStatus) => void;
  listenerCount: () => number;
  removals: () => number;
} {
  const listeners = new Set<(status: AppStateStatus) => void>();
  let removals = 0;
  return {
    port: {
      addEventListener(_type, listener) {
        listeners.add(listener);
        return {
          remove() {
            removals += 1;
            listeners.delete(listener);
          },
        };
      },
    },
    emit(status) {
      for (const listener of [...listeners]) listener(status);
    },
    listenerCount: () => listeners.size,
    removals: () => removals,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let the promise chain that a timer or an emit started run to rest. */
async function settle(): Promise<void> {
  await jest.advanceTimersByTimeAsync(0);
}

function setup(overrides: {
  refreshList?: () => Promise<RefreshOutcome>;
  resumeStream?: (lastSeq: number) => void | Promise<void>;
  getLastSeq?: () => number;
} = {}) {
  const app = fakeAppState();
  const refreshList = jest.fn<() => Promise<RefreshOutcome>>(
    overrides.refreshList ?? (async () => ({ ok: true })),
  );
  const resumeStream = jest.fn<(lastSeq: number) => void | Promise<void>>(
    overrides.resumeStream ?? (async () => {}),
  );
  const getLastSeq = jest.fn<() => number>(overrides.getLastSeq ?? (() => 0));
  const statuses: ResumeStatus[] = [];
  const controller = createResumeController({
    appState: app.port,
    refreshList,
    resumeStream,
    getLastSeq,
    onStatus: (status) => statuses.push(status),
  });
  return { app, refreshList, resumeStream, getLastSeq, statuses, controller };
}

/** Background for exactly the threshold, then return. */
async function leaveAndReturn(app: ReturnType<typeof fakeAppState>): Promise<void> {
  app.emit("background");
  await jest.advanceTimersByTimeAsync(RESUME_THRESHOLD_MS);
  app.emit("active");
  await settle();
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("KIN-MOBILE-001 R7 resume on foreground", () => {
  it("KIN-MOBILE-001 R7: a return after a long absence refreshes, then resumes from the last applied seq", async () => {
    const { app, refreshList, resumeStream, statuses, controller } = setup({
      getLastSeq: () => 41,
    });

    await leaveAndReturn(app);

    expect(refreshList).toHaveBeenCalledTimes(1);
    expect(resumeStream).toHaveBeenCalledTimes(1);
    expect(resumeStream).toHaveBeenCalledWith(41);
    // Refresh first: the resumed conversation is drawn over a fresh list.
    expect(resumeStream.mock.invocationCallOrder[0]).toBeGreaterThan(
      refreshList.mock.invocationCallOrder[0],
    );
    expect(statuses).toEqual(["resuming", "online"]);
    expect(controller.status()).toBe("online");
  });

  it("KIN-MOBILE-001 R7: a short blip does nothing", async () => {
    const { app, refreshList, resumeStream, statuses, controller } = setup();

    app.emit("inactive");
    await jest.advanceTimersByTimeAsync(RESUME_THRESHOLD_MS - 1);
    app.emit("active");
    await settle();

    expect(refreshList).not.toHaveBeenCalled();
    expect(resumeStream).not.toHaveBeenCalled();
    expect(statuses).toEqual([]);
    expect(controller.status()).toBe("idle");
  });

  it("KIN-MOBILE-001 R7: an inactive-then-background walk starts the absence at the first event", async () => {
    const { app, refreshList } = setup();

    // iOS sends inactive first, then background. Measuring from `background`
    // would shave time off the absence; the controller keeps the first one.
    app.emit("inactive");
    await jest.advanceTimersByTimeAsync(RESUME_THRESHOLD_MS / 2);
    app.emit("background");
    await jest.advanceTimersByTimeAsync(RESUME_THRESHOLD_MS / 2);
    app.emit("active");
    await settle();

    expect(refreshList).toHaveBeenCalledTimes(1);
  });

  it("KIN-MOBILE-001 R7: rapid flapping coalesces into one resume", async () => {
    const gate = deferred<RefreshOutcome>();
    const { app, refreshList, resumeStream } = setup({
      refreshList: () => gate.promise,
    });

    await leaveAndReturn(app);
    expect(refreshList).toHaveBeenCalledTimes(1);

    // A second absence and return while the first refresh is still in flight.
    await leaveAndReturn(app);
    expect(refreshList).toHaveBeenCalledTimes(1);

    gate.resolve({ ok: true });
    await settle();

    expect(refreshList).toHaveBeenCalledTimes(1);
    expect(resumeStream).toHaveBeenCalledTimes(1);
  });

  it("KIN-MOBILE-001 R7: resumes from the seq applied by the time the refresh finished", async () => {
    const gate = deferred<RefreshOutcome>();
    let appliedSeq = 10;
    const { app, resumeStream } = setup({
      refreshList: () => gate.promise,
      getLastSeq: () => appliedSeq,
    });

    app.emit("background");
    await jest.advanceTimersByTimeAsync(RESUME_THRESHOLD_MS);
    app.emit("active");
    await settle();

    // The stream kept appending while the list refresh was in flight.
    appliedSeq = 17;
    gate.resolve({ ok: true });
    await settle();

    expect(resumeStream).toHaveBeenCalledWith(17);
  });
});

describe("KIN-MOBILE-001 R7 reconnect backoff", () => {
  it("KIN-MOBILE-001 R7: a failed refresh backs off, stops at the attempt bound and reports offline", async () => {
    const { app, refreshList, resumeStream, statuses, controller } = setup({
      refreshList: async () => {
        throw new Error("unreachable");
      },
    });

    await leaveAndReturn(app);
    expect(refreshList).toHaveBeenCalledTimes(1);

    // First retry: not before the base delay, exactly at it.
    await jest.advanceTimersByTimeAsync(RETRY_BASE_MS - 1);
    expect(refreshList).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await settle();
    expect(refreshList).toHaveBeenCalledTimes(2);

    // Second retry doubles the wait.
    await jest.advanceTimersByTimeAsync(RETRY_BASE_MS * 2 - 1);
    expect(refreshList).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    await settle();
    expect(refreshList).toHaveBeenCalledTimes(3);

    // Drive every remaining attempt; the bound is what stops the loop.
    for (let i = 0; i < MAX_RESUME_ATTEMPTS; i += 1) {
      await jest.advanceTimersByTimeAsync(RETRY_CAP_MS);
    }

    expect(refreshList).toHaveBeenCalledTimes(MAX_RESUME_ATTEMPTS);
    expect(resumeStream).not.toHaveBeenCalled();
    expect(statuses).toEqual(["resuming", "offline"]);
    expect(controller.status()).toBe("offline");
    expect(jest.getTimerCount()).toBe(0);

    // Nothing is left to fire.
    await jest.advanceTimersByTimeAsync(RETRY_CAP_MS * 2);
    expect(refreshList).toHaveBeenCalledTimes(MAX_RESUME_ATTEMPTS);
  });

  it("KIN-MOBILE-001 R7: a failed stream resume retries and still ends online", async () => {
    let attempts = 0;
    const { app, refreshList, resumeStream, controller } = setup({
      resumeStream: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("socket closed");
      },
    });

    await leaveAndReturn(app);
    expect(resumeStream).toHaveBeenCalledTimes(1);
    expect(controller.status()).toBe("resuming");

    await jest.advanceTimersByTimeAsync(RETRY_BASE_MS);
    await settle();

    expect(resumeStream).toHaveBeenCalledTimes(2);
    expect(refreshList).toHaveBeenCalledTimes(2);
    expect(controller.status()).toBe("online");
  });

  it("KIN-MOBILE-001 R7: an expired token stops immediately instead of retrying", async () => {
    const { app, refreshList, statuses, controller } = setup({
      refreshList: async () => ({ ok: false, reason: "expired" }),
    });

    await leaveAndReturn(app);

    expect(refreshList).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual(["resuming", "expired"]);
    expect(controller.status()).toBe("expired");
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe("KIN-MOBILE-001 R7 dispose and generation guard", () => {
  it("KIN-MOBILE-001 R7: dispose is final — listener removed, retry cleared, no further calls", async () => {
    const { app, refreshList, controller } = setup({
      refreshList: async () => {
        throw new Error("unreachable");
      },
    });

    await leaveAndReturn(app);
    expect(refreshList).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(1);

    controller.dispose();
    expect(app.listenerCount()).toBe(0);
    expect(app.removals()).toBe(1);
    expect(jest.getTimerCount()).toBe(0);

    await jest.advanceTimersByTimeAsync(RETRY_CAP_MS * 10);
    app.emit("background");
    app.emit("active");
    await settle();

    expect(refreshList).toHaveBeenCalledTimes(1);

    // Idempotent: a second dispose does not remove the subscription twice.
    controller.dispose();
    expect(app.removals()).toBe(1);
  });

  it("KIN-MOBILE-001 R7: a refresh that resolves after dispose is ignored", async () => {
    const gate = deferred<RefreshOutcome>();
    const { app, resumeStream, statuses, controller } = setup({
      refreshList: () => gate.promise,
      getLastSeq: () => 5,
    });

    await leaveAndReturn(app);
    expect(statuses).toEqual(["resuming"]);

    controller.dispose();
    gate.resolve({ ok: true });
    await settle();

    expect(resumeStream).not.toHaveBeenCalled();
    expect(statuses).toEqual(["resuming"]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("KIN-MOBILE-001 R7: a refresh that resolves after the session changed is ignored, then the next return resumes", async () => {
    const first = deferred<RefreshOutcome>();
    const refreshList = jest.fn<() => Promise<RefreshOutcome>>(
      () => first.promise,
    );
    const app = fakeAppState();
    const resumeStream = jest.fn<(lastSeq: number) => void | Promise<void>>();
    const statuses: ResumeStatus[] = [];
    const controller = createResumeController({
      appState: app.port,
      refreshList,
      resumeStream,
      getLastSeq: () => 3,
      onStatus: (status) => statuses.push(status),
    });

    await leaveAndReturn(app);
    // The reader switched conversations while the refresh was in flight.
    controller.invalidate();
    expect(statuses).toEqual(["resuming", "idle"]);

    first.resolve({ ok: true });
    await settle();

    expect(resumeStream).not.toHaveBeenCalled();
    expect(statuses).toEqual(["resuming", "idle"]);

    // The listener is still subscribed: a later real return starts fresh.
    refreshList.mockResolvedValue({ ok: true });
    await leaveAndReturn(app);

    expect(refreshList).toHaveBeenCalledTimes(2);
    expect(resumeStream).toHaveBeenCalledTimes(1);
    expect(resumeStream).toHaveBeenCalledWith(3);
    expect(controller.status()).toBe("online");
  });
});
