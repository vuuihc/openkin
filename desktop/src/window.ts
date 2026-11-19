import {
  BrowserWindow,
  app,
  nativeImage,
  screen,
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
import { traceStartup } from "./startup-trace";
import { failureCopy, failureLocale, type FailureReason } from "./boot-failure";
import {
  MIN_HEIGHT,
  MIN_WIDTH,
  restoreWindow,
  savedBoundsFrom,
  type RestoredWindow,
  type SavedBounds,
} from "./window-bounds";

const WINDOW_TITLE = "Kin";

/** Match SPA `--kin-page` so the first paint is never a white flash. */
const WINDOW_BG = "#0e0e10";

const DEFAULT_BOUNDS = { width: 1100, height: 760 };

/** The wordless boot surface, copied next to the bundle by build.mjs. */
const BOOT_PAGE = join(__dirname, "boot.html");

/** The worded failure page, copied next to the bundle by build.mjs. */
const BOOT_FAILED_PAGE = join(__dirname, "boot-failed.html");

/** Chromium ERR_ABORTED — user/navigation cancelled; do not retry. */
const ERR_ABORTED = -3;

export class MainWindow {
  private win: BrowserWindow | null = null;
  private token: string | null = null;
  /** Prefer the live token file over a stale snapshot. */
  private tokenSource: (() => string | null) | null = null;
  private allowClose = false;
  private pendingPath = "/";
  /** The window is showing the boot page and the console has not loaded yet. */
  private booting = false;
  /** Set when the surface being booted is the failure page rather than the loader. */
  private failureReason: FailureReason | null = null;
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

  /**
   * Show and focus the main window.
   *
   * - No path / "/" → restore the existing window as-is (keep current session).
   *   Callers that only re-focus after blur/tray/dock must not wipe SPA state.
   * - Explicit path (e.g. /tasks/:id, /new, /sessions) → navigate there.
   * - If the window was destroyed, recreate at the explicit path or last pendingPath.
   */
  show(path?: string): void {
    const wantsRestore = path == null || path === "" || path === "/";
    if (this.win && !this.win.isDestroyed()) {
      if (!wantsRestore) {
        if (this.booting) {
          // The console must not load before the daemon answers; remember
          // where to land instead of navigating a dead URL.
          this.pendingPath = asConsolePath(path);
        } else {
          this.navigate(path);
        }
      }
      this.reveal();
      return;
    }
    // Fresh window: prefer an explicit deep-link, else last known path, else home.
    const target = asConsolePath(wantsRestore ? this.pendingPath || "/" : path);
    this.pendingPath = target;
    this.create(target);
  }

  /**
   * Put the window on screen with the wordless boot page, before the daemon
   * answers. The console path is remembered; `enterConsole()` replaces the
   * page in place once the daemon settles. Asking again only reveals the
   * window — the boot page is never loaded twice.
   */
  showBoot(path?: string): void {
    if (path != null && path !== "") {
      this.pendingPath = asConsolePath(path);
    }
    if (this.win && !this.win.isDestroyed()) {
      this.reveal();
      return;
    }
    this.booting = true;
    this.failureReason = null;
    this.create(this.pendingPath || "/");
  }

  /**
   * Put the worded failure page on screen after the recovery retry gave up.
   *
   * It replaces the boot surface in place, and `booting` stays true so a later
   * `enterConsole()` is still the in-place console swap. The page is loaded
   * once by the coordinator; recreating a closed window loads it again.
   */
  showBootFailure(reason: FailureReason): void {
    this.booting = true;
    this.failureReason = reason;
    if (this.win && !this.win.isDestroyed()) {
      // A window closed to the tray stays there: the page is updated, but a
      // failure that arrives five minutes later must not steal focus from
      // whatever the person moved on to.
      const visible = this.win.isVisible();
      this.loadFailurePage(reason);
      if (visible) this.reveal();
      return;
    }
    this.create(this.pendingPath || "/");
  }

  /**
   * The daemon answered: put the console on screen at `path`.
   *
   * When the boot surface is up this is the in-place swap and the only place
   * `window-first-load` may come from; when no window exists (a background
   * launch) it behaves like `show()`.
   */
  enterConsole(path: string): void {
    if (!this.win || this.win.isDestroyed()) {
      this.booting = false;
      this.create(asConsolePath(path));
      return;
    }
    if (this.booting) {
      this.reloadWhenReady(path);
      return;
    }
    this.show(path);
  }

  /** Bring the existing window forward without loading a page. */
  revealWindow(): void {
    this.reveal();
  }

  hide(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.hide();
    }
    this.hideDockIfNoWindows();
  }

  /**
   * Re-load the current (or given) path once the daemon/token is known ready.
   * Used after sidecar.ensureRunning so a white failed first paint recovers
   * without the user closing and reopening.
   */
  reloadWhenReady(path?: string): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.booting = false;
    this.failureReason = null;
    this.loadAttempts = 0;
    this.clearLoadRetry();
    this.navigate(path ?? this.pendingPath);
  }

  /** Show, restore and focus the existing window. */
  private reveal(): void {
    if (!this.win || this.win.isDestroyed()) return;
    if (this.win.isMinimized()) this.win.restore();
    this.win.show();
    this.win.focus();
    this.showDock();
  }

  private create(path: string): void {
    // The rect and the state come from one read of the file: taking the state
    // from the rect would type-check (the flags are optional) and always say
    // `normal`, because `restoreWindowBounds` returns no flags.
    const { rect: bounds, state } = loadWindow();
    const iconPath = appIconPath();
    const opts: BrowserWindowConstructorOptions = {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
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
    traceStartup("window-created");

    // Keep OS title bar as Kin even if a page sets <title> later.
    this.win.on("page-title-updated", (e) => {
      e.preventDefault();
      this.win?.setTitle(WINDOW_TITLE);
    });
    this.win.setTitle(WINDOW_TITLE);

    this.win.once("ready-to-show", () => {
      this.win?.setTitle(WINDOW_TITLE);
      // Both restores live here, after the renderer's first paint. `maximize()`
      // shows a hidden window by itself, so doing it in `create()` would put an
      // empty dark window on screen before the page had anything to draw.
      if (state === "maximized") this.win?.maximize();
      // Still called in both states: `maximize()` shows but does not focus, and
      // `show()` on the window it already displayed only raises it.
      traceStartup("window-ready-to-show");
      this.win?.show();
      traceStartup("window-shown");
      // Full screen only once the window is on screen: macOS ignores the
      // request for a window that is not, and a window that is would enter the
      // Space with nothing to animate from.
      if (state === "fullscreen") this.win?.setFullScreen(true);
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
    // A state change is not always a size change — macOS full screen keeps the
    // window's normal bounds and moves it to another Space — so the transitions
    // are recorded too, or the next launch comes back normal.
    this.win.on("maximize", () => this.persistBounds());
    this.win.on("unmaximize", () => this.persistBounds());
    this.win.on("enter-full-screen", () => this.persistBounds());
    this.win.on("leave-full-screen", () => this.persistBounds());

    // Daemon may still be starting when the tray opens the window — retry
    // connection failures instead of leaving a blank Chromium error page.
    this.win.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
        if (!isMainFrame) return;
        if (errorCode === ERR_ABORTED) return;
        if (this.booting) {
          // Retrying here would navigate the daemon URL the boot surface
          // exists to avoid; the settle path loads the console when there is
          // something to answer it.
          console.warn(
            "[kin-desktop] boot page failed to load",
            errorCode,
            errorDescription,
          );
          return;
        }
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
      const url = this.win?.webContents.getURL() ?? "";
      // The boot page is the shell's own file, not the console. The startup
      // measurement reads this mark as "the console's first load" and requires
      // it exactly once, so only a daemon URL may emit it — not the boot page,
      // and not the window's initial about:blank.
      if (isConsoleURL(url)) traceStartup("window-first-load");
      this.loadAttempts = 0;
      this.clearLoadRetry();
      this.rememberPathFromURL(url);
    });

    // SPA client-side routes (pushState) — keep last path so recreate restores session.
    this.win.webContents.on("did-navigate-in-page", (_event, url) => {
      this.rememberPathFromURL(url);
    });
    this.win.webContents.on("did-navigate", (_event, url) => {
      this.rememberPathFromURL(url);
    });

    // Navigation lockdown: only the daemon host and resolved port.
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

    if (this.booting) {
      if (this.failureReason) this.loadFailurePage(this.failureReason);
      else this.loadBootPage();
    } else {
      this.navigate(path);
    }
  }

  /** Load the local boot page. Never a daemon URL, never a retry. */
  private loadBootPage(): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.clearLoadRetry();
    this.failureReason = null;
    console.log("[kin-desktop] boot page", this.pendingPath);
    void this.win.loadFile(BOOT_PAGE);
  }

  /**
   * Load the local failure page. The reason is classified before it gets here
   * (`boot-failure.ts`), so the query carries one of four fixed sentences —
   * never the handshake text, which can name a path or a port.
   */
  private loadFailurePage(reason: FailureReason): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.clearLoadRetry();
    this.failureReason = reason;
    console.log("[kin-desktop] boot failure page", reason);
    const locale = app.getLocale();
    void this.win.loadFile(BOOT_FAILED_PAGE, {
      query: { ...failureCopy(locale, reason), lang: failureLocale(locale) },
    });
  }

  private navigate(path: string): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.pendingPath = asConsolePath(path);
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

  /** Persist SPA path (strip auth token query) for restore-after-recreate. */
  private rememberPathFromURL(url: string): void {
    if (!url || !isAllowedURL(url)) return;
    try {
      const u = new URL(url);
      u.searchParams.delete("token");
      const qs = u.searchParams.toString();
      const next = `${u.pathname}${qs ? `?${qs}` : ""}${u.hash || ""}`;
      if (next && next !== "/tray") {
        this.pendingPath = next.startsWith("/") ? next : `/${next}`;
      }
    } catch {
      /* ignore */
    }
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
    // Quitting from full screen makes macOS leave the Space, and the
    // `leave-full-screen` handler would then record `fullScreen: false` for a
    // window the person left in full screen. The file already holds the last
    // live state by the time the app is quitting, so nothing is lost by
    // stopping here.
    if (this.allowClose) return;
    // The normal rect, never the current one: while maximized or full screen
    // the current bounds are the screen's, and saving those would lose the size
    // the window goes back to.
    saveBounds({
      ...this.win.getNormalBounds(),
      maximized: this.win.isMaximized(),
      fullScreen: this.win.isFullScreen(),
    });
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

function asConsolePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

/** The daemon console itself — http(s) on the one host and port. */
function isConsoleURL(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return isAllowedURL(url);
  } catch {
    return false;
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

function loadWindow(): RestoredWindow {
  const saved = readSavedBounds();
  // A saved position is only meaningful while the display it names is still
  // attached; see window-bounds.ts.
  return restoreWindow(
    saved,
    screen.getAllDisplays().map((display) => display.workArea),
    screen.getPrimaryDisplay().workArea,
  );
}

function readSavedBounds(): SavedBounds {
  try {
    const p = boundsPath();
    if (!existsSync(p)) return { ...DEFAULT_BOUNDS };
    // Whatever the file holds, only two finite positive sizes are a window;
    // anything else is the defaults, not an exception inside create().
    return savedBoundsFrom(JSON.parse(readFileSync(p, "utf8"))) ?? { ...DEFAULT_BOUNDS };
  } catch {
    return { ...DEFAULT_BOUNDS };
  }
}

function saveBounds(b: SavedBounds): void {
  try {
    const p = boundsPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(b), "utf8");
  } catch {
    /* ignore */
  }
}
