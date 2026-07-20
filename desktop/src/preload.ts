/**
 * Preload bridge for the Kin desktop shell.
 * Exposes a minimal, safe API to the daemon-served SPA (127.0.0.1:7777).
 */

import { contextBridge, ipcRenderer } from "electron";
import type { ExternalApp, ExternalAppId } from "./open-external";

export type KinDesktopAPI = {
  /** True when running inside the Electron shell. */
  isDesktop: true;
  platform: string;
  /**
   * Open the OS native folder picker (macOS / Windows / Linux).
   * Returns absolute path, or null if cancelled.
   */
  selectDirectory: (opts?: {
    defaultPath?: string;
    title?: string;
  }) => Promise<string | null>;
  /** Detect installed editors / file managers for "Open in…". */
  listExternalApps: () => Promise<ExternalApp[]>;
  /** Open an absolute filesystem path in a detected app. */
  openInApp: (
    path: string,
    appId: ExternalAppId,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
};

const api: KinDesktopAPI = {
  isDesktop: true,
  platform: process.platform,
  selectDirectory: (opts) =>
    ipcRenderer.invoke("kin:select-directory", opts ?? {}),
  listExternalApps: () => ipcRenderer.invoke("kin:list-external-apps"),
  openInApp: (path, appId) =>
    ipcRenderer.invoke("kin:open-in-app", { path, appId }),
};

contextBridge.exposeInMainWorld("kinDesktop", api);
