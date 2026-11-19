import { useEffect } from "react";

/**
 * Tell the desktop shell the console has committed its first screen.
 *
 * The shell turns this report into the `console-interactive` startup mark — the
 * moment the person stops looking at the boot splash. Reporting is all this
 * side does: the shell owns the clock, the once-per-launch rule and the URL
 * check, so a reload or a second report changes nothing there.
 *
 * The bridge is optional by design: the same console runs in a plain browser,
 * on the phone, and in an older shell with no listener. Absence is a no-op,
 * and a bridge that throws must never take the console down.
 */
export function markConsoleInteractive(): void {
  try {
    window.kinDesktop?.markConsoleInteractive?.();
  } catch {
    // A measurement is a courtesy; the console never depends on it.
  }
}

/**
 * Marks the console interactive once React has committed its first screen.
 *
 * This is an effect, not a render-time call or a timer: the report is only
 * true after the tree that replaced the splash is on screen. StrictMode runs
 * the effect twice in development, which is harmless — the shell's recorder
 * stamps at most one mark per launch.
 */
export function ConsoleReady(): null {
  useEffect(() => {
    markConsoleInteractive();
  }, []);
  return null;
}
