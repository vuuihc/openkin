export const TERMINAL_HEIGHT_KEY = "kin_terminal_height";
export const MIN_TERMINAL_HEIGHT = 180;
export const DEFAULT_TERMINAL_HEIGHT = 320;
export const MAX_TERMINAL_VIEWPORT_RATIO = 0.7;

export function maxTerminalHeight(viewportHeight: number): number {
  return Math.max(
    MIN_TERMINAL_HEIGHT,
    Math.floor(viewportHeight * MAX_TERMINAL_VIEWPORT_RATIO),
  );
}

export function clampTerminalHeight(
  height: number,
  viewportHeight: number,
): number {
  return Math.max(
    MIN_TERMINAL_HEIGHT,
    Math.min(height, maxTerminalHeight(viewportHeight)),
  );
}

/**
 * Check if a keyboard event is Ctrl+Backquote to toggle the terminal.
 * Uses event.code to be keyboard-layout independent.
 */
export function isTerminalToggle(e: KeyboardEvent): boolean {
  if (e.repeat) return false;
  // Ctrl+Backquote only. Meta+Backquote (macOS Cmd+`) is the OS window-cycle
  // shortcut and must not be hijacked, so metaKey is deliberately rejected.
  return e.ctrlKey && !e.metaKey && e.code === "Backquote";
}

/**
 * Parse terminal panel height from storage, apply defaults and clamps.
 * @param storedValue - The string from localStorage
 * @param viewportHeight - Current window height in pixels
 * @returns Clamped height in pixels
 */
export function parseTerminalHeight(
  storedValue: string | null,
  viewportHeight: number,
): number {
  if (!storedValue) {
    return clampTerminalHeight(DEFAULT_TERMINAL_HEIGHT, viewportHeight);
  }

  const parsed = Number(storedValue);
  if (!Number.isFinite(parsed)) {
    return clampTerminalHeight(DEFAULT_TERMINAL_HEIGHT, viewportHeight);
  }
  return clampTerminalHeight(parsed, viewportHeight);
}

/**
 * Determine the working directory for a new terminal session.
 * Prefers: selected task cwd > draft cwd > empty
 */
export function contextCwd(
  selectedTaskCwd: string | undefined,
  draftCwd: string,
): string {
  if (selectedTaskCwd) return selectedTaskCwd;
  return draftCwd;
}

/**
 * The directory a local shell should start in for the page currently open.
 *
 * The terminal is a shell on *this* machine. A task dispatched to another
 * machine carries a cwd that exists on that machine's filesystem, so using it
 * here would open a same-named local directory and quietly suggest the remote
 * work is happening under it. In that case the draft cwd (or nothing) is the
 * honest answer, and the panel explains why.
 */
export function localTerminalCwd(
  task: { cwd?: string; executing_device_id?: string } | null | undefined,
  runsElsewhere: boolean,
  draftCwd: string,
): string {
  return contextCwd(runsElsewhere ? undefined : task?.cwd, draftCwd);
}

/** A route-derived cwd supersedes a folder chosen only for the terminal panel. */
export function effectiveTerminalCwd(
  routeCwd: string,
  panelOverride: string | null,
): string {
  return routeCwd || panelOverride || "";
}

/**
 * Build a WebSocket URL for terminal session streaming.
 * @param protocol - window.location.protocol (either "http:" or "https:")
 * @param host - window.location.host
 * @param sessionId - Terminal session ID to stream from
 * @param token - Kin auth token
 * @returns ws:// or wss:// URL with encoded token and session ID
 */
export function terminalSocketURL(
  protocol: string,
  host: string,
  sessionId: string,
  token: string,
): string {
  const wsProtocol = protocol === "https:" ? "wss:" : "ws:";
  const encodedSessionId = encodeURIComponent(sessionId);
  const encodedToken = encodeURIComponent(token);
  return `${wsProtocol}//${host}/api/terminal/sessions/${encodedSessionId}/ws?token=${encodedToken}`;
}
