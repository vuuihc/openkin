import { spawn, type ChildProcess, execFile } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { promisify } from "node:util";
import {
  DAEMON_BASE,
  DAEMON_PORT,
  STATE_DIR,
  TOKEN_PATH,
  kinBinaryPath,
  isDev,
} from "./config";
import { listKinDaemonPids, waitForRivalDaemon } from "./daemon-rival";
import {
  bringUpDaemon,
  type HandshakeOutcome,
  type SpawnResult,
} from "./daemon-handshake";

const execFileAsync = promisify(execFile);

/**
 * `kin serve`'s exit status when another daemon owns this machine's state
 * directory (EX_TEMPFAIL, shared with cmd/kin). It is not a crash: the state
 * directory, and with it the phone's daemon, belongs to that other process.
 */
const STATE_DIR_BUSY_EXIT = 75;

export type SidecarStatus =
  | { state: "external"; version: string }
  | { state: "spawned"; version: string; pid: number }
  | { state: "restarting"; reason: string; attempt: number }
  | { state: "unavailable"; reason: string };

export class Sidecar {
  private child: ChildProcess | null = null;
  private weStarted = false;
  private status: SidecarStatus = { state: "unavailable", reason: "not started" };
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private restartAttempt = 0;
  private stopping = false;
  private ensurePromise: Promise<SidecarStatus> | null = null;
  private generation = 0;

  get weOwnProcess(): boolean {
    return this.weStarted;
  }

  /**
   * True when the last thing to touch the daemon was Stop (or quit), not a
   * failed start. A background recovery must not undo that.
   */
  get isStopped(): boolean {
    return this.stopping;
  }

  get current(): SidecarStatus {
    return this.status;
  }

  readToken(): string | null {
    try {
      if (!existsSync(TOKEN_PATH)) return null;
      const tok = readFileSync(TOKEN_PATH, "utf8").trim();
      return tok || null;
    } catch {
      return null;
    }
  }

  /** Expected binary version via `kin version`. */
  async binaryVersion(): Promise<string | null> {
    const bin = kinBinaryPath();
    if (!existsSync(bin)) return null;
    try {
      const { stdout } = await execFileAsync(bin, ["version"], { timeout: 5000 });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  async probeHealth(): Promise<boolean> {
    try {
      const res = await fetch(`${DAEMON_BASE}/api/health`, {
        signal: AbortSignal.timeout(1500),
      });
      if (!res.ok) return false;
      const body = (await res.json()) as { ok?: boolean };
      return body.ok === true;
    } catch {
      return false;
    }
  }

  async probeVersion(): Promise<string | null> {
    try {
      const res = await fetch(`${DAEMON_BASE}/api/version`, {
        signal: AbortSignal.timeout(1500),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { version?: string };
      return body.version ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Ensure a daemon is reachable.
   * If one is already up with a matching version, attach without spawning.
   * If up with a different version, attach anyway (do not kill foreign daemons)
   * and log a warning — port conflict would make a second spawn fail.
   * If down, spawn our binary.
   */
  async ensureRunning(): Promise<SidecarStatus> {
    if (this.ensurePromise) return this.ensurePromise;
    const pending = this.ensureRunningOnce();
    this.ensurePromise = pending;
    try {
      return await pending;
    } finally {
      if (this.ensurePromise === pending) this.ensurePromise = null;
    }
  }

  private async ensureRunningOnce(): Promise<SidecarStatus> {
    const generation = ++this.generation;
    this.stopping = false;
    // The order lives in daemon-handshake.ts so it can be held by a test:
    // health first, the version label beside it, and a spawned daemon polled
    // at the fast cadence. Nothing about the window's gate changes here.
    let outcome: HandshakeOutcome;
    try {
      outcome = await bringUpDaemon({
        probeHealth: () => this.probeHealth(),
        binaryVersion: () => this.binaryVersion(),
        probeVersion: () => this.probeVersion(),
        ownsChild: () => this.child !== null,
        // Nothing answers, but a kin process may be on its way back. On a
        // machine set up as a node, launchd restarts the installed daemon
        // seconds after a rebuild kills its listener — a window longer than one
        // health probe. A second daemon spawned here would share the database
        // with the first while keeping its own bus, and the console would watch
        // the wrong one; see daemon-rival.ts. A cold machine has no such process
        // and spawns at once.
        waitForRival: () =>
          waitForRivalDaemon({
            listRivals: () => listKinDaemonPids(DAEMON_PORT),
            probeHealth: () => this.probeHealth(),
          }),
        stuckReason: `a kin daemon process is running but not answering on :${DAEMON_PORT} — not starting a second one`,
        spawn: () => this.spawnDaemon(),
        isCurrent: () => generation === this.generation && !this.stopping,
      });
    } catch (err) {
      // The handshake's probes and spawn report failure as outcomes; this is
      // the boundary that keeps an unexpected throw inside the handshake from
      // rejecting ensureRunning(), which callers do not try/catch.
      this.status = {
        state: "unavailable",
        reason: err instanceof Error ? err.message : String(err),
      };
      console.error(`[kin-desktop] startup handshake failed: ${this.status.reason}`);
      return this.status;
    }

    if (outcome.state === "superseded") return this.status;
    if (outcome.state === "unavailable") {
      this.status = { state: "unavailable", reason: outcome.reason };
      console.error(`[kin-desktop] ${this.status.reason}`);
      return this.status;
    }
    if (outcome.state === "unhealthy") {
      await this.stopIfOwned();
      this.status = {
        state: "unavailable",
        reason: "spawned daemon did not become healthy in time",
      };
      console.error(`[kin-desktop] ${this.status.reason}`);
      return this.status;
    }

    if (outcome.state === "external") {
      if (this.restartTimer) {
        clearTimeout(this.restartTimer);
        this.restartTimer = null;
      }
      const owned = this.weStarted && this.child !== null;
      // Only two known versions can disagree. A label that missed the bounded
      // wait is "unknown", which is not evidence of drift.
      if (
        outcome.expected &&
        outcome.version !== "unknown" &&
        outcome.version !== outcome.expected
      ) {
        console.warn(
          `[kin-desktop] daemon version mismatch: running=${outcome.version} expected=${outcome.expected}; attaching to existing process`,
        );
      } else {
        console.log(
          `[kin-desktop] daemon already running version=${outcome.version} (external)`,
        );
      }
      if (!owned) {
        this.weStarted = false;
        this.restartAttempt = 0;
        this.status = { state: "external", version: outcome.version };
      } else {
        this.markStable();
        this.status = {
          state: "spawned",
          version: outcome.version,
          pid: this.child?.pid ?? -1,
        };
      }
      return this.status;
    }

    this.markStable();
    this.status = {
      state: "spawned",
      version: outcome.version,
      pid: outcome.pid,
    };
    console.log(
      `[kin-desktop] daemon ready version=${outcome.version} pid=${outcome.pid}`,
    );
    return this.status;
  }

  /**
   * Start `kin supervise` and wire its lifecycle. Reports the pid, or the
   * reason no process exists, so the handshake can treat both as its spawn
   * step without owning Electron's child handling.
   */
  private spawnDaemon(): SpawnResult {
    const bin = kinBinaryPath();
    if (!existsSync(bin)) {
      return { ok: false, reason: `kin binary not found at ${bin}` };
    }
    console.log(
      `[kin-desktop] no daemon on :${DAEMON_PORT}; spawning ${bin} supervise (dev=${isDev()})`,
    );

    let child: ChildProcess;
    try {
      child = spawn(bin, ["supervise"], {
        // The daemon is a durable background service. It must outlive the
        // Electron shell when the user quits the menu-bar app.
        stdio: ["ignore", "ignore", "ignore"],
        // Explicit on top of the inherited environment: the child must agree
        // with the port and state directory the shell probes and reads. The
        // resolved values are today's defaults when nothing was exported.
        env: {
          ...process.env,
          KIN_PORT: String(DAEMON_PORT),
          KIN_STATE_DIR: STATE_DIR,
        },
        detached: true,
      });
    } catch (err) {
      return {
        ok: false,
        reason: `spawn failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    this.child = child;
    this.weStarted = true;
    const pid = child.pid ?? -1;
    // Named as soon as the process exists, not only once it is healthy: a
    // launcher interrupted during the health wait must still know which
    // supervisor this shell owns, so cleanup never has to guess from a port.
    console.log(`[kin-desktop] daemon spawned pid=${pid}`);
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      console.log(
        `[kin-desktop] daemon exited code=${code} signal=${signal}`,
      );
      this.child = null;
      if (this.weStarted) {
        this.clearStableTimer();
        this.invalidatePendingEnsure();
        this.weStarted = false;
        this.status = {
          state: "unavailable",
          // A busy state directory is the one exit worth naming: it means the
          // machine is already being served, not that the daemon broke.
          reason:
            code === STATE_DIR_BUSY_EXIT
              ? "another kin daemon already owns this machine's state directory"
              : `daemon exited (code=${code})`,
        };
        // A busy state directory is not a crash, and retrying cannot change
        // it: the other daemon owns that directory until it stops. So do not restart
        // here; the shell's own recovery, or the next Start, asks again.
        if (!this.stopping && code !== STATE_DIR_BUSY_EXIT) this.scheduleRestart();
      }
    });
    child.on("error", (err) => {
      console.error("[kin-desktop] daemon process error", err);
      if (this.child !== child || !this.weStarted) return;
      this.clearStableTimer();
      this.invalidatePendingEnsure();
      this.child = null;
      this.weStarted = false;
      this.status = {
        state: "unavailable",
        reason: `daemon process error: ${err.message}`,
      };
      if (!this.stopping) this.scheduleRestart();
    });
    child.unref();

    return { ok: true, pid };
  }

  async start(): Promise<SidecarStatus> {
    return this.ensureRunning();
  }

  /**
   * Stop the daemon only if this shell spawned it.
   * External daemons are left alone on app quit.
   */
  async stopIfOwned(): Promise<void> {
    this.stopping = true;
    this.invalidatePendingEnsure();
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.clearStableTimer();
    if (!this.weStarted || !this.child) {
      console.log("[kin-desktop] quit: not stopping external/unowned daemon");
      return;
    }
    console.log("[kin-desktop] quit: stopping daemon we started");
    const child = this.child;
    this.weStarted = false;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        resolve();
      }, 8000);
      child.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
      try {
        child.kill("SIGTERM");
      } catch {
        clearTimeout(t);
        resolve();
      }
    });
    this.child = null;
  }

  /**
   * Release the Electron shell without stopping the daemon. Used on app quit:
   * explicit tray "Stop daemon" remains the destructive operation.
   */
  detach(): void {
    this.stopping = true;
    this.invalidatePendingEnsure();
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.clearStableTimer();
    if (this.child) this.child.unref();
    this.child = null;
    this.weStarted = false;
  }

  /** Explicit user Start from tray — spawn if not healthy. */
  async startFromMenu(): Promise<SidecarStatus> {
    return this.ensureRunning();
  }

  /** Explicit user Stop — only kills our child; for external, refuse. */
  async stopFromMenu(): Promise<{ ok: boolean; message: string }> {
    if (this.restartTimer) {
      this.stopping = true;
      this.invalidatePendingEnsure();
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
      this.restartAttempt = 0;
      this.status = { state: "unavailable", reason: "stopped by user" };
      return { ok: true, message: "Daemon restart canceled" };
    }
    if (this.ensurePromise) {
      this.stopping = true;
      this.invalidatePendingEnsure();
      if (this.weStarted && this.child) {
        await this.stopIfOwned();
      }
      this.status = { state: "unavailable", reason: "stopped by user" };
      return { ok: true, message: "Daemon start canceled" };
    }
    if (!this.weStarted || !this.child) {
      return {
        ok: false,
        message: "Daemon was not started by this app; stop it yourself (Ctrl-C / kill).",
      };
    }
    await this.stopIfOwned();
    this.status = { state: "unavailable", reason: "stopped by user" };
    return { ok: true, message: "Daemon stopped" };
  }

  private scheduleRestart(): void {
    if (this.stopping || this.restartTimer || this.restartAttempt >= 3) {
      if (this.restartAttempt >= 3) {
        console.error("[kin-desktop] daemon restart limit reached");
      }
      return;
    }
    this.restartAttempt += 1;
    const attempt = this.restartAttempt;
    const delay = Math.min(15_000, 1_000 * 2 ** (attempt - 1));
    this.status = {
      state: "restarting",
      reason: "daemon exited unexpectedly",
      attempt,
    };
    console.warn(
      `[kin-desktop] scheduling daemon restart attempt=${attempt} delay=${delay}ms`,
    );
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.ensureRunning().catch((err) => {
        console.error("[kin-desktop] daemon restart failed", err);
      });
    }, delay);
  }

  private invalidatePendingEnsure(): void {
    this.generation += 1;
    this.ensurePromise = null;
  }

  private markStable(): void {
    this.clearStableTimer();
    this.stableTimer = setTimeout(() => {
      this.stableTimer = null;
      this.restartAttempt = 0;
    }, 30_000);
  }

  private clearStableTimer(): void {
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
  }
}
