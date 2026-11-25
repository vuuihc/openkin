/**
 * KIN-MOBILE-001 R7 — background/foreground resume and reconnect, JS half.
 *
 * The story's 「离开再回来」beat asks for three things when the app comes back:
 * the list refreshes, the open conversation continues from the last applied
 * seq (no replay), and the reader is not thrown to the top. The native half of
 * R7 (push, glass bar) is a separate slice; what is testable without a device
 * is this policy.
 *
 * Every dependency is injected — the AppState emitter, the list refresh and
 * the stream resume — so the module imports neither `react-native` nor a
 * browser global and its tests need no renderer. It owns only the rules:
 *
 *   - a return after a real absence (≥ RESUME_THRESHOLD_MS) resumes once; a
 *     glance at a notification does nothing;
 *   - overlapping returns coalesce: while one resume is in flight or waiting
 *     to retry, another `active` does not start a second one;
 *   - a failed refresh retries with capped exponential backoff for a bounded
 *     number of attempts, then reports `offline` instead of looping;
 *   - from `offline`, the reader gets exactly one manual `retry()` per press,
 *     which starts the same bounded series again;
 *   - an answer that lands after `dispose()` or `invalidate()` is dropped
 *     (AGENTS.md rule 11), and every retry timer is cleared by both.
 *
 * The injected `refreshList` owns its own network bound (the transport's
 * `timeoutMs`); the controller bounds the waiting it creates itself.
 */

export type AppStateStatus =
  | "active"
  | "background"
  | "inactive"
  | "unknown"
  | "extension";

export type AppStateSubscription = { remove(): void };

/**
 * The slice of React Native's `AppState` this controller reads. RN's
 * `addEventListener("change", …)` returns a subscription with `remove()`, so
 * the real module satisfies this without an adapter.
 */
export type AppStateLike = {
  addEventListener(
    type: "change",
    listener: (status: AppStateStatus) => void,
  ): AppStateSubscription;
};

/**
 * What a refresh reports back. A transport result (`{ ok, reason }`) is
 * assignable directly, and `void` means a fire-and-forget refresh succeeded.
 * A rejected promise is a failure too.
 */
export type RefreshOutcome = { ok: boolean; reason?: string } | void;

export type ResumeStatus = "idle" | "resuming" | "online" | "offline" | "expired";

export type ResumeControllerOptions = {
  appState: AppStateLike;
  /** Refresh the list the reader is on. Must be safe to call repeatedly. */
  refreshList: () => Promise<RefreshOutcome>;
  /**
   * Continue the open conversation's stream after `lastSeq`. Called only
   * after a successful refresh, with the seq applied at that moment, so no
   * event the reader already saw is replayed. Omitted when no stream is open
   * (the list route): a good refresh then settles `online` on its own.
   */
  resumeStream?: (lastSeq: number) => void | Promise<void>;
  /** The open conversation's last applied seq; 0 when nothing is open. */
  getLastSeq: () => number;
  /** Status transitions, for the screen's reconnect banner. */
  onStatus?: (status: ResumeStatus) => void;
  /** Test seam; production uses the platform clock. */
  now?: () => number;
};

export type ResumeController = {
  status(): ResumeStatus;
  /**
   * The reader's one manual retry after the bounded series gave up
   * (`offline`). Starts a fresh series at attempt 1 under a new generation,
   * so the old answer is dropped and the new series is capped like any other.
   * A no-op in every other state: while resuming, online, expired, or after
   * `invalidate()`/`dispose()`.
   */
  retry(): void;
  /**
   * Drop an in-flight resume because the screen now shows a different
   * conversation or session. The listener stays subscribed; the next long
   * return starts a fresh generation.
   */
  invalidate(): void;
  /**
   * Final: removes the AppState listener, clears any pending retry, and drops
   * every late answer. Idempotent.
   */
  dispose(): void;
};

/** A glance at a notification is not a return; half a minute is. */
export const RESUME_THRESHOLD_MS = 30_000;

/** Initial and total attempts: 1 + 12 retries, then `offline`. */
export const MAX_RESUME_ATTEMPTS = 13;

export const RETRY_BASE_MS = 1_000;
export const RETRY_CAP_MS = 30_000;

export function createResumeController(
  options: ResumeControllerOptions,
): ResumeController {
  const now = options.now ?? Date.now;

  let disposed = false;
  let generation = 0;
  let running = false;
  let leftForegroundAt: number | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let status: ResumeStatus = "idle";

  const report = (next: ResumeStatus): void => {
    if (disposed || next === status) return;
    status = next;
    options.onStatus?.(next);
  };

  const clearRetry = (): void => {
    if (retryTimer === null) return;
    clearTimeout(retryTimer);
    retryTimer = null;
  };

  /** True when this attempt still describes what the screen is showing. */
  const current = (mine: number): boolean => !disposed && mine === generation;

  const settle = (next: ResumeStatus): void => {
    running = false;
    report(next);
  };

  const fail = (mine: number, attempt: number, reason?: string): void => {
    if (!current(mine)) return;
    // An expired token is not a network blip; retrying cannot fix it and the
    // story forbids silently retrying one. The screen signs the reader out.
    if (reason === "expired") {
      settle("expired");
      return;
    }
    if (attempt >= MAX_RESUME_ATTEMPTS) {
      settle("offline");
      return;
    }
    const delay = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_CAP_MS);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!current(mine)) return;
      void attemptResume(mine, attempt + 1);
    }, delay);
  };

  const attemptResume = async (mine: number, attempt: number): Promise<void> => {
    let outcome: RefreshOutcome;
    try {
      outcome = await options.refreshList();
    } catch {
      fail(mine, attempt);
      return;
    }
    if (!current(mine)) return;
    if (outcome && !outcome.ok) {
      fail(mine, attempt, outcome.reason);
      return;
    }

    // The list route has no open stream, so there is nothing to continue and
    // no cursor to read; the refresh alone decides the outcome.
    if (options.resumeStream) {
      try {
        // Read the cursor after the refresh: a stream that appended while it
        // was in flight raised it, and resuming from the older value would
        // replay. A getter that cannot answer is a failed attempt, not a crash.
        await options.resumeStream(options.getLastSeq());
      } catch {
        fail(mine, attempt);
        return;
      }
      if (!current(mine)) return;
    }
    settle("online");
  };

  const onChange = (next: AppStateStatus): void => {
    if (disposed) return;

    if (next === "background" || next === "inactive") {
      // iOS walks inactive → background; the absence starts when the app
      // first left the foreground, not at the last of the two events.
      if (leftForegroundAt === null) leftForegroundAt = now();
      return;
    }
    if (next !== "active") return;

    const leftAt = leftForegroundAt;
    leftForegroundAt = null;
    if (leftAt === null) return;
    // One resume at a time: a return that arrives while a refresh is still in
    // flight (or waiting to retry) joins it instead of starting a second.
    if (running) return;
    if (now() - leftAt < RESUME_THRESHOLD_MS) return;

    running = true;
    const mine = generation;
    report("resuming");
    void attemptResume(mine, 1);
  };

  const subscription = options.appState.addEventListener("change", onChange);

  return {
    status: () => status,

    retry(): void {
      if (disposed) return;
      // Only the bounded series' give-up is retryable: an in-flight series
      // already owns the attempts, and an expired token cannot be fixed by
      // trying again. The reader's press starts a fresh, equally bounded run.
      if (status !== "offline") return;
      clearRetry();
      generation += 1;
      running = true;
      report("resuming");
      void attemptResume(generation, 1);
    },

    invalidate(): void {
      if (disposed) return;
      generation += 1;
      running = false;
      clearRetry();
      report("idle");
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      generation += 1;
      running = false;
      clearRetry();
      subscription.remove();
    },
  };
}
