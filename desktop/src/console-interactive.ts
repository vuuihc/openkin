/**
 * The moment the console is actually usable.
 *
 * The window's first paint is the shell's own boot surface (`window-ready-to-show`),
 * and `window-first-load` is the console document finishing its load. Neither
 * says React committed a screen: `main.tsx` awaits the Hub/auth probe before
 * it calls `createRoot(...).render(...)`, so there is a stretch where the
 * console document is loaded and the person still sees the splash.
 *
 * The renderer reports its first commit over IPC; this recorder decides
 * whether that report is the one to stamp:
 *
 * - **Only the console document.** The boot page and the window's initial
 *   about:blank share the window's preload and could report too.
 * - **Only once per launch.** A reload would otherwise emit a second mark, and
 *   the startup runner requires every mark exactly once.
 *
 * Stamped in the main process on purpose: `traceStartup` uses the same clock
 * as every other mark, while the renderer's `performance.now()` is relative to
 * its own document and could not be subtracted from `sidecar-ready`.
 *
 * Pure: `trace` and `isConsoleURL` are injected, so `node --test` holds the
 * rules without Electron.
 */
export type ConsoleInteractiveDeps = {
  trace: (name: string) => void;
  isConsoleURL: (url: string) => boolean;
};

/** Returns whether this call was the one that stamped the mark. */
export function createConsoleInteractiveRecorder(
  deps: ConsoleInteractiveDeps,
): (senderUrl: string) => boolean {
  let marked = false;
  return (senderUrl: string): boolean => {
    if (marked) return false;
    if (!deps.isConsoleURL(senderUrl)) return false;
    // Set before tracing: the mark is once per launch even if the writer were
    // to throw, and callers get `false` for every later report.
    marked = true;
    deps.trace("console-interactive");
    return true;
  };
}
