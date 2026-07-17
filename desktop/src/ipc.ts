/**
 * Main-process IPC handlers for the desktop shell.
 */
import { BrowserWindow, dialog, ipcMain } from "electron";

export type SelectDirectoryOpts = {
  defaultPath?: string;
  title?: string;
};

let registered = false;

/** Idempotent registration (safe across reloads in dev). */
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

  console.log("[kin-desktop] IPC handlers registered");
}
