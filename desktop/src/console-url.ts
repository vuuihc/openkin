/**
 * The one URL rule the window applies to a load.
 *
 * `window.ts` uses it twice — navigation lockdown and "did this load finish on
 * the console?" — and the console-interactive mark needs the same answer from
 * the IPC side. It lives here so the two call sites cannot drift: a URL that
 * may be loaded is not necessarily the console (the boot page is `file://`),
 * and the console is always a daemon URL.
 */

import { DAEMON_HOST, DAEMON_PORT } from "./config";

/** True for any URL the window may load: about:, or the daemon's host and port. */
export function isAllowedURL(url: string): boolean {
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

/** The daemon console itself — http(s) on the one host and port. */
export function isConsoleURL(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return isAllowedURL(url);
  } catch {
    return false;
  }
}
