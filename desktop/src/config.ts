import { app } from "electron";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Default daemon loopback bind (matches Go server). */
export const DAEMON_HOST = "127.0.0.1";
export const DAEMON_PORT = 7777;
export const DAEMON_BASE = `http://${DAEMON_HOST}:${DAEMON_PORT}`;
export const DAEMON_WS = `ws://${DAEMON_HOST}:${DAEMON_PORT}/api/ws`;

export const STATE_DIR = join(homedir(), ".kin");
export const TOKEN_PATH = join(STATE_DIR, "token");

/** True when running from `electron .` / `npm run dev` (not packaged). */
export function isDev(): boolean {
  return !app.isPackaged;
}

/**
 * Path to the `kin` binary.
 * - Dev: repo-root `./kin` (cwd may be desktop/; walk up).
 * - Packaged: extraResources `kin` next to the app.
 */
export function kinBinaryPath(): string {
  if (app.isPackaged) {
    // process.resourcesPath → …/Kin.app/Contents/Resources
    return join(process.resourcesPath, "kin");
  }
  // desktop/ is cwd when launched via make desktop-dev
  const candidates = [
    resolve(process.cwd(), "..", "kin"),
    resolve(process.cwd(), "kin"),
    resolve(app.getAppPath(), "..", "kin"),
    resolve(app.getAppPath(), "..", "..", "kin"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return candidates[0];
}

/** Tray template icon (macOS). nativeImage can read from asar. */
export function trayIconPath(): string {
  const fromApp = join(app.getAppPath(), "assets", "trayTemplate.png");
  if (existsSync(fromApp)) return fromApp;
  return join(__dirname, "..", "assets", "trayTemplate.png");
}

/** electron-store-free bounds key path under userData. */
export function boundsPath(): string {
  return join(app.getPath("userData"), "window-bounds.json");
}
