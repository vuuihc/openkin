/**
 * Kin desktop shell — Electron main process.
 *
 * Responsibilities: tray + design popover, sidecar lifecycle, main window
 * (loads daemon UI), native notifications driven by the daemon WebSocket.
 */
import { app, nativeImage, Notification } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Sidecar } from "./sidecar";
import { MainWindow } from "./window";
import { AppTray } from "./tray";
import { TrayPopover } from "./tray-popover";
import { DaemonWS } from "./ws-client";
import { Notifier } from "./notifications";
import { routeNotifyMessage } from "./native-notifications";
import { taskIdFromURL } from "./task-notifications";
import { retryWhileUnavailable } from "./daemon-retry";
import { registerIpcHandlers } from "./ipc";
import { appIconPath, isDev } from "./config";
import {
  listPendingApprovals,
  type Approval,
  type WSMessage,
} from "./daemon-api";

// Logging must never be fatal. stdout/stderr are pipes that can break — the shell
// that launched the app exits, or `npm run dev` runs under a pipe that closes. A
// failed write emits 'error' on the stream, and with no listener that surfaces as
// an uncaught exception (write EIO) that aborts the main process.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", () => {});
}

// Branding before ready: unpackaged `electron .` otherwise shows "Electron"
// in the menu bar / About / some process lists. productName only applies when packaged.
const APP_NAME = "Kin";
app.setName(APP_NAME);
process.title = APP_NAME;

// Dev: isolate userData so singleton lock doesn't collide with a packaged
// /Applications/Kin.app (or a zombie from a previous npm run dev).
// Must run before requestSingleInstanceLock().
if (process.env.KIN_DESKTOP_DEV === "1") {
  app.setPath("userData", join(app.getPath("appData"), "Kin-dev"));
}

const sidecar = new Sidecar();
const mainWindow = new MainWindow();
// Always read the live token file — tray can open the window before ensureRunning
// finishes and writes/refreshes ~/.kin/token.
mainWindow.setTokenSource(() => sidecar.readToken());

let tray: AppTray | null = null;
let popover: TrayPopover | null = null;
let ws: DaemonWS | null = null;
let notifier: Notifier | null = null;
let pending: Approval[] = [];
let quitting = false;
let pendingDeepLinkPath: string | null = null;

const DEEP_LINK_SCHEME = "kin";

function registerDeepLinkProtocol(): void {
  try {
    if (process.defaultApp && process.argv[1]) {
      app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [
        process.argv[1],
      ]);
    } else {
      app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
    }
  } catch (err) {
    console.warn("[kin-desktop] register deep link protocol failed", err);
  }
}

function pathFromDeepLink(rawURL: string): string | null {
  try {
    const u = new URL(rawURL);
    if (u.protocol !== `${DEEP_LINK_SCHEME}:`) return null;
    let path = u.pathname || "/";
    if (u.hostname === "settings") {
      path = "/settings";
    } else if (u.hostname) {
      path = `/${u.hostname}${u.pathname === "/" ? "" : u.pathname}`;
    }
    const qs = u.searchParams.toString();
    return `${path.startsWith("/") ? path : `/${path}`}${qs ? `?${qs}` : ""}${u.hash || ""}`;
  } catch {
    return null;
  }
}

function handleDeepLink(rawURL: string): boolean {
  const path = pathFromDeepLink(rawURL);
  if (!path) return false;
  console.log("[kin-desktop] deep link", path);
  if (!app.isReady()) {
    pendingDeepLinkPath = path;
    return true;
  }
  mainWindow.show(path);
  return true;
}

function deepLinkFromArgv(argv: string[]): string | null {
  return argv.find((arg) => arg.startsWith(`${DEEP_LINK_SCHEME}://`)) ?? null;
}

/**
 * True when this launch should stay out of the way: started by the OS at login,
 * or explicitly asked to start hidden.
 *
 * Everything else — a double-click in Finder, `open -a Kin`, a relaunch after
 * quitting — is someone asking to see Kin, so it must put a window on screen.
 * Idling in the menu bar on those launches is what made a second launch look
 * like the first one had failed.
 */
function isBackgroundLaunch(): boolean {
  if (process.argv.includes("--hidden") || process.argv.includes("--background")) {
    return true;
  }
  if (process.platform !== "darwin") return false;
  try {
    return app.getLoginItemSettings().wasOpenedAtLogin;
  } catch {
    return false;
  }
}

function applyAppBranding(): void {
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    copyright: "Copyright © Kin contributors",
  });

  const iconPath = appIconPath();
  if (!existsSync(iconPath)) {
    console.warn("[kin-desktop] app icon missing:", iconPath);
    return;
  }
  const image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) {
    console.warn("[kin-desktop] app icon failed to load:", iconPath);
    return;
  }
  // Dev dock uses Electron's default binary icon unless we override.
  if (process.platform === "darwin" && app.dock) {
    app.dock.setIcon(image);
  }
  console.log("[kin-desktop] branding applied", {
    name: app.getName(),
    iconPath,
  });
}

async function refreshPending(): Promise<Approval[]> {
  const token = sidecar.readToken();
  if (!token) {
    pending = [];
    tray?.setPending([]);
    return [];
  }
  try {
    pending = await listPendingApprovals(token);
    tray?.setPending(pending);
    return pending;
  } catch (err) {
    console.warn("[kin-desktop] refresh pending failed", err);
    return pending;
  }
}

function handleWSMessage(msg: WSMessage): void {
  // One notification path for every kind. The state messages below still
  // refresh the tray and pending list; they no longer raise banners of their
  // own, because the node already decided what this event should say.
  if (msg.kind === "notify") {
    if (notifier) routeNotifyMessage(msg, notifier);
    return;
  }

  if (msg.kind === "approval_update") {
    if (msg.data.decision === "pending") {
      void refreshPending();
    } else {
      pending = pending.filter((x) => x.id !== msg.data.id);
      tray?.setPending(pending);
    }
    return;
  }

  if (msg.kind === "event") {
    if (msg.data.type === "approval_requested") {
      void refreshPending();
    }
    return;
  }

  if (msg.kind === "task_update") {
    if (
      msg.data.status === "succeeded" ||
      msg.data.status === "failed" ||
      msg.data.status === "canceled"
    ) {
      void refreshPending();
    }
  }
}

function connectWS(): void {
  const token = sidecar.readToken();
  if (!token) {
    console.warn("[kin-desktop] no token at ~/.kin/token — WS deferred");
    return;
  }
  mainWindow.setToken(token);
  if (!ws) {
    ws = new DaemonWS({
      onMessage: handleWSMessage,
      onStatus: (s) => console.log(`[kin-desktop] WS status=${s}`),
    });
  }
  ws.connect(token);
}

function announceDaemonUnavailable(reason: string): void {
  if (!Notification.isSupported()) return;
  new Notification({ title: "Kin daemon", body: reason }).show();
}

let recovering = false;

/**
 * Keep asking for a daemon that did not show up.
 *
 * "Unavailable" is not always an ending: the usual cause here is the installed
 * node's supervisor restarting its child, which takes seconds and can outlast
 * the single wait startup does. Nothing else in the shell asks again — the
 * window would sit on a dead URL until the person clicked Start — so one slow
 * retry runs in the background and wires everything up when a daemon appears.
 * A person who stopped the daemon on purpose is left alone. See daemon-retry.ts.
 */
async function recoverWhenDaemonAppears(): Promise<void> {
  if (recovering) return;
  recovering = true;
  try {
    const outcome = await retryWhileUnavailable({
      ensureRunning: () => sidecar.ensureRunning(),
      resolved: () =>
        sidecar.isStopped || sidecar.current.state !== "unavailable",
    });
    console.log(`[kin-desktop] daemon retry → ${outcome}`);
    if (outcome !== "ready") return;
    connectWS();
    await refreshPending();
    mainWindow.reloadWhenReady();
    popover?.reloadWhenReady();
    tray?.refresh();
  } finally {
    recovering = false;
  }
}

function setupTray(): void {
  popover = new TrayPopover({
    openMain: (path) => {
      popover?.hide();
      mainWindow.show(path || "/");
    },
    getToken: () => sidecar.readToken(),
  });

  tray = new AppTray({
    openKin: () => {
      popover?.hide();
      mainWindow.show("/");
    },
    openApproval: (id) => {
      popover?.hide();
      mainWindow.openApproval(id);
    },
    togglePopover: (bounds) => {
      popover?.toggle(bounds);
    },
    startDaemon: () => {
      void (async () => {
        const status = await sidecar.startFromMenu();
        console.log("[kin-desktop] start daemon →", JSON.stringify(status));
        // Start can now end in "unavailable" without a spawn: something is
        // already on the port but not answering. The tray only says "stopped",
        // so say why — and keep asking, in case that something is a supervisor
        // about to bring the daemon back.
        if (status.state === "unavailable") {
          announceDaemonUnavailable(status.reason);
          void recoverWhenDaemonAppears();
        }
        connectWS();
        await refreshPending();
        // Recover any window that opened while the daemon was down.
        mainWindow.reloadWhenReady();
        popover?.reloadWhenReady();
        tray?.refresh();
      })();
    },
    stopDaemon: () => {
      void (async () => {
        const r = await sidecar.stopFromMenu();
        console.log("[kin-desktop]", r.message);
        tray?.refresh();
      })();
    },
    quit: () => {
      quitApp();
    },
    getDaemonRunning: () => {
      const s = sidecar.current.state;
      return s === "external" || s === "spawned";
    },
    getWeOwnDaemon: () => sidecar.weOwnProcess,
  });
  tray.create();
}

/**
 * Everything that has to happen before the process goes away, for every quit
 * Electron announces — the app menu (Cmd-Q, an Apple Event), the dock, or the
 * tray. `app.exit()` skips the lifecycle events by design and is used only
 * before there is a window to clean up after.
 *
 * This ran from `will-quit` once, which prevented the default and then called
 * `app.quit()` again. That second request is made while the first quit is still
 * unwinding, and Electron ignores it: Cmd-Q closed the window and left the
 * process running. Doing the work in `before-quit` and preventing nothing
 * leaves exactly one quit in flight.
 */
function beginQuit(): void {
  if (quitting) return;
  quitting = true;
  mainWindow.prepareQuit();
  ws?.disconnect();
  // Closing Electron must not cancel daemon-managed work. The tray Stop
  // action is the explicit operation that terminates a daemon we spawned.
  sidecar.detach();
  popover?.destroy();
  tray?.destroy();
}

function quitApp(): void {
  beginQuit();
  app.quit();
}

console.log("[kin-desktop] main process starting", {
  electron: process.versions.electron,
  node: process.versions.node,
  packaged: app.isPackaged,
  dev: isDev(),
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // Primary is still alive (or lock not cleared yet). It will get second-instance
  // and should focus the window. This process must exit — not a crash.
  console.error(
    "[kin-desktop] another Kin desktop instance is already running — exiting.\n" +
      "  Tip: quit the menu-bar Kin first, or re-run `npm run dev` (dev launcher kills prior instances).",
  );
  app.exit(0);
} else {
  app.on("second-instance", (_event, argv) => {
    const deepLink = deepLinkFromArgv(argv);
    if (deepLink && handleDeepLink(deepLink)) return;
    // Re-launch / second npm run: bring UI forward instead of looking dead.
    mainWindow.show("/");
  });

  app.on("open-url", (event, rawURL) => {
    event.preventDefault();
    handleDeepLink(rawURL);
  });

  app
    .whenReady()
    .then(async () => {
      console.log("[kin-desktop] app ready");
      registerDeepLinkProtocol();
      applyAppBranding();
      registerIpcHandlers();

      // Production: menu-bar app, hide Dock until a window is shown.
      // Dev: keep Dock + open the window so launch doesn't look like a crash.
      if (process.platform === "darwin" && app.dock && !isDev()) {
        app.dock.hide();
      }

      if (process.platform !== "darwin") {
        console.warn(
          "[kin-desktop] only macOS (darwin-arm64) is supported for now; continuing best-effort",
        );
      }

      // Seed token early so a tray open during ensureRunning still has a shot
      // when ~/.kin/token already exists from a previous serve.
      mainWindow.setToken(sidecar.readToken());

      setupTray();

      notifier = new Notifier({
        openPath: (path) => mainWindow.show(path),
        getToken: () => sidecar.readToken(),
        onDecided: () => {
          void refreshPending();
        },
        // The console URL says which task is on screen; the window says whether
        // anyone is looking at it.
        isFocused: () => mainWindow.browserWindow?.isFocused() ?? false,
        viewingTaskId: () =>
          taskIdFromURL(mainWindow.browserWindow?.webContents.getURL() ?? ""),
        origin: () => {
          try {
            return new URL(mainWindow.browserWindow?.webContents.getURL() ?? "").origin;
          } catch {
            return null;
          }
        },
      });

      const status = await sidecar.ensureRunning();
      console.log("[kin-desktop] sidecar status", JSON.stringify(status));

      if (status.state !== "unavailable") {
        connectWS();
        await refreshPending();
        // If the user already opened the window while the daemon was booting,
        // the first loadURL may have failed — force a clean reload now.
        mainWindow.reloadWhenReady();
        popover?.reloadWhenReady();
      } else {
        console.error(
          "[kin-desktop] daemon unavailable:",
          status.state === "unavailable" ? status.reason : "",
        );
        // Say why — the window is about to load a URL nothing answers — and
        // keep asking in the background.
        announceDaemonUnavailable(status.reason);
        void recoverWhenDaemonAppears();
      }

      const launchPath = pendingDeepLinkPath;
      pendingDeepLinkPath = null;
      if (launchPath) {
        mainWindow.show(launchPath);
      } else if (isBackgroundLaunch()) {
        console.log(
          "[kin-desktop] background launch — idle in menu bar (window hidden)",
        );
      } else {
        mainWindow.show("/");
        console.log("[kin-desktop] main window opened");
      }
    })
    .catch((err) => {
      console.error("[kin-desktop] startup failed", err);
    });

  app.on("activate", () => {
    mainWindow.show("/");
  });

  app.on("window-all-closed", () => {
    /* intentionally empty — do not app.quit() */
  });

  app.on("before-quit", () => {
    // The one place cleanup runs, whatever asked for the quit. `will-quit` must
    // not prevent the default: a second `app.quit()` from inside that handler
    // is ignored, which is how Cmd-Q used to leave the process alive.
    beginQuit();
  });
}

process.on("unhandledRejection", (err) => {
  console.error("[kin-desktop] unhandledRejection", err);
});
