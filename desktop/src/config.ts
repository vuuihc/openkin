import electron from "electron";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// A default import, not `{ app }`: `node --test` loads this module (see
// config.env.test.ts) and the electron package resolves to a path string
// outside the shell, which has no named `app` export. The shell still gets the
// real API — esbuild's CJS interop hands back the module object.
const { app } = electron;

/** Default daemon loopback bind (matches Go server). */
export const DAEMON_HOST = "127.0.0.1";

/** The daemon port when KIN_PORT is absent or not a port. */
const DEFAULT_DAEMON_PORT = 7777;

/** Environment slice the resolvers read; `process.env` satisfies it. */
export type ShellEnv = Record<string, string | undefined>;

/**
 * KIN_PORT when it is an integer port (1–65535), else the daemon default.
 * `cmd/kin` reads the same variable, so an exported value keeps the shell and
 * the daemon it spawns on one port. Anything unparseable is ignored rather
 * than passed through: a typo must not move the shell off the daemon.
 */
export function resolveDaemonPort(env: ShellEnv): number {
  const raw = env.KIN_PORT;
  if (raw === undefined || !/^\d+$/.test(raw)) return DEFAULT_DAEMON_PORT;
  const port = Number(raw);
  return port >= 1 && port <= 65535 ? port : DEFAULT_DAEMON_PORT;
}

/** KIN_STATE_DIR when non-empty, else `<home>/.kin` (the daemon's default). */
export function resolveStateDir(env: ShellEnv, home: string): string {
  const raw = env.KIN_STATE_DIR;
  if (raw !== undefined && raw.trim() !== "") return raw;
  return join(home, ".kin");
}

/**
 * KIN_DESKTOP_USER_DATA when non-empty, else null. A measurement or test shell
 * sets this so its Electron singleton lock lives in a throwaway directory and
 * cannot collide with the live shell's.
 */
export function resolveUserDataDir(env: ShellEnv): string | null {
  const raw = env.KIN_DESKTOP_USER_DATA;
  if (raw === undefined || raw.trim() === "") return null;
  return raw;
}

export const DAEMON_PORT = resolveDaemonPort(process.env);
export const DAEMON_BASE = `http://${DAEMON_HOST}:${DAEMON_PORT}`;
export const DAEMON_WS = `ws://${DAEMON_HOST}:${DAEMON_PORT}/api/ws`;

export const STATE_DIR = resolveStateDir(process.env, homedir());
export const TOKEN_PATH = join(STATE_DIR, "token");

/** True when running from `electron .` / `npm run dev` (not a release build). */
export function isDev(): boolean {
  // Branded macOS Kin.app clone can make app.isPackaged flip true; env wins.
  if (process.env.KIN_DESKTOP_DEV === "1") return true;
  return !app.isPackaged;
}

/**
 * Path to the `kin` binary.
 * - Dev: repo-root `./kin` (cwd may be desktop/; walk up).
 * - Packaged: extraResources `kin` next to the app.
 */
export function kinBinaryPath(): string {
  if (!isDev()) {
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

/**
 * App / Dock / window icon.
 *
 * Always a PNG: macOS ships the bundle icon as `.icns`, but `nativeImage`
 * cannot decode that container and hands back an empty image, which used to
 * leave a packaged build with a logged warning and no runtime icon at all.
 * `assets/**` is inside the asar, so the PNG is there in both modes.
 */
export function appIconPath(): string {
  const candidates = [
    join(app.getAppPath(), "assets", "icon.png"),
    join(__dirname, "..", "assets", "icon.png"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return candidates[candidates.length - 1]!;
}

/** electron-store-free bounds key path under userData. */
export function boundsPath(): string {
  return join(app.getPath("userData"), "window-bounds.json");
}
