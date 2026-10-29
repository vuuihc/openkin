/**
 * Whether opening the tray popover has to load its page again.
 *
 * The popover is a window that hides rather than closes, and the page inside it
 * is live: it holds a WebSocket to the daemon and updates itself. Loading it
 * again on every click resets its scroll position and costs a full SPA boot for
 * a window that was already up to date — the flash was the most noticeable
 * thing about opening it. The page only has to be fetched when there is none
 * yet (the window was just created) or when it is not the tray page (a failed
 * load left an error page, or something navigated it away).
 */
export function popoverNeedsLoad(currentURL: string, trayURL: string): boolean {
  if (!currentURL.startsWith(trayURL)) return true;
  // `/tray` is a whole route: `/trays` or `/tray-anything` is a different page.
  const next = currentURL.charAt(trayURL.length);
  return next !== "" && next !== "?" && next !== "#" && next !== "/";
}

/**
 * Whether the page is holding a token the daemon no longer accepts.
 *
 * Keeping the page means keeping the token it captured from its URL. The token
 * file is written once and normally outlives the shell, but if it is ever
 * replaced, the popover would sit there answering 401 until the app restarts —
 * the one piece of state that can go stale behind a page that is otherwise
 * live.
 */
export function popoverTokenIsStale(
  currentURL: string,
  token: string | null,
): boolean {
  if (!token) return false;
  try {
    return new URL(currentURL).searchParams.get("token") !== token;
  } catch {
    return true;
  }
}
