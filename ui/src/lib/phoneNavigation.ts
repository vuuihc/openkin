import type { MouseEvent as ReactMouseEvent } from "react";
import type { Location, NavigateFunction } from "react-router-dom";
import { runGuardedNavigation } from "./leaveGuard";

/**
 * The phone's push contract, and the list URL it returns to.
 *
 * KIN-CONTINUE-002 makes the conversation list the parent of every pushed
 * screen. A row or link reached from the list is one push, so Back is one step.
 * The same destination opened from a *different* surface — a project cover, a
 * routine run, the palette, the draft's new-chat entry point — must not keep
 * that surface underneath: Back would land on the project, the routine or an
 * old destination instead of the list.
 *
 * So on a phone, pushing a conversation or the draft from anything but the
 * list first replaces the current entry with the list's last URL; the target
 * is pushed on top of it. The browser's own Back then lands on the list too,
 * not only the in-app controls. The Mac keeps ordinary history: its sidebar is
 * always on screen, so the main pane's stack is the reader's own.
 *
 * The list URL is remembered whenever the list is on screen, including its
 * `?search=`, `?status=` and `?scope=` params. That is what a Back should put
 * back, not a bare `/sessions`.
 */
const LIST_PATH = "/sessions";
const LIST_URL_KEY = "kin.listUrl";
const PHONE_QUERY = "(min-width: 768px)";
const LIST_STATE_KEYS = ["search", "status", "scope"] as const;

export function isPhoneLayout(win: Window = window): boolean {
  if (typeof win.matchMedia !== "function") return false;
  return !win.matchMedia(PHONE_QUERY).matches;
}

/**
 * Whether this router has a real entry behind it.
 *
 * The test is the browser's own stack (`idx`), but only when the document URL
 * is the route being rendered. A MemoryRouter never moves the document, so a
 * leftover history state from another test or an earlier browser session must
 * not be mistaken for this route's parent.
 */
export function routerHasParent(
  location: Pick<Location, "pathname"> & { state?: unknown },
): boolean {
  if (typeof window === "undefined") return false;
  if (window.location.pathname !== location.pathname) return false;
  const state = window.history.state as { idx?: unknown } | null;
  return typeof state?.idx === "number" && state.idx > 0;
}

function isListPath(pathname: string): boolean {
  return pathname === LIST_PATH;
}

/** Keep the list's own params, in a stable order, so two spellings of the
 *  same view do not produce two history entries. */
export function listUrlFor(search: string, fallback = LIST_PATH): string {
  const params = new URLSearchParams(search);
  const next = new URLSearchParams();
  for (const key of LIST_STATE_KEYS) {
    const value = params.get(key);
    if (value) next.set(key, value);
  }
  const text = next.toString();
  return text ? `${LIST_PATH}?${text}` : fallback;
}

/** Remember the list the reader is looking at, params included. */
export function rememberListUrl(url: string): void {
  if (!url.startsWith(LIST_PATH)) return;
  try {
    window.sessionStorage.setItem(LIST_URL_KEY, url);
  } catch {
    // No storage: the fallback is the plain list.
  }
}

/** The last list URL this tab showed, or the plain list. */
export function lastListUrl(fallback = LIST_PATH): string {
  try {
    const stored = window.sessionStorage.getItem(LIST_URL_KEY);
    return stored && stored.startsWith(LIST_PATH) ? stored : fallback;
  } catch {
    return fallback;
  }
}

/** The list URL a screen at `location` should return to. */
export function returnListUrl(location: Pick<Location, "pathname" | "search">): string {
  if (isListPath(location.pathname)) return listUrlFor(location.search);
  return lastListUrl();
}

/** Extra location state a draft entry carries, so closing it can restore the
 *  exact list the person came from rather than a bare `/sessions`. */
export type DraftEntryState = { kinDraftFrom?: string };

export function draftEntryState(from: string): DraftEntryState {
  return { kinDraftFrom: from };
}

/** Where closing the draft should land. A recorded origin wins; a cold `/new`
 *  has none and falls back to the last list URL. */
export function draftReturnUrl(state: unknown, fallback = LIST_PATH): string {
  const from = (state as DraftEntryState | null)?.kinDraftFrom;
  return from && from.startsWith(LIST_PATH) ? from : lastListUrl(fallback);
}

/**
 * Push a phone screen, giving it the list as its parent when it was opened
 * from somewhere else. No guard is asked here; callers wrap this in
 * `runGuardedNavigation`.
 */
export function phonePush(
  navigate: NavigateFunction,
  location: Pick<Location, "pathname" | "search">,
  to: string,
  options?: { replace?: boolean; phone?: boolean; state?: unknown },
): void {
  const phone = options?.phone ?? isPhoneLayout();
  if (phone && !isListPath(location.pathname)) {
    navigate(lastListUrl(), { replace: true });
  }
  const navigateOptions =
    options?.replace === undefined && options?.state === undefined
      ? undefined
      : { replace: options?.replace, state: options?.state };
  navigate(to, navigateOptions);
}

/**
 * The click handler for a real `<Link>` that must honour both the page's leave
 * guard and the phone push contract.
 *
 * Modifier clicks are left alone: opening a link in a new tab does not leave
 * this page, so there is nothing to ask, and the browser's own behaviour is
 * better than a reimplementation.
 */
export function onGuardedLinkClick(
  event: ReactMouseEvent,
  navigate: NavigateFunction,
  location: Pick<Location, "pathname" | "search">,
  to: string,
  options?: { approved?: boolean },
): boolean {
  if (event.defaultPrevented) return false;
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return false;
  }
  event.preventDefault();
  return runGuardedNavigation(
    () => phonePush(navigate, location, to),
    options?.approved === true,
  );
}
