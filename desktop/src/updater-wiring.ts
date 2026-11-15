/**
 * Updater orchestration: glues the pure rules in updater.ts to Electron's
 * Notification and shell, and reports state the tray menu can show.
 *
 * The tray owns no update policy of its own — it renders whatever this state
 * machine last said, so the same flows are testable without a Menu.
 */

import { decideUpdate, type CheckResult, type ProgressFn } from "./updater.ts";

export type UpdaterState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "current"; version: string }
  | { phase: "available"; version: string; downloadUrl: string }
  | {
      phase: "downloading";
      version: string;
      fraction: number;
      /** False when the server declared no length: show no percentage. */
      hasTotal?: boolean;
    }
  | {
      phase: "downloaded";
      version: string;
      path: string;
      /**
       * True once the dmg has been opened and the quit-confirm was answered
       * "稍后": the menu item relabels to 打开已下载的 X, and clicking it
       * re-opens the dmg without asking again.
       */
      offered?: boolean;
    }
  | { phase: "error"; message: string };

/** What the orchestrator may do to the world, injected for tests. */
export type UpdaterEnv = {
  /** This build's version (app.getVersion()). */
  appVersion: () => string;
  /** Fetch the latest release info, or throw. */
  check: () => Promise<{ tag: string; assets: string[] }>;
  /** Stream the dmg to disk; fraction callbacks on progress. */
  download: (
    url: string,
    destPath: string,
    onProgress: ProgressFn,
  ) => Promise<string>;
  /** Where a download for this version lands. */
  downloadPath: (version: string) => string;
  /** Show a macOS notification. */
  notify: (title: string, body: string) => void;
  /** Open a file in Finder; resolves "" on success, else the error. */
  openPath: (path: string) => Promise<string>;
  /** Delete a downloaded dmg; missing file is fine. */
  clear: (path: string) => Promise<void>;
  /**
   * Ask "要退出以安装吗？" as a native dialog. Resolves true for
   * 退出并打开, false for 稍后 (or the dialog being dismissed). Injected so
   * the state machine tests the whole flow without a MessageBox.
   */
  confirmQuitToInstall: () => Promise<boolean>;
  /** Quit the whole app (install = drag over the mounted dmg's app). */
  quitApp: () => void;
  /** Post state for the tray menu to render. */
  setState: (s: UpdaterState) => void;
};

/**
 * One update flow at a time: `busy` makes a second menu click a no-op
 * instead of two racing downloads writing the same .part file.
 */
export class Updater {
  private env: UpdaterEnv;
  private state: UpdaterState = { phase: "idle" };
  private busy = false;

  constructor(env: UpdaterEnv) {
    this.env = env;
  }

  get current(): UpdaterState {
    return this.state;
  }

  private setState(s: UpdaterState): void {
    this.state = s;
    this.env.setState(s);
  }

  /** Tray's "检查更新…". */
  async checkNow(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    // A re-check must not orphan a downloaded dmg on disk: remember the
    // path so the 删除已下载的安装包 escape hatch stays reachable (review N5).
    const staleDownload =
      this.state.phase === "downloaded" ? this.state.path : null;
    this.setState({ phase: "checking" });
    try {
      const release = await this.env.check();
      const result: CheckResult = decideUpdate(this.env.appVersion(), release);
      switch (result.kind) {
        case "dev":
          // Never nagged, never offered: a dev build is ahead of any release.
          this.setState({ phase: "idle" });
          this.env.notify("Kin", "开发构建不检查更新");
          break;
        case "current":
          this.setState({ phase: "current", version: result.version });
          break;
        case "available":
          this.setState({
            phase: "available",
            version: result.version,
            downloadUrl: result.downloadUrl,
          });
          this.env.notify(
            `发现 Kin ${result.version}`,
            "点击托盘菜单下载更新",
          );
          break;
        case "no-mac-asset":
          this.setState({ phase: "idle" });
          this.env.notify(
            `Kin ${result.version}`,
            "这个版本没有 Mac 安装包，去 GitHub 看",
          );
          break;
        case "error":
          this.setState({ phase: "error", message: result.message });
          break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setState({ phase: "error", message: truncate(message, 60) });
      this.env.notify("Kin", "检查失败：无法连接 GitHub");
    } finally {
      if (staleDownload) {
        // Never throw from cleanup on the way out of a finished check.
        void this.env.clear(staleDownload).catch(() => {});
      }
      this.busy = false;
    }
  }

  /** Download the version the last check found. */
  async download(): Promise<void> {
    if (this.busy) return;
    if (this.state.phase !== "available") return;
    const { version, downloadUrl } = this.state;
    this.busy = true;
    this.setState({ phase: "downloading", version, fraction: 0, hasTotal: false });
    try {
      const path = await this.env.download(
        downloadUrl,
        this.env.downloadPath(version),
        (f, hasTotal) =>
          this.setState({ phase: "downloading", version, fraction: f, hasTotal }),
      );
      this.setState({ phase: "downloaded", version, path });
      this.env.notify(
        `Kin ${version} 已下载`,
        "点击安装：拖入 Applications 覆盖旧版本",
      );
    } catch (err) {
      // Contract step 3: a failed download restores 下载 X… so one click
      // retries it — not the check-failure menu (review M3).
      const message = err instanceof Error ? err.message : String(err);
      this.setState({ phase: "available", version, downloadUrl });
      this.env.notify("Kin", `下载失败：${truncate(message, 60)}`);
    } finally {
      this.busy = false;
    }
  }

  /**
   * The tray's action once a dmg sits on disk. First click: open the dmg in
   * Finder and ask the quit-confirm (要退出以安装吗？). "退出并打开" quits the
   * app so the drag-over can replace it; "稍后" leaves the dmg on disk and the
   * menu item relabels to 打开已下载的 X, which re-opens without asking
   * again. A dmg that will not open is reported, never silently ignored.
   * Contract step 4 (执行+收尾).
   */
  async installDownloaded(): Promise<void> {
    if (this.busy) return; // one confirm dialog at a time (review N8)
    if (this.state.phase !== "downloaded") return;
    const { version, path, offered } = this.state;
    if (!offered) {
      this.setState({ phase: "downloaded", version, path, offered: true });
    }
    this.busy = true;
    try {
      const openError = await this.env.openPath(path);
      if (openError) {
        this.env.notify("Kin", "安装包打不开，请手动下载");
        return;
      }
      // Already confirmed once — reopening the Finder window is not a new
      // question, so don't nag with the dialog again.
      if (offered) return;
      const quit = await this.env.confirmQuitToInstall();
      if (quit) {
        this.env.quitApp();
      }
    } finally {
      this.busy = false;
    }
  }

  /**
   * Tray's 删除已下载的安装包: drop the dmg and return to the default menu.
   * Contract step 4 — the deferred item stays "until installed or cleaned".
   */
  async clearDownloaded(): Promise<void> {
    if (this.state.phase !== "downloaded") return;
    const { path } = this.state;
    this.setState({ phase: "idle" });
    try {
      await this.env.clear(path);
    } catch {
      // The file stays until the OS cleans the temp dir; the menu already
      // returned to idle, which is what the person asked for.
    }
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
