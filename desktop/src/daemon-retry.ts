/**
 * Keep asking for a daemon that is not there yet.
 *
 * The shell asks once at startup, and that wait already covers a supervisor
 * restart longer than one health probe (see daemon-rival.ts). What it does not
 * cover is a restart longer than the whole wait: the 8.6 s measured on this
 * machine is not a bound, and a cold install or a busy machine is slower. When
 * that happens the status is "unavailable" and nothing else in the shell ever
 * asks again — the window sits on a dead URL until the person clicks Start or
 * restarts Kin. So that state gets a slow retry instead of being an ending.
 *
 * Each attempt is one process listing and one health probe, so the cadence is
 * deliberately slow, and the bound keeps a machine with no daemon installed
 * from probing forever. A state something else resolved — the person clicked
 * Start, or Stop, or the shell is quitting — ends the loop without touching it.
 */

export const DAEMON_RETRY_INTERVAL_MS = 15_000;
export const DAEMON_RETRY_ATTEMPTS = 20;

export type DaemonRetryOutcome =
  /** A later attempt found (or started) a daemon. */
  | "ready"
  /** Something else changed the state; leave it alone. */
  | "resolved"
  /** The attempts ran out with the daemon still unavailable. */
  | "gave-up";

export type DaemonRetryOptions = {
  /** Asks the sidecar to start or attach; returns its status afterwards. */
  ensureRunning: () => Promise<{ state: string }>;
  /** True when the state is no longer "unavailable" for another reason. */
  resolved?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
  intervalMs?: number;
};

export async function retryWhileUnavailable(
  opts: DaemonRetryOptions,
): Promise<DaemonRetryOutcome> {
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts = opts.attempts ?? DAEMON_RETRY_ATTEMPTS;
  const intervalMs = opts.intervalMs ?? DAEMON_RETRY_INTERVAL_MS;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // Sleep first: the caller has just watched one attempt fail, and a daemon
    // that is coming back needs the time more than it needs another probe.
    await sleep(intervalMs);
    if (opts.resolved?.()) return "resolved";
    let status: { state: string };
    try {
      status = await opts.ensureRunning();
    } catch {
      // A transient failure is another attempt, not the end of recovery.
      continue;
    }
    if (status.state !== "unavailable") return "ready";
  }
  return "gave-up";
}
