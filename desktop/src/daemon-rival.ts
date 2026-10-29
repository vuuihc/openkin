/**
 * Wait for a daemon that is already on this machine before starting one.
 *
 * The shell spawns `kin supervise` whenever nothing answers on :7777. On a
 * machine set up as a node (`scripts/install-node-service.sh`), that port
 * belongs to `~/.kin/node/kin supervise --hub`, kept alive by launchd. A
 * rebuild kills the listening child on purpose and launchd brings it back a
 * few seconds later — longer than one health probe waits. Spawning inside that
 * window starts a *second* daemon against the same `~/.kin` database, and macOS
 * lets both listen (the installed node on the IPv6 wildcard, ours on
 * 127.0.0.1), so nothing errors: the desktop console quietly watches a daemon
 * with its own in-memory bus and flags, while the phone keeps talking to the
 * installed node.
 *
 * The signal that a daemon is coming back is its supervisor process, which
 * outlives the child it restarts. So: if a kin daemon process exists, wait for
 * it to answer. A cold machine has none and spawns immediately.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** How long an existing daemon gets to answer before we stop waiting. */
export const RIVAL_WAIT_MS = 15_000;
/** Poll cadence while waiting. */
export const RIVAL_POLL_MS = 500;

export type RivalOutcome =
  /** The existing daemon answers; attach to it. */
  | "healthy"
  /** Nothing is running; spawning is safe. */
  | "none"
  /** A process is there but never answers; do not add a second one. */
  | "stuck";

export type RivalOptions = {
  /** PIDs of kin processes that supervise or serve on this machine. */
  listRivals: () => Promise<number[]>;
  probeHealth: () => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  intervalMs?: number;
};

export async function waitForRivalDaemon(
  opts: RivalOptions,
): Promise<RivalOutcome> {
  const now = opts.now ?? Date.now;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = opts.timeoutMs ?? RIVAL_WAIT_MS;
  const intervalMs = opts.intervalMs ?? RIVAL_POLL_MS;

  if ((await rivals(opts.listRivals)).length === 0) return "none";
  const deadline = now() + timeoutMs;

  for (;;) {
    if (await opts.probeHealth()) return "healthy";
    if ((await rivals(opts.listRivals)).length === 0) return "none";
    if (now() >= deadline) return "stuck";
    await sleep(intervalMs);
  }
}

async function rivals(list: () => Promise<number[]>): Promise<number[]> {
  try {
    return await list();
  } catch {
    // A machine that cannot list processes (or a ps that changed its flags)
    // must not wedge startup: treat it as "nothing to wait for".
    return [];
  }
}

/**
 * `ps -ww -axo pid=,command=` output → PIDs of `kin supervise` / `kin serve`.
 *
 * Matched on the shape of a real invocation — the word `kin` at the start of
 * the command or as the basename of a path, followed by the subcommand — so a
 * search like `rg kin serve` (which this repository invites) is not mistaken
 * for a daemon. The price is that a daemon started through a wrapper
 * (`sh -c "cd x && kin serve"`, `nohup kin serve`) is not recognised; those are
 * rarer here than a grep, and a missed rival costs the old behaviour rather
 * than a new failure.
 */
export function kinDaemonPidsFromPS(
  stdout: string,
  selfPid: number = process.pid,
): number[] {
  const pids: number[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isInteger(pid) || pid === selfPid) continue;
    if (/(?:^|\/)(?:kin|ok)\s+(?:supervise|serve)(?:\s|$)/.test(match[2] ?? "")) {
      pids.push(pid);
    }
  }
  return pids;
}

export async function listKinDaemonPids(): Promise<number[]> {
  // `ps` is not a Windows tool, and the Windows shell is best-effort anyway.
  if (process.platform === "win32") return [];
  // -ww: long binary paths are otherwise truncated, and a truncated path no
  // longer ends in `kin supervise`.
  const { stdout } = await execFileAsync("ps", ["-ww", "-axo", "pid=,command="], {
    timeout: 2000,
  });
  return kinDaemonPidsFromPS(stdout);
}
