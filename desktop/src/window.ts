import {
  BrowserWindow,
  app,
  shell,
  type BrowserWindowConstructorOptions,
} from "electron";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DAEMON_HOST, DAEMON_PORT, DAEMON_BASE, boundsPath } from "./config";

const DEFAULT_BOUNDS = { width: 1100, height: 760 };

type Bounds = {
  x?: number;
  y?: number;
  width: number;
  height: number;
};

export class MainWindow {
  private win: BrowserWindow | null = null;
  private token: string | null = null;
  private allowClose = false;

  setToken(token: string | null): void {
    this.token = token;
  }

  get isOpen(): boolean {
    return this.win !== null && !this.win.isDestroyed();
  }

  get browserWindow(): BrowserWindow | null {
    return this.win && !this.win.isDestroyed() ? this.win : null;
  }

  /** Prepare to fully quit (do not hide-to-tray). */
  prepareQuit(): void {
    this.allowClose = true;
  }

  show(path = "/"): void {
    if (this.win && !this.win.isDestroyed()) {
      this.navigate(path);
      if (this.win.isMinimized()) this.win.restore();
      this.win.show();
      this.win.focus();
      this.showDock();
      return;
    }
    this.create(path);
  }

  hide(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.hide();
    }
    this.hideDockIfNoWindows();
  }

  openApproval(approvalId: string): void {
    // Approvals live on /approvals; deep-link by query so the SPA can highlight if desired.
    this.show(`/approvals?focus=${encodeURIComponent(approvalId)}`);
  }

  private create(path: string): void {
    const bounds = loadBounds();
    const opts: BrowserWindowConstructorOptions = {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      minWidth: 720,
      minHeight: 480,
      title: "Kin",
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // No preload: the embedded web console talks to the daemon itself.
        preload: undefined,
      },
    };
    this.win = new BrowserWindow(opts);

    this.win.once("ready-to-show", () => {
      this.win?.show();
      this.showDock();
    });

    this.win.on("close", (e) => {
      if (this.allowClose) return;
      e.preventDefault();
      this.win?.hide();
      this.hideDockIfNoWindows();
      console.log("[kin-desktop] window closed → hide to tray");
    });

    this.win.on("closed", () => {
      this.win = null;
    });

    this.win.on("resize", () => this.persistBounds());
    this.win.on("move", () => this.persistBounds());

    // Navigation lockdown: only 127.0.0.1:7777
    this.win.webContents.on("will-navigate", (event, url) => {
      if (!isAllowedURL(url)) {
        event.preventDefault();
        console.warn("[kin-desktop] blocked navigation to", url);
      }
    });
    this.win.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedURL(url)) {
        return { action: "allow" };
      }
      // External links open in the system browser instead of a new Electron window.
      void shell.openExternal(url);
      return { action: "deny" };
    });

    this.navigate(path);
  }

  private navigate(path: string): void {
    if (!this.win || this.win.isDestroyed()) return;
    const tok = this.token;
    const base = DAEMON_BASE.replace(/\/$/, "");
    const p = path.startsWith("/") ? path : `/${path}`;
    // Capture token into localStorage via the SPA's captureTokenFromURL.
    const url = tok
      ? `${base}${p}${p.includes("?") ? "&" : "?"}token=${encodeURIComponent(tok)}`
      : `${base}${p}`;
    void this.win.loadURL(url);
  }

  private persistBounds(): void {
    if (!this.win || this.win.isDestroyed()) return;
    const b = this.win.getBounds();
    saveBounds(b);
  }

  private showDock(): void {
    if (process.platform === "darwin" && app.dock) {
      app.dock.show();
    }
  }

  private hideDockIfNoWindows(): void {
    if (process.platform !== "darwin" || !app.dock) return;
    // Menu-bar app: hide dock icon while no visible windows.
    const visible = BrowserWindow.getAllWindows().some(
      (w) => !w.isDestroyed() && w.isVisible(),
    );
    if (!visible) {
      app.dock.hide();
    }
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

function loadBounds(): Bounds {
  try {
    const p = boundsPath();
    if (!existsSync(p)) return { ...DEFAULT_BOUNDS };
    const raw = JSON.parse(readFileSync(p, "utf8")) as Bounds;
    return {
      width: Math.max(720, raw.width || DEFAULT_BOUNDS.width),
      height: Math.max(480, raw.height || DEFAULT_BOUNDS.height),
      x: raw.x,
      y: raw.y,
    };
  } catch {
    return { ...DEFAULT_BOUNDS };
  }
}

function saveBounds(b: Bounds): void {
  try {
    const p = boundsPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(b), "utf8");
  } catch {
    /* ignore */
  }
}
