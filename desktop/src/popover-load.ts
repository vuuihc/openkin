/**
 * Whether opening the tray popover has to load its page again.
 *
 * The popover is a window that hides rather than closes, and the page inside it
 * is live: it holds a WebSocket to the daemon and updates itself. Loading it
 * again on every click resets its scroll position and costs a full SPA boot for
 * a window that was already up to date — the flash was the most noticeable
 * thing about opening it.
 *
 * What the page was loaded with is the shell's memory, not the URL's. The
 * console captures `?token=` at boot and strips it from the address bar
 * (`captureTokenFromURL`), so the live page's URL never carries the token; a
 * check that reads the token back out of that URL decides, wrongly, that every
 * page is stale. The URL survives a failed load unchanged too, so it cannot say
 * "this page never arrived" either. Both facts are recorded where they happen —
 * at the load — and this is the decision over them: a page that never finished
 * loading, a page that is not the tray route, or a page holding a token the
 * daemon has since replaced gets fetched again.
 */
export type PopoverLoadState = {
  /** `webContents.getURL()`: the live page's URL, after its own replaceState. */
  currentURL: string;
  /** True once the last load reached `did-finish-load`. */
  loaded: boolean;
  /** The token the last load was started with; null when none was. */
  loadedToken: string | null;
  /** The token the daemon has now. */
  token: string | null;
};

export function popoverNeedsLoad(
  trayURL: string,
  state: PopoverLoadState,
): boolean {
  if (!state.loaded) return true;
  if (!sameRoute(state.currentURL, trayURL)) return true;
  return (state.loadedToken ?? null) !== (state.token ?? null);
}

/**
 * Whether two URLs name the same page: origin and path, query and hash aside.
 *
 * `/tray` is a whole route: `/trays` or `/tray/settings` is a different page,
 * and a popover showing one would draw the full console in a 360×480 window.
 * A trailing slash is the same route.
 */
export function sameRoute(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    return (
      left.origin === right.origin &&
      trimTrailingSlash(left.pathname) === trimTrailingSlash(right.pathname)
    );
  } catch {
    return false;
  }
}

function trimTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}
