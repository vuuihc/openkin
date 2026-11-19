/**
 * The shell's first conversation with a daemon: ask whether one answers, give
 * a daemon that is already on the machine its chance, otherwise spawn one and
 * poll until it answers.
 *
 * The order is the point. Everything here sits between Electron starting and
 * `sidecar.ensureRunning()` resolving, and the window is only shown after that
 * — so every step that is not the daemon is a step the person waits through:
 *
 * - **Health first.** One GET to loopback answers whether anything is up. The
 *   expected-version label needs a whole `kin version` process, and nothing
 *   about the decision needs it; running that process in front of the probe
 *   made the shell pay for its own handshake before asking the question.
 * - **Ask often.** A spawning daemon is polled at `HEALTH_POLL_MS`, the same
 *   50 ms cadence `scripts/startup-baseline.sh` uses, so the readiness edge is
 *   the daemon's boot plus at most one poll instead of a quarter second.
 * - **Labels are bounded.** The version strings are cosmetic — a mismatch
 *   warning and a status label. One that never arrives must not hold the
 *   result, so each gets at most `LABEL_WAIT_MS` once health answers.
 *
 * The rival-daemon wait is not this module's invention: `waitForRival` is
 * injected and carries `daemon-rival.ts`'s safety rule — a kin process on this
 * machine gets its chance to answer before a second daemon is started.
 *
 * Pure by construction: every side effect (probe, spawn, versions, clock) is a
 * parameter, so `daemon-handshake.test.ts` can hold the order and the cadence
 * without Electron.
 */

import type { RivalOutcome } from "./daemon-rival.ts";

/** How often a spawning daemon is asked whether it answers yet. */
export const HEALTH_POLL_MS = 50;

/** How long a freshly spawned daemon gets to answer health. */
export const HEALTH_TIMEOUT_MS = 15_000;

/** How long a cosmetic version label may hold the result after health. */
export const LABEL_WAIT_MS = 250;

export type SpawnResult =
  | { ok: true; pid: number }
  | { ok: false; reason: string };

export type HandshakeOptions = {
  /** One GET /api/health; false for a refused connection or a bad answer. */
  probeHealth: () => Promise<boolean>;
  /** `kin version` — a whole process, so it starts beside the probe, never in front. */
  binaryVersion: () => Promise<string | null>;
  /** One GET /api/version. */
  probeVersion: () => Promise<string | null>;
  /** True when this shell already owns a child (its exit is handled elsewhere). */
  ownsChild: () => boolean;
  /** The rival-daemon wait; see daemon-rival.ts. */
  waitForRival: () => Promise<RivalOutcome>;
  /** Why a stuck rival means no spawn; carried into the unavailable outcome. */
  stuckReason: string;
  /** Starts the daemon. Reports failure as a reason rather than throwing. */
  spawn: () => SpawnResult;
  /** False once this attempt was superseded (quit, Stop, child exit). */
  isCurrent?: () => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  healthTimeoutMs?: number;
  labelWaitMs?: number;
};

export type HandshakeOutcome =
  /** A daemon was already answering; attach to it. */
  | { state: "external"; version: string; expected: string | null }
  /** This shell spawned a daemon and it answered health. */
  | { state: "spawned"; version: string; pid: number }
  /** A spawned daemon never answered within `healthTimeoutMs`. */
  | { state: "unhealthy" }
  /** Nothing could be started, or a rival process would not answer. */
  | { state: "unavailable"; reason: string }
  /** The caller moved on while this was in flight; leave its state alone. */
  | { state: "superseded" };

export async function bringUpDaemon(
  opts: HandshakeOptions,
): Promise<HandshakeOutcome> {
  const now = opts.now ?? Date.now;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const current = opts.isCurrent ?? (() => true);
  const pollMs = opts.pollMs ?? HEALTH_POLL_MS;
  const healthTimeoutMs = opts.healthTimeoutMs ?? HEALTH_TIMEOUT_MS;
  const labelWaitMs = opts.labelWaitMs ?? LABEL_WAIT_MS;

  // The cheapest question first: is a daemon already answering? This used to
  // sit behind a `kin version` exec, which cost more than the answer.
  let healthy = await opts.probeHealth();
  if (!current()) return { state: "superseded" };

  // The label is only ever a warning or a status string. Start it now — it is
  // a process, and the daemon work below gives it time — and await it only
  // after health answers.
  const expected = labelled(opts.binaryVersion());

  if (!healthy && !opts.ownsChild()) {
    const outcome = await opts.waitForRival();
    if (!current()) return { state: "superseded" };
    if (outcome === "stuck") {
      return { state: "unavailable", reason: opts.stuckReason };
    }
    healthy = outcome === "healthy";
  }

  if (healthy) {
    // Health just answered, so this request can go out now and overlap with
    // the expected-version label instead of following it.
    const running = labelled(opts.probeVersion());
    const [version, expectedVersion] = await Promise.all([
      within(running, null, labelWaitMs, sleep),
      within(expected, null, labelWaitMs, sleep),
    ]);
    if (!current()) return { state: "superseded" };
    return {
      state: "external",
      version: version ?? "unknown",
      expected: expectedVersion,
    };
  }

  if (!current()) return { state: "superseded" };
  const spawned = opts.spawn();
  if (!spawned.ok) return { state: "unavailable", reason: spawned.reason };

  const wait = await waitForHealth(opts.probeHealth, opts.probeVersion, {
    now,
    sleep,
    pollMs,
    healthTimeoutMs,
    current,
  });
  if (wait.state === "superseded") return { state: "superseded" };
  if (wait.state === "timeout") return { state: "unhealthy" };

  // `wait.version` was started the moment health answered; the expected label
  // has had the daemon's whole boot to finish.
  const [version, expectedVersion] = await Promise.all([
    within(wait.version, null, labelWaitMs, sleep),
    within(expected, null, labelWaitMs, sleep),
  ]);
  if (!current()) return { state: "superseded" };
  return {
    state: "spawned",
    version: version ?? expectedVersion ?? "unknown",
    pid: spawned.pid,
  };
}

type HealthWait =
  /** Health answered; the version request is already in flight. */
  | { state: "healthy"; version: Promise<string | null> }
  | { state: "timeout" }
  | { state: "superseded" };

async function waitForHealth(
  probeHealth: () => Promise<boolean>,
  probeVersion: () => Promise<string | null>,
  o: {
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    pollMs: number;
    healthTimeoutMs: number;
    current: () => boolean;
  },
): Promise<HealthWait> {
  const deadline = o.now() + o.healthTimeoutMs;
  while (o.now() < deadline) {
    if (await probeHealth()) {
      // Start the version request at the instant health answers: it is one
      // loopback round trip, not another edge after the poll.
      return { state: "healthy", version: labelled(probeVersion()) };
    }
    if (!o.current()) return { state: "superseded" };
    await o.sleep(o.pollMs);
  }
  return o.current() ? { state: "timeout" } : { state: "superseded" };
}

/** Never let a label's failure become an unhandled rejection. */
function labelled(p: Promise<string | null>): Promise<string | null> {
  return p.catch(() => null);
}

/** The label wins if it arrives within `ms`; otherwise the fallback does. */
function within(
  p: Promise<string | null>,
  fallback: string | null,
  ms: number,
  sleep: (ms: number) => Promise<void>,
): Promise<string | null> {
  return Promise.race([p, sleep(ms).then(() => fallback)]);
}
