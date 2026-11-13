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
 *
 * "The list is directly underneath" is evidence, not a guess. A location-state
 * marker names an entry this document minted, and the entry's own `key` binds
 * the marker to the exact history entry it was pushed for; a copied marker, a
 * marker left over from a previous document (an OAuth round trip, a reload),
 * or a bare history index that happens to line up is not accepted. The index
 * remains a fallback only for an entry whose marker was erased by a
 * same-entry replace, and only when it belongs to this document.
 */
const LIST_PATH = "/sessions";
const LIST_URL_KEY = "kin.listUrl";
const LIST_IDX_KEY = "kin.listIdx";
const LIST_NONCE_KEY = "kin.listNonce";
const PHONE_QUERY = "(min-width: 768px)";
const LIST_STATE_KEYS = ["search", "status", "scope"] as const;

/** Location state stamped on a destination `phonePush` placed directly above
 *  the list. It is what lets a later push tell "the list is already my parent"
 *  from "some other screen is". */
const LIST_PARENT_KEY = "kinListParent";

type ListParentMarker = { token: string; nonce: string };
type ParentEvidence = { token: string; listUrl: string; listIdx: number | null };

function randomToken(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * This document's identity.
 *
 * `sessionStorage` outlives a full-page navigation, so the list index and URL
 * it holds may describe a different document (an OAuth callback, a redirect
 * back, a reload). A marker minted before that navigation carries the old
 * nonce and is not trusted; neither is stored index evidence. It is not a
 * security boundary — a page can always rewrite its own history — it is what
 * keeps stale evidence from claiming a parent that is no longer there.
 */
let documentNonce = randomToken("kin-doc");

/** The marker awaiting its entry in the router's own location. It is consumed
 *  exactly once, so copying the state onto another entry cannot re-bind. */
let pendingPush: ParentEvidence | null = null;
/** Entry key -> the list evidence that entry was pushed against. */
const entryEvidence = new Map<string, ParentEvidence>();

function markerOf(state: unknown): ListParentMarker | null {
  if (typeof state !== "object" || state === null) return null;
  const raw = (state as Record<string, unknown>)[LIST_PARENT_KEY];
  if (typeof raw !== "object" || raw === null) return null;
  const token = (raw as Record<string, unknown>).token;
  const nonce = (raw as Record<string, unknown>).nonce;
  return typeof token === "string" && typeof nonce === "string" ? { token, nonce } : null;
}

function markerState(state: unknown): Record<string, unknown> {
  const base =
    typeof state === "object" && state !== null ? (state as Record<string, unknown>) : {};
  const token = randomToken("kin-list-parent");
  pendingPush = {
    token,
    listUrl: lastListUrl(),
    listIdx: storedListIndex(),
  };
  return { ...base, [LIST_PARENT_KEY]: { token, nonce: documentNonce } };
}

function historyIndex(): number | null {
  const idx = (window.history.state as { idx?: unknown } | null)?.idx;
  return typeof idx === "number" ? idx : null;
}

function storedListIndex(): number | null {
  try {
    const raw = window.sessionStorage.getItem(LIST_IDX_KEY);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isInteger(value) ? value : null;
  } catch {
    return null;
  }
}

/** The history index of the route's own entry, or null when this is not the
 *  document the router is driving (a MemoryRouter, where window.history is
 *  somebody else's stack and its index says nothing about the route). */
function routeIndex(location: Pick<Location, "pathname">): number | null {
  if (typeof window === "undefined") return null;
  if (window.location.pathname !== location.pathname) return null;
  return historyIndex();
}

/** The list entry this document last showed, or null when the stored evidence
 *  belongs to another document. */
function storedListEvidence(): { url: string; idx: number | null } | null {
  try {
    const url = window.sessionStorage.getItem(LIST_URL_KEY);
    if (!url || !url.startsWith(LIST_PATH)) return null;
    if (window.sessionStorage.getItem(LIST_NONCE_KEY) !== documentNonce) return null;
    return { url, idx: storedListIndex() };
  } catch {
    return null;
  }
}

/**
 * Whether the entry directly below this one is the list.
 *
 * A marker bound to this exact entry key is the explicit answer. A page is
 * allowed to rewrite its own URL — React Router's `setSearchParams(...,
 * { replace: true })`, a project changing tab — and the replace erases the
 * marker while keeping the entry's stack position. The list's index surviving
 * in this document is then the evidence; the same index from a previous
 * document is not.
 */
function listIsDirectParent(
  location: { pathname: string; state?: unknown; key?: string },
): boolean {
  const stored = storedListEvidence();
  if (!stored) return false;
  const idx = routeIndex(location);
  const marker = markerOf(location.state);
  if (marker) {
    if (marker.nonce !== documentNonce) return false;
    const evidence = entryEvidence.get(location.key ?? "");
    if (!evidence || evidence.token !== marker.token) return false;
    if (evidence.listUrl !== stored.url) return false;
    if (evidence.listIdx !== null && idx !== null) return evidence.listIdx === idx - 1;
    return true;
  }
  return (
    location.pathname !== LIST_PATH &&
    idx !== null &&
    stored.idx !== null &&
    idx === stored.idx + 1
  );
}

/** Bind the marker a push just placed in location state to the entry that
 *  actually received it. Called from the shell's location subscription; the
 *  token is spent here, so a state object copied onto a later entry has no
 *  entry evidence and is refused above. */
export function bindPhoneHistoryEntry(
  location: Pick<Location, "pathname" | "search" | "state"> & { key?: string },
): void {
  const pending = pendingPush;
  if (!pending) return;
  const marker = markerOf(location.state);
  if (!marker || marker.nonce !== documentNonce || marker.token !== pending.token) return;
  pendingPush = null;
  entryEvidence.set(location.key ?? "", pending);
}

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

/** A destination URL that is the list itself, with or without its params. */
function isListTarget(to: string): boolean {
  return to === LIST_PATH || to.startsWith(`${LIST_PATH}?`) || to.startsWith(`${LIST_PATH}#`);
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
    window.sessionStorage.setItem(LIST_NONCE_KEY, documentNonce);
    const idx = historyIndex();
    if (idx === null) window.sessionStorage.removeItem(LIST_IDX_KEY);
    else window.sessionStorage.setItem(LIST_IDX_KEY, String(idx));
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
  location: Pick<Location, "pathname" | "search"> & { state?: unknown; key?: string },
  to: string,
  options?: { replace?: boolean; phone?: boolean; state?: unknown },
): void {
  const phone = options?.phone ?? isPhoneLayout();
  if (!phone) {
    const navigateOptions =
      options?.replace === undefined && options?.state === undefined
        ? undefined
        : { replace: options?.replace, state: options?.state };
    navigate(to, navigateOptions);
    return;
  }

  if (isListPath(location.pathname)) {
    if (isListTarget(to)) {
      // Already the list: another view of it is the same screen in the same
      // entry, not a second copy to walk back through.
      navigate(to, { replace: true, state: options?.state });
      return;
    }
    // The list is the parent, so it stays underneath as the push goes on top.
    navigate(to, { replace: options?.replace, state: markerState(options?.state) });
    return;
  }
  if (listIsDirectParent(location)) {
    if (isListTarget(to)) {
      // The list is already directly underneath. Popping is the one-step
      // return; replacing this entry with a second list copy would leave
      // [list, list] and make Back show the same screen twice.
      navigate(-1);
      return;
    }
    // The entry directly below this screen is already the list, so pushing the
    // destination would put this screen under it — Back would pass two list
    // copies, or the project the person just left. Replacing keeps the depth
    // at one: the list is the parent, exactly once.
    navigate(to, { replace: true, state: markerState(options?.state) });
    return;
  }
  const listUrl = lastListUrl();
  navigate(listUrl, { replace: true });
  rememberListUrl(listUrl);
  navigate(to, { state: markerState(options?.state) });
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
  location: Pick<Location, "pathname" | "search"> & { state?: unknown },
  to: string,
  options?: { approved?: boolean; state?: unknown },
): boolean {
  if (event.defaultPrevented) return false;
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return false;
  }
  event.preventDefault();
  return runGuardedNavigation(
    () => phonePush(navigate, location, to, { state: options?.state }),
    options?.approved === true,
  );
}

/** Test hook: a new document, as a reload or an external redirect creates. */
export function resetPhoneNavigation(): void {
  documentNonce = randomToken("kin-doc");
  pendingPush = null;
  entryEvidence.clear();
  try {
    window.sessionStorage.removeItem(LIST_URL_KEY);
    window.sessionStorage.removeItem(LIST_IDX_KEY);
    window.sessionStorage.removeItem(LIST_NONCE_KEY);
  } catch {
    // No storage to clear.
  }
}
