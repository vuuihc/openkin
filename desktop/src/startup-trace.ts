/**
 * Desktop startup marks, readable from outside the shell.
 *
 * `KIN_STARTUP_TRACE=1` prints one line per boot mark on stdout:
 *
 *   [kin-desktop] trace window-ready-to-show 1460
 *
 * The daemon has the same switch (internal/server/startup_trace.go); together
 * they turn "the app takes seconds to open" into per-edge numbers without a
 * profiler. A launcher that knows when it spawned Electron exports that
 * instant as KIN_STARTUP_ORIGIN_MS, so the first mark covers process creation,
 * dyld and Electron's own init instead of starting the clock inside the app.
 *
 * It measures; it never changes the boot. Off is a cached boolean, one mark is
 * one comparison, and a broken log stream is swallowed — a closed stdout pipe
 * must not take the shell down.
 *
 * This module must not import electron: `node --test` loads it directly.
 */
export type TraceEnv = Record<string, string | undefined>;

const TRACE_ENV = "KIN_STARTUP_TRACE";
const ORIGIN_ENV = "KIN_STARTUP_ORIGIN_MS";

/** How old an exported origin may be before it is a leftover, not this launch. */
export const STARTUP_TRACE_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * The launcher's origin, or `now` when it is missing, unparseable, in the
 * future, or older than ten minutes. An implausible value must never invent
 * minutes of startup or a negative first mark.
 */
export function resolveStartupOrigin(env: TraceEnv, now: number): number {
  const raw = env[ORIGIN_ENV];
  if (raw === undefined || raw === "") return now;
  if (!/^-?\d+$/.test(raw)) return now;
  const origin = Number(raw);
  if (!Number.isSafeInteger(origin)) return now;
  const age = now - origin;
  if (age < 0 || age > STARTUP_TRACE_MAX_AGE_MS) return now;
  return origin;
}

/** The one trace line for a mark, without its newline. */
export function formatMark(name: string, ms: number): string {
  return `[kin-desktop] trace ${name} ${ms}`;
}

/**
 * Build a mark function over an explicit environment, clock and writer. The
 * env is read once; when tracing is off the returned function does nothing.
 */
export function createStartupTrace(
  env: TraceEnv,
  now: () => number,
  write: (line: string) => void,
): (name: string) => void {
  const enabled = env[TRACE_ENV] === "1";
  const origin = enabled ? resolveStartupOrigin(env, now()) : now();
  if (!enabled) return () => {};
  return (name: string) => {
    const ms = Math.max(0, Math.floor(now() - origin));
    try {
      write(formatMark(name, ms));
    } catch {
      /* logging is never fatal */
    }
  };
}

let cached: ((name: string) => void) | null = null;

/** Record one startup mark. No-op unless KIN_STARTUP_TRACE=1. */
export function traceStartup(name: string): void {
  cached ??= createStartupTrace(process.env, Date.now, (line) => {
    process.stdout.write(`${line}\n`);
  });
  cached(name);
}
