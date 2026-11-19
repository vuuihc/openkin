/**
 * The window opens before the daemon answers.
 *
 * The launch used to be daemon-gated: `main.ts` awaited `sidecar.ensureRunning()`
 * and only then showed a window, so a person saw nothing for as long as the
 * daemon took — and on a daemon that never came up, an error page or no window
 * at all. The window is the thing they asked for; it can go up first, showing a
 * wordless boot surface, and the console replaces it in place once the daemon
 * settles.
 *
 * This module owns the decision, not the window: `boot-window.ts` never imports
 * electron and its host is injected, so `node --test` can prove the order. The
 * rules, in one place:
 *
 * - foreground launch → boot surface now, before the daemon is awaited
 * - background launch (login item, `--hidden`) → no window at all
 * - daemon ready → the console loads exactly once, at the deep-link path or `/`
 * - daemon unavailable → keep the boot surface; the recovery retry settles again
 * - the retry gives up → the boot surface becomes a worded failure page, once
 * - a window asked for during boot (tray, dock, deep link) → the same boot
 *   surface, never a second window and never an early console load
 *
 * `main.ts` calls `ensureRunning()` itself; `settle()` is that promise's answer,
 * so a slow first start and a later recovery retry are the same edge here.
 * `fail()` is the retry's other ending: five minutes of silence is terminal
 * for the launch surface, but a recovery can still replace it with the console.
 */

import type { FailureReason } from "./boot-failure";

export type BootWindowHost = {
  /** True while the shell already has a window on screen. */
  hasWindow: () => boolean;
  /** Put the boot surface on screen at `path` (create the window if needed). */
  showBoot: (path: string) => void;
  /** Put the console on screen at `path` (replace the boot page in place). */
  showConsole: (path: string) => void;
  /** Replace the boot surface with the worded failure page, once. */
  showBootFailure: (reason: FailureReason) => void;
  /** Bring the existing window forward without loading a page. */
  reveal: () => void;
};

export type BootPhase =
  | "idle"
  | "booting"
  | "background"
  | "unavailable"
  | "ready"
  | "failed";

export type BootLaunch = {
  /** Login item or `--hidden`: idle in the tray, no window. */
  background?: boolean;
  /** A deep link that arrived before the window existed. */
  deepLinkPath?: string | null;
};

export type BootWindowCoordinator = {
  readonly phase: BootPhase;
  /** Start the launch. Idempotent: a second call keeps the first decision. */
  start: (launch?: BootLaunch) => void;
  /** The daemon status settled — the first answer or a recovery retry. */
  settle: (outcome: "ready" | "unavailable") => void;
  /** The recovery retry ran out: say why, once. Ready is never undone. */
  fail: (reason: FailureReason) => void;
  /** Someone asked for the window (tray, dock, deep link, second instance). */
  show: (path?: string) => void;
};

/** A console path, or null for "whatever is already pending" (`/` restores). */
function explicitPath(path: string | null | undefined): string | null {
  if (path == null || path === "" || path === "/") return null;
  return path.startsWith("/") ? path : `/${path}`;
}

export function createBootWindow(host: BootWindowHost): BootWindowCoordinator {
  let phase: BootPhase = "idle";
  /** Where the console will land: the deep link, the last explicit show, or `/`. */
  let target = "/";
  /** The boot surface is asked for once per launch, however many callers ask. */
  let bootShown = false;
  /** Why the retry gave up, once `fail` has run. */
  let failedReason: FailureReason | null = null;
  /** The failure page has been asked for (it may still be pending in the tray). */
  let failureShown = false;

  function remember(path: string | null | undefined): void {
    const next = explicitPath(path);
    if (next) target = next;
  }

  function showFailureOnce(): void {
    if (failureShown || failedReason == null) return;
    failureShown = true;
    host.showBootFailure(failedReason);
  }

  function showBootOnce(): void {
    if (bootShown) {
      // Already created; a later ask only has to bring it back (close-to-tray
      // hides the window, it does not destroy it).
      if (host.hasWindow()) host.reveal();
      return;
    }
    bootShown = true;
    host.showBoot(target);
  }

  return {
    get phase() {
      return phase;
    },

    start(launch = {}) {
      // A deep link beats a later generic show; record it even if an early
      // caller already put the boot surface up.
      remember(launch.deepLinkPath);
      if (phase !== "idle") return;
      if (launch.background) {
        phase = "background";
        return;
      }
      phase = "booting";
      showBootOnce();
    },

    settle(outcome) {
      if (outcome === "unavailable") {
        // The boot surface stays; nothing loads a URL that nothing answers.
        // The recovery retry settles again when a daemon appears.
        if (phase === "booting" || phase === "background") phase = "unavailable";
        return;
      }
      if (phase === "ready") return; // exactly once
      if (phase === "idle") return; // no launch ran; nothing to replace
      if (phase === "failed") {
        // A daemon finally answered after the retry gave up: the failure page
        // is replaced by the console exactly once, like any other recovery.
        phase = "ready";
        failedReason = null;
        failureShown = false;
        // A background failure nobody has looked at stays in the menu bar; the
        // next show() opens the console directly.
        if (!bootShown && !host.hasWindow()) return;
        host.showConsole(target);
        return;
      }
      if (phase === "unavailable") phase = "booting";
      phase = "ready";
      // A launch nobody asked to see — background with no tray open — stays in
      // the menu bar. The next show() opens the console directly.
      if (!bootShown && !host.hasWindow()) return;
      host.showConsole(target);
    },

    fail(reason) {
      // Ready is never undone, and a launch that never ran has no surface to
      // replace. Repeated give-ups are one failure.
      if (phase === "ready" || phase === "idle" || phase === "failed") return;
      const pending = !bootShown && !host.hasWindow();
      phase = "failed";
      failedReason = reason;
      // A background launch stays in the tray; the failure is remembered and
      // the next show() opens the failure page, never the spinner.
      if (pending) return;
      showFailureOnce();
    },

    show(path) {
      const next = explicitPath(path);
      if (next) target = next;
      if (phase === "failed") {
        // A terminal failure must not animate progress. The page is loaded
        // once; asking again only brings it back (or recreates a closed
        // window, which is not the same page on screen twice).
        if (failureShown && host.hasWindow()) {
          host.reveal();
          return;
        }
        failureShown = false;
        showFailureOnce();
        return;
      }
      if (phase === "ready") {
        // Already on the console: an explicit path navigates, while `/` only
        // brings the window forward. Passing the remembered target here would
        // drag the person back to wherever the launch landed.
        if (next) host.showConsole(next);
        else if (host.hasWindow()) host.reveal();
        else host.showConsole(target);
        return;
      }
      // Idle, booting, background or unavailable: the person asked for Kin, so
      // the boot surface goes up — once — and the console waits for the daemon.
      if (phase === "idle" || phase === "background") phase = "booting";
      showBootOnce();
    },
  };
}
