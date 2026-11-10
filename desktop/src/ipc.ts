/**
 * Main-process IPC handlers for the desktop shell.
 */

import { BrowserWindow, dialog, ipcMain } from "electron";
import {
  listExternalApps,
  openPathInApp,
  type ExternalAppId,
} from "./open-external";

type SelectDirectoryOpts = {
  defaultPath?: string;
  title?: string;
};

let registered = false;

export function registerIpcHandlers(): void {
  if (registered) return;
  registered = true;

  ipcMain.handle(
    "kin:select-directory",
    async (event, opts: SelectDirectoryOpts = {}): Promise<string | null> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const properties: Array<
        "openDirectory" | "createDirectory" | "dontAddToRecent"
      > = ["openDirectory", "createDirectory"];

      // Windows: createDirectory is supported; dontAddToRecent avoids cluttering Recents.
      if (process.platform === "win32") {
        properties.push("dontAddToRecent");
      }

      const dialogOpts: Electron.OpenDialogOptions = {
        title: opts.title || "Select working directory",
        defaultPath: opts.defaultPath || undefined,
        properties,
        // macOS-only hint shown above the browser.
        message:
          process.platform === "darwin"
            ? "Choose a project folder for this task"
            : undefined,
      };

      const result = win
        ? await dialog.showOpenDialog(win, dialogOpts)
        : await dialog.showOpenDialog(dialogOpts);

      if (result.canceled || !result.filePaths?.length) {
        return null;
      }
      return result.filePaths[0] ?? null;
    },
  );

  ipcMain.handle("kin:list-external-apps", async () => {
    return listExternalApps();
  });

  ipcMain.handle(
    "kin:open-in-app",
    async (
      _event,
      payload: { path?: string; appId?: ExternalAppId },
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        const path = payload?.path;
        const appId = payload?.appId;
        if (!path || !appId) {
          return { ok: false, error: "path and appId are required" };
        }
        await openPathInApp(path, appId);
        return { ok: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: message };
      }
    },
  );

  console.log("[kin-desktop] IPC handlers registered");
}
