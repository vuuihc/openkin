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

export type TrayHandlers = {
  openKin: () => void;
  openApproval: (id: string) => void;
  startDaemon: () => void;
  stopDaemon: () => void;
  quit: () => void;
  getDaemonRunning: () => boolean;
  getWeOwnDaemon: () => boolean;
};

export class AppTray {
  private tray: Tray | null = null;
  private handlers: TrayHandlers;
  private pending: Approval[] = [];
  private loginEnabled = false;

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
    this.tray.on("click", () => {
      // macOS: left click often opens menu already; still allow open.
      if (process.platform === "darwin") return;
      this.handlers.openKin();
    });
    console.log("[kin-desktop] tray setup complete");
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
    // macOS menu bar: setTitle draws text next to the template icon.
    if (process.platform === "darwin") {
      this.tray.setTitle(n > 0 ? String(n) : "");
    }
    this.tray.setToolTip(n > 0 ? `Kin — ${n} pending approval${n === 1 ? "" : "s"}` : "Kin");
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
      {
        label: "Launch at Login",
        type: "checkbox",
        checked: this.loginEnabled,
        click: (item) => {
          this.loginEnabled = item.checked;
          app.setLoginItemSettings({ openAtLogin: item.checked });
          console.log(
            `[kin-desktop] launch at login → ${item.checked}`,
          );
        },
      },
      { type: "separator" },
      {
        label: "Quit Kin",
        click: () => this.handlers.quit(),
      },
    ];

    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }
}

function loadTrayIcon(): Electron.NativeImage {
  const p = trayIconPath();
  if (existsSync(p)) {
    const img = nativeImage.createFromPath(p);
    // Template image: macOS tints to menu-bar style.
    if (process.platform === "darwin") {
      img.setTemplateImage(true);
    }
    if (!img.isEmpty()) return img;
  }
  // 16×16 black "dot" fallback so the tray still appears.
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
