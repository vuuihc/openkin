/**
 * Frameless 360×480 tray popover (design 2a).
 * Loads the SPA at /tray with the daemon token.
 */
import {
  BrowserWindow,
  screen,
  type BrowserWindowConstructorOptions,
} from "electron";
import { DAEMON_BASE, DAEMON_HOST, DAEMON_PORT } from "./config";

const POPOVER_W = 360;
const POPOVER_H = 480;

/** Chromium ERR_ABORTED — user/navigation cancelled; do not retry. */
const ERR_ABORTED = -3;

export type TrayPopoverHandlers = {
  /** Open main window at path and hide popover. */
  openMain: (path: string) => void;
  getToken: () => string | null;
};

export class TrayPopover {
  private win: BrowserWindow | null = null;
  private handlers: TrayPopoverHandlers;
  /** Suppress blur-to-close while showing / loading. */
  private ignoreBlur = false;
  private loadRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private loadAttempts = 0;

  constructor(handlers: TrayPopoverHandlers) {
    this.handlers = handlers;
  }

  get isOpen(): boolean {
    return this.win !== null && !this.win.isDestroyed() && this.win.isVisible();
  }

  /** Toggle under the tray icon bounds. */
  toggle(trayBounds: Electron.Rectangle): void {
    if (this.isOpen) {
      this.hide();
      return;
    }
    this.show(trayBounds);
  }

  show(trayBounds: Electron.Rectangle): void {
    if (!this.win || this.win.isDestroyed()) {
      this.create();
    }
    if (!this.win) return;
    this.ignoreBlur = true;
    this.position(trayBounds);
    this.navigate();
    this.win.show();
    this.win.focus();
    setTimeout(() => {
      this.ignoreBlur = false;
    }, 400);
  }

  hide(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.hide();
    }
  }

  destroy(): void {
    this.clearLoadRetry();
    if (this.win && !this.win.isDestroyed()) {
      this.win.destroy();
    }
    this.win = null;
  }

  /** Soft refresh after daemon becomes ready (same as main window). */
  reloadWhenReady(): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.loadAttempts = 0;
    this.clearLoadRetry();
    this.navigate();
  }

  /** Reload content when pending list changes (optional refresh). */
  refresh(): void {
    if (!this.win || this.win.isDestroyed() || !this.win.isVisible()) return;
    this.win.webContents.send?.("kin-tray-refresh");
    // Soft reload SPA data via navigate same URL is heavy; SPA uses WS.
  }

  private create(): void {
    const opts: BrowserWindowConstructorOptions = {
      width: POPOVER_W,
      height: POPOVER_H,
      show: false,
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      transparent: false,
      hasShadow: true,
      title: "Kin",
      backgroundColor: "#28282c",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    };

    // macOS vibrancy for control-center feel
    if (process.platform === "darwin") {
      opts.vibrancy = "popover";
      opts.visualEffectState = "active";
    }

    this.win = new BrowserWindow(opts);

    this.win.on("blur", () => {
      // Click-away closes popover (design language).
      if (this.ignoreBlur) return;
      this.hide();
    });

    this.win.on("closed", () => {
      this.clearLoadRetry();
      this.win = null;
    });

    this.win.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
        if (!isMainFrame) return;
        if (errorCode === ERR_ABORTED) return;
        console.warn(
          "[kin-desktop] tray did-fail-load",
          errorCode,
          errorDescription,
          "attempt=",
          this.loadAttempts + 1,
        );
        this.scheduleLoadRetry();
      },
    );

    this.win.webContents.on("did-finish-load", () => {
      this.loadAttempts = 0;
      this.clearLoadRetry();
    });

    this.win.webContents.on("will-navigate", (event, url) => {
      if (!isAllowedURL(url)) {
        event.preventDefault();
        // Paths like /tasks/x without host shouldn't happen; SPA relative navigations stay.
        try {
          const u = new URL(url);
          if (u.hostname === DAEMON_HOST || u.hostname === "localhost") {
            // Allowed host already handled; else open main
          } else {
            this.handlers.openMain(u.pathname + u.search);
            this.hide();
          }
        } catch {
          /* ignore */
        }
        return;
      }
      // Navigating away from /tray inside popover → promote to main window
      try {
        const u = new URL(url);
        if (!u.pathname.startsWith("/tray")) {
          event.preventDefault();
          this.handlers.openMain(u.pathname + u.search);
          this.hide();
        }
      } catch {
        /* ignore */
      }
    });

    this.win.webContents.setWindowOpenHandler(({ url }) => {
      try {
        const u = new URL(url);
        this.handlers.openMain(u.pathname + u.search);
      } catch {
        this.handlers.openMain("/");
      }
      this.hide();
      return { action: "deny" };
    });
  }

  private navigate(): void {
    if (!this.win || this.win.isDestroyed()) return;
    const token = this.handlers.getToken();
    const base = DAEMON_BASE.replace(/\/$/, "");
    const url = token
      ? `${base}/tray?token=${encodeURIComponent(token)}`
      : `${base}/tray`;
    void this.win.loadURL(url);
  }

  private scheduleLoadRetry(): void {
    if (this.loadRetryTimer) return;
    this.loadAttempts += 1;
    if (this.loadAttempts > 40) {
      console.error(
        "[kin-desktop] tray giving up reloading after",
        this.loadAttempts,
        "attempts",
      );
      return;
    }
    const delay = Math.min(2000, 250 * this.loadAttempts);
    this.loadRetryTimer = setTimeout(() => {
      this.loadRetryTimer = null;
      if (!this.win || this.win.isDestroyed()) return;
      this.navigate();
    }, delay);
  }

  private clearLoadRetry(): void {
    if (this.loadRetryTimer) {
      clearTimeout(this.loadRetryTimer);
      this.loadRetryTimer = null;
    }
  }

  private position(trayBounds: Electron.Rectangle): void {
    if (!this.win || this.win.isDestroyed()) return;
    const display = screen.getDisplayNearestPoint({
      x: trayBounds.x,
      y: trayBounds.y,
    });
    const work = display.workArea;

    // Center under tray icon, clamp to work area.
    let x = Math.round(trayBounds.x + trayBounds.width / 2 - POPOVER_W / 2);
    let y = Math.round(trayBounds.y + trayBounds.height + 6);

    // If tray is at bottom (unlikely on mac), flip above.
    if (y + POPOVER_H > work.y + work.height) {
      y = Math.round(trayBounds.y - POPOVER_H - 6);
    }

    x = Math.max(work.x + 8, Math.min(x, work.x + work.width - POPOVER_W - 8));
    y = Math.max(work.y + 8, Math.min(y, work.y + work.height - POPOVER_H - 8));

    this.win.setPosition(x, y, false);
  }
}

function isAllowedURL(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === "about:") return true;
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (u.hostname !== DAEMON_HOST && u.hostname !== "localhost") return false;
    const port = u.port
      ? Number(u.port)
      : u.protocol === "https:"
        ? 443
        : 80;
    return port === DAEMON_PORT;
  } catch {
    return false;
  }
}
