/**
 * When the shell announces that a task finished.
 *
 * The shell exists to tell you about work you are not looking at. A banner for
 * the task whose transcript is on screen, in the focused window, says nothing
 * the screen does not already say — and dogfooding runs a task precisely to
 * watch it end. Any other finished task still earns its banner: Kin being in
 * front does not mean the reader is looking at *that* task.
 */

const TERMINAL = new Set(["succeeded", "failed", "canceled"]);

export function isTerminalStatus(status: string): boolean {
  return TERMINAL.has(status);
}

/**
 * The task a console URL points at: `/tasks/<id>`, or null for anything else.
 *
 * A deliberate duplicate of the console's `taskIdFromPathname`
 * (ui/src/lib/sessionCache.ts): this runs in the main process and cannot import
 * the SPA bundle. The one difference is a malformed escape — the console keeps
 * the raw text, and a URL that cannot be decoded here names no task a window
 * could open.
 */
export function taskIdFromURL(url: string): string | null {
  try {
    const match = /^\/tasks\/([^/]+)\/?$/.exec(new URL(url).pathname);
    return match ? decodeURIComponent(match[1] ?? "") : null;
  } catch {
    return null;
  }
}

export function shouldAnnounceTask(
  task: { id: string; status: string },
  view: { focused: boolean; viewingTaskId: string | null },
): boolean {
  if (!isTerminalStatus(task.status)) return false;
  return !(view.focused && view.viewingTaskId === task.id);
}
