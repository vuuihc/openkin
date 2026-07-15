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
  | { state: "unavailable"; reason: string };

export class Sidecar {
  private child: ChildProcess | null = null;
  private weStarted = false;
  private status: SidecarStatus = { state: "unavailable", reason: "not started" };

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
    const expected = await this.binaryVersion();
    const healthy = await this.probeHealth();

    if (healthy) {
      const running = (await this.probeVersion()) ?? "unknown";
      if (expected && running !== expected) {
        console.warn(
          `[kin-desktop] daemon version mismatch: running=${running} expected=${expected}; attaching to existing process`,
        );
      } else {
        console.log(
          `[kin-desktop] daemon already running version=${running} (external)`,
        );
      }
      this.weStarted = false;
      this.status = { state: "external", version: running };
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

    console.log(
      `[kin-desktop] no daemon on :7777; spawning ${bin} serve (dev=${isDev()})`,
    );
    try {
      const child = spawn(bin, ["serve"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
        detached: false,
      });
      this.child = child;
      this.weStarted = true;
      const pid = child.pid ?? -1;
      child.stdout?.on("data", (d: Buffer) => {
        console.log(`[kin-daemon] ${d.toString().trimEnd()}`);
      });
      child.stderr?.on("data", (d: Buffer) => {
        console.error(`[kin-daemon] ${d.toString().trimEnd()}`);
      });
      child.on("exit", (code, signal) => {
        console.log(
          `[kin-desktop] daemon exited code=${code} signal=${signal}`,
        );
        this.child = null;
        if (this.weStarted) {
          this.weStarted = false;
          this.status = {
            state: "unavailable",
            reason: `daemon exited (code=${code})`,
          };
        }
      });

      // Wait until health answers (up to ~15s).
      const ok = await this.waitHealthy(15_000);
      if (!ok) {
        this.status = {
          state: "unavailable",
          reason: "spawned daemon did not become healthy in time",
        };
        console.error(`[kin-desktop] ${this.status.reason}`);
        return this.status;
      }
      const ver = (await this.probeVersion()) ?? expected ?? "unknown";
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
      }, 4000);
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

  /** Explicit user Start from tray — spawn if not healthy. */
  async startFromMenu(): Promise<SidecarStatus> {
    return this.ensureRunning();
  }

  /** Explicit user Stop — only kills our child; for external, refuse. */
  async stopFromMenu(): Promise<{ ok: boolean; message: string }> {
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
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
