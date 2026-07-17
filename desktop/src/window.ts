import {
  BrowserWindow,
  app,
  nativeImage,
  shell,
  type BrowserWindowConstructorOptions,
} from "electron";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  DAEMON_HOST,
  DAEMON_PORT,
  DAEMON_BASE,
  boundsPath,
  appIconPath,
} from "./config";

const WINDOW_TITLE = "Kin";

/** Match SPA `--kin-page` so the first paint is never a white flash. */
const WINDOW_BG = "#0e0e10";

const DEFAULT_BOUNDS = { width: 1100, height: 760 };

/** Chromium ERR_ABORTED — user/navigation cancelled; do not retry. */
const ERR_ABORTED = -3;

type Bounds = {
  x?: number;
  y?: number;
  width: number;
  height: number;
};

export class MainWindow {
  private win: BrowserWindow | null = null;
  private token: string | null = null;
  /** Prefer live token (e.g. ~/.kin/token) over a stale snapshot. */
  private tokenSource: (() => string | null) | null = null;
  private allowClose = false;
  private pendingPath = "/";
  private loadRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private loadAttempts = 0;

  setToken(token: string | null): void {
    this.token = token;
  }

  /** Called on every navigate so early tray opens still pick up a late token. */
  setTokenSource(source: () => string | null): void {
    this.tokenSource = source;
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
    this.clearLoadRetry();
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
    // Inbox is the approvals surface; deep-link by query for future highlight.
    this.show(`/inbox?focus=${encodeURIComponent(approvalId)}`);
  }

  /**
   * Re-load the current (or given) path once the daemon/token is known ready.
   * Used after sidecar.ensureRunning so a white failed first paint recovers
   * without the user closing and reopening.
   */
  reloadWhenReady(path?: string): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.loadAttempts = 0;
    this.clearLoadRetry();
    this.navigate(path ?? this.pendingPath);
  }

  private create(path: string): void {
    const bounds = loadBounds();
    const iconPath = appIconPath();
    const opts: BrowserWindowConstructorOptions = {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      minWidth: 720,
      minHeight: 480,
      title: WINDOW_TITLE,
      show: false,
      backgroundColor: WINDOW_BG,
      ...(existsSync(iconPath) ? { icon: iconPath } : {}),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Preload exposes window.kinDesktop (native folder picker, etc.).
        preload: join(__dirname, "preload.js"),
      },
    };
    this.win = new BrowserWindow(opts);

    // Keep OS title bar as Kin even if a page sets <title> later.
    this.win.on("page-title-updated", (e) => {
      e.preventDefault();
      this.win?.setTitle(WINDOW_TITLE);
    });
    this.win.setTitle(WINDOW_TITLE);

    this.win.once("ready-to-show", () => {
      this.win?.setTitle(WINDOW_TITLE);
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
      this.clearLoadRetry();
      this.win = null;
    });

    this.win.on("resize", () => this.persistBounds());
    this.win.on("move", () => this.persistBounds());

    // Daemon may still be starting when the tray opens the window — retry
    // connection failures instead of leaving a blank Chromium error page.
    this.win.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
        if (!isMainFrame) return;
        if (errorCode === ERR_ABORTED) return;
        console.warn(
          "[kin-desktop] did-fail-load",
          errorCode,
          errorDescription,
          "path=",
          this.pendingPath,
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
    this.pendingPath = path.startsWith("/") ? path : `/${path}`;
    const tok = this.resolveToken();
    const base = DAEMON_BASE.replace(/\/$/, "");
    const p = this.pendingPath;
    // Capture token into localStorage via the SPA's captureTokenFromURL.
    const url = tok
      ? `${base}${p}${p.includes("?") ? "&" : "?"}token=${encodeURIComponent(tok)}`
      : `${base}${p}`;
    console.log("[kin-desktop] loadURL", p, "token=", tok ? "yes" : "no");
    void this.win.loadURL(url);
  }

  private resolveToken(): string | null {
    try {
      const live = this.tokenSource?.() ?? null;
      if (live) {
        this.token = live;
        return live;
      }
    } catch {
      /* ignore token source errors */
    }
    return this.token;
  }

  private scheduleLoadRetry(): void {
    if (this.loadRetryTimer) return;
    this.loadAttempts += 1;
    // ~30s total with backoff (250ms → 2s).
    if (this.loadAttempts > 40) {
      console.error(
        "[kin-desktop] giving up reloading after",
        this.loadAttempts,
        "attempts — is the daemon up on",
        DAEMON_BASE,
        "?",
      );
      return;
    }
    const delay = Math.min(2000, 250 * this.loadAttempts);
    this.loadRetryTimer = setTimeout(() => {
      this.loadRetryTimer = null;
      if (!this.win || this.win.isDestroyed()) return;
      console.log(
        "[kin-desktop] retry load attempt=",
        this.loadAttempts,
        "path=",
        this.pendingPath,
      );
      this.navigate(this.pendingPath);
    }, delay);
  }

  private clearLoadRetry(): void {
    if (this.loadRetryTimer) {
      clearTimeout(this.loadRetryTimer);
      this.loadRetryTimer = null;
    }
  }

  private persistBounds(): void {
    if (!this.win || this.win.isDestroyed()) return;
    const b = this.win.getBounds();
    saveBounds(b);
  }

  private showDock(): void {
    if (process.platform !== "darwin" || !app.dock) return;
    // Re-apply icon each show — hide/show can drop runtime dock icon on macOS.
    const iconPath = appIconPath();
    if (existsSync(iconPath)) {
      const image = nativeImage.createFromPath(iconPath);
      if (!image.isEmpty()) app.dock.setIcon(image);
    }
    app.dock.show();
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
