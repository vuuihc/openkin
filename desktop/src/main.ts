/**
 * Kin desktop shell — Electron main process.
 *
 * Responsibilities: tray, sidecar lifecycle, main window (loads daemon UI),
 * native notifications driven by the daemon WebSocket. No business logic.
 */
import { app } from "electron";
import { Sidecar } from "./sidecar";
import { MainWindow } from "./window";
import { AppTray } from "./tray";
import { DaemonWS } from "./ws-client";
import { Notifier } from "./notifications";
import {
  listPendingApprovals,
  type Approval,
  type WSMessage,
} from "./daemon-api";

const sidecar = new Sidecar();
const mainWindow = new MainWindow();
let tray: AppTray | null = null;
let ws: DaemonWS | null = null;
let notifier: Notifier | null = null;
let pending: Approval[] = [];
let quitting = false;

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
  if (msg.kind === "approval_update") {
    if (msg.data.decision === "pending") {
      // List endpoint joins task_title; WS payload often lacks it.
      void refreshPending().then((list) => {
        const full = list.find((x) => x.id === msg.data.id) ?? msg.data;
        notifier?.onApproval(full);
      });
    } else {
      pending = pending.filter((x) => x.id !== msg.data.id);
      tray?.setPending(pending);
    }
    return;
  }

  if (msg.kind === "event") {
    // Daemon also emits type=approval_requested as kind=event.
    // Tray/badge already handled via approval_update; no second notification.
    if (msg.data.type === "approval_requested") {
      void refreshPending();
    }
    return;
  }

  if (msg.kind === "task_update") {
    notifier?.onTaskUpdate(msg.data);
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

function setupTray(): void {
  tray = new AppTray({
    openKin: () => mainWindow.show("/"),
    openApproval: (id) => mainWindow.openApproval(id),
    startDaemon: () => {
      void (async () => {
        await sidecar.startFromMenu();
        connectWS();
        await refreshPending();
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
      void quitApp();
    },
    getDaemonRunning: () => {
      const s = sidecar.current.state;
      return s === "external" || s === "spawned";
    },
    getWeOwnDaemon: () => sidecar.weOwnProcess,
  });
  tray.create();
}

async function quitApp(): Promise<void> {
  if (quitting) return;
  quitting = true;
  mainWindow.prepareQuit();
  ws?.disconnect();
  await sidecar.stopIfOwned();
  tray?.destroy();
  app.quit();
}

console.log("[kin-desktop] main process starting", {
  electron: process.versions.electron,
  node: process.versions.node,
  packaged: app.isPackaged,
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  console.log("[kin-desktop] another instance holds the lock; exiting");
  app.quit();
} else {
  app.on("second-instance", () => {
    mainWindow.show("/");
  });

  app
    .whenReady()
    .then(async () => {
      console.log("[kin-desktop] app ready");

      // Menu-bar default: hide dock until the window is shown.
      if (process.platform === "darwin" && app.dock) {
        app.dock.hide();
      }

      if (process.platform !== "darwin") {
        console.warn(
          "[kin-desktop] only macOS (darwin-arm64) is supported for now; continuing best-effort",
        );
      }

      setupTray();

      notifier = new Notifier({
        openApproval: (id) => mainWindow.openApproval(id),
        openTask: (id) => mainWindow.show(`/tasks/${encodeURIComponent(id)}`),
        getToken: () => sidecar.readToken(),
        onDecided: () => {
          void refreshPending();
        },
      });

      const status = await sidecar.ensureRunning();
      console.log("[kin-desktop] sidecar status", JSON.stringify(status));

      if (status.state !== "unavailable") {
        connectWS();
        await refreshPending();
      } else {
        console.error(
          "[kin-desktop] daemon unavailable:",
          status.state === "unavailable" ? status.reason : "",
        );
      }

      // Stay in the menu bar; user opens the window via the tray.
      console.log(
        "[kin-desktop] tray setup complete — idle in menu bar (window hidden)",
      );
    })
    .catch((err) => {
      console.error("[kin-desktop] startup failed", err);
    });

  app.on("activate", () => {
    mainWindow.show("/");
  });

  // Keep running in the tray when all windows are closed (all platforms).
  app.on("window-all-closed", () => {
    /* intentionally empty — do not app.quit() */
  });

  app.on("before-quit", () => {
    mainWindow.prepareQuit();
  });

  app.on("will-quit", (e) => {
    if (quitting) return;
    e.preventDefault();
    void quitApp();
  });
}

process.on("unhandledRejection", (err) => {
  console.error("[kin-desktop] unhandledRejection", err);
});
