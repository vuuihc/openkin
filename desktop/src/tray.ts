import {
  Tray,
  Menu,
  nativeImage,
  app,
  type MenuItemConstructorOptions,
} from "electron";
import { existsSync } from "node:fs";
import { trayIconPath } from "./config";
import type { Approval } from "./daemon-api";
import type { UpdaterState } from "./updater-wiring.ts";

export type TrayHandlers = {
  openKin: () => void;
  openApproval: (id: string) => void;
  /** Left-click / primary: open design popover under the tray icon. */
  togglePopover: (bounds: Electron.Rectangle) => void;
  startDaemon: () => void;
  stopDaemon: () => void;
  quit: () => void;
  getDaemonRunning: () => boolean;
  getWeOwnDaemon: () => boolean;
  /** KIN-SETTINGS-002: tray owns no update policy — it renders UpdaterState. */
  checkForUpdate: () => void;
  downloadUpdate: () => void;
  installDownloadedUpdate: () => void;
  clearDownloadedUpdate: () => void;
  currentVersion: () => string;
  updaterState: () => UpdaterState;
};

export class AppTray {
  private tray: Tray | null = null;
  private handlers: TrayHandlers;
  private pending: Approval[] = [];
  private loginEnabled = false;
  private menu: Menu | null = null;

  constructor(handlers: TrayHandlers) {
    this.handlers = handlers;
  }

  create(): void {
    if (process.platform !== "darwin" && process.platform !== "linux") {
      console.warn("[kin-desktop] tray: unsupported platform", process.platform);
    }
    const icon = loadTrayIcon();
    this.tray = new Tray(icon);
    this.tray.setToolTip("Kin");
    this.loginEnabled = app.getLoginItemSettings().openAtLogin;
    this.rebuildMenu();

    // Left-click → design popover (2a). Do NOT setContextMenu on macOS —
    // that would steal left-click for the native menu.
    this.tray.on("click", (_event, bounds) => {
      const b = bounds?.width ? bounds : this.tray?.getBounds();
      if (b) this.handlers.togglePopover(b);
      else this.handlers.openKin();
    });

    this.tray.on("right-click", (_event, bounds) => {
      if (!this.tray || !this.menu) return;
      this.tray.popUpContextMenu(this.menu, bounds);
    });

    // Double-click opens main window
    this.tray.on("double-click", () => {
      this.handlers.openKin();
    });

    console.log("[kin-desktop] tray setup complete");
  }

  getBounds(): Electron.Rectangle | null {
    return this.tray?.getBounds() ?? null;
  }

  setPending(approvals: Approval[]): void {
    this.pending = approvals
      .filter((a) => a.decision === "pending")
      .sort((a, b) => b.created_at - a.created_at);
    this.updateBadge();
    this.rebuildMenu();
  }

  refresh(): void {
    this.rebuildMenu();
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }

  private updateBadge(): void {
    if (!this.tray) return;
    const n = this.pending.length;
    if (process.platform === "darwin") {
      this.tray.setTitle(n > 0 ? String(n) : "");
    }
    this.tray.setToolTip(
      n > 0 ? `Kin — ${n} pending approval${n === 1 ? "" : "s"}` : "Kin",
    );
  }

  private rebuildMenu(): void {
    if (!this.tray) return;
    const top = this.pending.slice(0, 3);
    const running = this.handlers.getDaemonRunning();
    const weOwn = this.handlers.getWeOwnDaemon();

    const approvalItems: MenuItemConstructorOptions[] =
      top.length === 0
        ? [{ label: "No pending approvals", enabled: false }]
        : top.map((a) => ({
            label: truncate(
              a.task_title?.trim() || summaryFromPayload(a.payload) || a.id,
              48,
            ),
            click: () => this.handlers.openApproval(a.id),
          }));

    const template: MenuItemConstructorOptions[] = [
      {
        label: "Open Kin",
        click: () => this.handlers.openKin(),
      },
      {
        label: "Show Popover",
        click: () => {
          const b = this.tray?.getBounds();
          if (b) this.handlers.togglePopover(b);
        },
      },
      { type: "separator" },
      {
        label: "Pending approvals",
        enabled: false,
      },
      ...approvalItems,
      { type: "separator" },
      {
        label: running ? "Daemon: running" : "Daemon: stopped",
        enabled: false,
      },
      {
        label: "Start daemon",
        enabled: !running,
        click: () => this.handlers.startDaemon(),
      },
      {
        label: "Stop daemon",
        enabled: running && weOwn,
        toolTip: weOwn
          ? "Stop the daemon started by this app"
          : "Daemon is external — stop it outside Kin",
        click: () => this.handlers.stopDaemon(),
      },
      { type: "separator" },
      ...this.updateMenuItems(),
      { type: "separator" },
      {
        label: "Launch at Login",
        type: "checkbox",
        checked: this.loginEnabled,
        click: (item) => {
          this.loginEnabled = item.checked;
          app.setLoginItemSettings({ openAtLogin: item.checked });
          console.log(`[kin-desktop] launch at login → ${item.checked}`);
        },
      },
      { type: "separator" },
      {
        label: "Quit Kin",
        click: () => this.handlers.quit(),
      },
    ];

    this.menu = Menu.buildFromTemplate(template);
    // Non-macOS: attach as default context menu (right-click).
    // macOS uses right-click → popUpContextMenu so left-click can open the popover.
    if (process.platform !== "darwin") {
      this.tray.setContextMenu(this.menu);
    }
  }

  /**
   * KIN-SETTINGS-002. The update block is a version line (always) plus one
   * action item whose label follows the UpdaterState the main process last
   * published: check / download / install, with progress and failures
   * rendered as disabled lines rather than dialogs.
   */
  private updateMenuItems(): MenuItemConstructorOptions[] {
    const version = this.handlers.currentVersion();
    const state = this.handlers.updaterState();
    // Contract step 1: dev builds show "Kin dev", not "Kin 0.0.0-dev".
    const versionLabel = version === "0.0.0-dev" ? "dev" : version;
    const items: MenuItemConstructorOptions[] = [
      { label: `Kin ${versionLabel}`, enabled: false },
    ];
    switch (state.phase) {
      case "idle":
        items.push({
          label: "检查更新…",
          click: () => this.handlers.checkForUpdate(),
        });
        break;
      case "checking":
        items.push({ label: "正在检查…", enabled: false });
        break;
      case "current":
        items.push({ label: `已是最新（${state.version}）`, enabled: false });
        break;
      case "available":
        items.push({
          label: `下载 ${state.version}…`,
          click: () => this.handlers.downloadUpdate(),
        });
        break;
      case "downloading":
        items.push({
          label:
            state.hasTotal === false
              ? "下载中…"
              : `下载中… ${Math.round(state.fraction * 100)}%`,
          enabled: false,
        });
        break;
      case "downloaded":
        items.push({
          label: state.offered
            ? `打开已下载的 ${state.version}`
            : `安装 ${state.version}（已下载）`,
          click: () => this.handlers.installDownloadedUpdate(),
        });
        items.push({
          label: "删除已下载的安装包",
          click: () => this.handlers.clearDownloadedUpdate(),
        });
        break;
      case "error":
        items.push({
          label: `更新检查失败：${truncate(state.message, 40)}`,
          enabled: false,
        });
        items.push({
          label: "重试检查…",
          click: () => this.handlers.checkForUpdate(),
        });
        break;
    }
    return items;
  }
}

function loadTrayIcon(): Electron.NativeImage {
  const p = trayIconPath();
  if (existsSync(p)) {
    const img = nativeImage.createFromPath(p);
    if (process.platform === "darwin") {
      img.setTemplateImage(true);
    }
    if (!img.isEmpty()) return img;
  }
  console.warn("[kin-desktop] tray icon missing at", p, "— using fallback");
  const fallback = nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAAFUlEQVR42mP8z8BQz0BFwEDFwMDAwAAA8A4B2q1oWQAAAABJRU5ErkJggg==",
  );
  if (process.platform === "darwin") fallback.setTemplateImage(true);
  return fallback;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function summaryFromPayload(payload: unknown): string {
  const p = (payload ?? {}) as Record<string, unknown>;
  return String(p.tool_name ?? p.toolName ?? p.name ?? p.tool ?? "");
}
