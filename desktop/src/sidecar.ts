import { spawn, type ChildProcess, execFile } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { promisify } from "node:util";
import {
  DAEMON_BASE,
  TOKEN_PATH,
  kinBinaryPath,
  isDev,
} from "./config";

const execFileAsync = promisify(execFile);

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
    const expected = await this.binaryVersion();
    const healthy = await this.probeHealth();

    if (healthy) {
      if (generation !== this.generation) return this.status;
      if (this.restartTimer) {
        clearTimeout(this.restartTimer);
        this.restartTimer = null;
      }
      const running = (await this.probeVersion()) ?? "unknown";
      if (generation !== this.generation) return this.status;
      const owned = this.weStarted && this.child !== null;
      if (expected && running !== expected) {
        console.warn(
          `[kin-desktop] daemon version mismatch: running=${running} expected=${expected}; attaching to existing process`,
        );
      } else {
        console.log(
          `[kin-desktop] daemon already running version=${running} (external)`,
        );
      }
      if (!owned) {
        this.weStarted = false;
        this.restartAttempt = 0;
        this.status = { state: "external", version: running };
      } else {
        this.markStable();
        this.status = {
          state: "spawned",
          version: running,
          pid: this.child?.pid ?? -1,
        };
      }
      return this.status;
    }

    const bin = kinBinaryPath();
    if (!existsSync(bin)) {
      this.status = {
        state: "unavailable",
        reason: `kin binary not found at ${bin}`,
      };
      console.error(`[kin-desktop] ${this.status.reason}`);
      return this.status;
    }
    if (generation !== this.generation || this.stopping) return this.status;

    console.log(
      `[kin-desktop] no daemon on :7777; spawning ${bin} supervise (dev=${isDev()})`,
    );
    try {
      const child = spawn(bin, ["supervise"], {
        // The daemon is a durable background service. It must outlive the
        // Electron shell when the user quits the menu-bar app.
        stdio: ["ignore", "ignore", "ignore"],
        env: { ...process.env },
        detached: true,
      });
      this.child = child;
      this.weStarted = true;
      const pid = child.pid ?? -1;
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
            reason: `daemon exited (code=${code})`,
          };
          if (!this.stopping) this.scheduleRestart();
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

      // Wait until health answers (up to ~15s).
      const ok = await this.waitHealthy(15_000);
      if (generation !== this.generation) return this.status;
      if (!ok) {
        await this.stopIfOwned();
        this.status = {
          state: "unavailable",
          reason: "spawned daemon did not become healthy in time",
        };
        console.error(`[kin-desktop] ${this.status.reason}`);
        return this.status;
      }
      const ver = (await this.probeVersion()) ?? expected ?? "unknown";
      if (generation !== this.generation) return this.status;
      this.markStable();
      this.status = { state: "spawned", version: ver, pid };
      console.log(
        `[kin-desktop] daemon ready version=${ver} pid=${pid}`,
      );
      return this.status;
    } catch (err) {
      this.status = {
        state: "unavailable",
        reason: err instanceof Error ? err.message : String(err),
      };
      console.error(`[kin-desktop] spawn failed: ${this.status.reason}`);
      return this.status;
    }
  }

  private async waitHealthy(ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await this.probeHealth()) return true;
      await sleep(250);
    }
    return false;
  }

  async start(): Promise<SidecarStatus> {
    if (await this.probeHealth()) {
      return this.ensureRunning();
    }
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
