/**
 * Preload bridge for the Kin desktop shell.
 * Exposes a minimal, safe API to the daemon-served SPA (127.0.0.1:7777).
 */
import { contextBridge, ipcRenderer } from "electron";

export type KinDesktopAPI = {
  /** True when running inside the Electron shell. */
  isDesktop: true;
  platform: NodeJS.Platform;
  /**
   * Open the OS native folder picker (macOS / Windows / Linux).
   * Returns absolute path, or null if cancelled.
   */
  selectDirectory: (opts?: { defaultPath?: string; title?: string }) => Promise<string | null>;
};

const api: KinDesktopAPI = {
  isDesktop: true,
  platform: process.platform,
  selectDirectory: (opts) =>
    ipcRenderer.invoke("kin:select-directory", opts ?? {}) as Promise<string | null>,
};

contextBridge.exposeInMainWorld("kinDesktop", api);
