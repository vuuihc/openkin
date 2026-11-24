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
 * marker names a list entry this tab recorded, and the tab-scoped ledger keeps
 * that entry's history index. The marker therefore survives a reload and a
 * Forward that land on the same stack, while a marker copied to another depth,
 * or a bare index with no list entry behind it, is refused. The ledger is not
 * a security boundary — a page can always rewrite its own history — it is what
 * keeps a stale or unrelated index from claiming the list as its parent.
 *
 * A same-entry replace can erase the child's marker (a project tab switch).
 * The ledger entry at `idx - 1` is then the evidence: this tab really did put
 * a list at that depth, and the entry on top of it is therefore its child.
 */
const LIST_PATH = "/sessions";
const LIST_URL_KEY = "kin.listUrl";
const LIST_TOKEN_KEY = "kin.listToken";
const LIST_PARENTS_KEY = "kin.listParents";
/** Each phone root's last URL, so a tab reopens where the reader left it. */
const PHONE_TAB_URLS_KEY = "kin.phoneTabUrls";
const PHONE_QUERY = "(min-width: 768px)";
const LIST_STATE_KEYS = ["search", "status", "scope", "routine", "project"] as const;

/** Location state stamped on a destination `phonePush` placed directly above
 *  the list. It is what lets a later push tell "the list is already my parent"
 *  from "some other screen is". */
const LIST_PARENT_KEY = "kinListParent";
const MAX_LIST_RECORDS = 64;

type ListParentMarker = { token: string; parentIdx: number | null };
type ListParentRecord = { idx: number | null; url: string };
type ListParentLedger = Record<string, ListParentRecord>;
export type TrackedRoute = Pick<Location, "pathname" | "search"> & {
  key?: string;
  /**
   * How many routes this document has shown, including re-entries to the same
   * history entry. A late answer compares this with the value it captured, so
   * leaving and pressing Back to the original entry counts as a new visit
   * rather than the screen the answer belongs to.
   */
  visit?: number;
};

/** The token for the list entry currently on screen, if this document showed
 *  it. Kept in memory for cheap pushes and mirrored into sessionStorage so a
 *  reload reuses the same token instead of orphaning every child marker. */
let currentListToken: string | null = null;
/** The route the shell last showed. A page that is waiting on an answer can
 *  unmount before that answer lands, so its own `useLocation()` ref stops
 *  updating; this is the evidence of what is actually in front now. */
let currentRoute: TrackedRoute | null = null;
/** Bumped for every route the shell shows, so a leave-and-Back to the same
 *  history entry (same `key`) is still a new visit to the screen. */
let routeVisit = 0;

function randomToken(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function historyIndex(): number | null {
  if (typeof window === "undefined") return null;
  const idx = (window.history.state as { idx?: unknown } | null)?.idx;
  return typeof idx === "number" ? idx : null;
}

/** The history index of the route's own entry, or null when this is not the
 *  document the router is driving (a MemoryRouter, where window.history is
 *  somebody else's stack and its index says nothing about the route). */
function routeIndex(location: Pick<Location, "pathname">): number | null {
  if (typeof window === "undefined") return null;
  if (window.location.pathname !== location.pathname) return null;
  return historyIndex();
}

function readStoredToken(): string | null {
  try {
    return window.sessionStorage.getItem(LIST_TOKEN_KEY);
  } catch {
    return null;
  }
}

function readLedger(): ListParentLedger {
  try {
    const raw = window.sessionStorage.getItem(LIST_PARENTS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const ledger: ListParentLedger = {};
    for (const [token, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== "object" || value === null) continue;
      const record = value as Record<string, unknown>;
      const idx =
        typeof record.idx === "number" && Number.isInteger(record.idx) ? record.idx : null;
      if (typeof record.url !== "string" || !record.url.startsWith(LIST_PATH)) continue;
      ledger[token] = { idx, url: record.url };
    }
    return ledger;
  } catch {
    return {};
  }
}

function writeLedger(ledger: ListParentLedger): void {
  try {
    window.sessionStorage.setItem(LIST_PARENTS_KEY, JSON.stringify(ledger));
  } catch {
    // No storage: pushes still work, but a reload cannot prove a parent.
  }
}

function listParentAt(idx: number): (ListParentRecord & { token: string }) | null {
  if (!Number.isInteger(idx) || idx < 0) return null;
  for (const [token, record] of Object.entries(readLedger())) {
    if (record.idx === idx) return { token, ...record };
  }
  return null;
}

function setCurrentListToken(token: string): void {
  currentListToken = token;
  try {
    window.sessionStorage.setItem(LIST_TOKEN_KEY, token);
  } catch {
    // No storage: the in-memory token still serves this document.
  }
}

/**
 * Record that `url` is the list at history depth `idx`, and return its token.
 *
 * The same depth reuses its token, so a Back to the list followed by a query
 * change (a same-entry replace) keeps every child marker above it valid. A
 * different depth mints a new token; only the newest record for a depth is
 * kept, because a replacement there means the previous list entry is gone.
 */
export function registerListEntry(url: string, idx: number | null): string {
  const ledger = readLedger();
  // A history entry keeps its list identity for as long as the ledger says it
  // is still a list. `notePhoneLocation` deletes a record only when another
  // screen replaces that entry, so re-registering the same depth (Back,
  // Forward, a query replace) must reuse its token instead of minting a new
  // one: the children above it still name that token.
  let token: string | null =
    idx === null
      ? null
      : (Object.entries(ledger).find(([, record]) => record.idx === idx)?.[0] ?? null);
  if (!token) {
    const remembered = currentListToken ?? readStoredToken();
    const previous = remembered ? ledger[remembered] : undefined;
    token =
      remembered && (!previous || previous.idx === idx || idx === null)
        ? remembered
        : randomToken("kin-list");
  }
  for (const [other, record] of Object.entries(ledger)) {
    if (idx !== null && other !== token && record.idx === idx) delete ledger[other];
  }
  ledger[token] = { idx, url };
  const tokens = Object.keys(ledger);
  for (const stale of tokens.slice(0, Math.max(0, tokens.length - MAX_LIST_RECORDS))) {
    delete ledger[stale];
  }
  writeLedger(ledger);
  setCurrentListToken(token);
  return token;
}

function markerOf(state: unknown): ListParentMarker | null {
  if (typeof state !== "object" || state === null) return null;
  const raw = (state as Record<string, unknown>)[LIST_PARENT_KEY];
  if (typeof raw !== "object" || raw === null) return null;
  const token = (raw as Record<string, unknown>).token;
  if (typeof token !== "string") return null;
  const parentIdx = (raw as Record<string, unknown>).parentIdx;
  return {
    token,
    parentIdx: typeof parentIdx === "number" && Number.isInteger(parentIdx) ? parentIdx : null,
  };
}

/** Location state for a child whose direct parent is the recorded list. */
export function listParentState(
  token: string,
  state?: unknown,
  parentIdx?: number | null,
): Record<string, unknown> {
  const base =
    typeof state === "object" && state !== null ? (state as Record<string, unknown>) : {};
  return {
    ...base,
    [LIST_PARENT_KEY]: {
      token,
      parentIdx: typeof parentIdx === "number" && Number.isInteger(parentIdx) ? parentIdx : null,
    },
  };
}

/** Whether the entry directly below this one is the list. */
function listIsDirectParent(location: {
  pathname: string;
  state?: unknown;
  key?: string;
}): boolean {
  const idx = routeIndex(location);
  if (idx === null || idx <= 0) return false;
  const parent = listParentAt(idx - 1);
  const marker = markerOf(location.state);
  if (marker) {
    // A marker minted for another depth is not evidence for this entry.
    if (marker.parentIdx !== null && marker.parentIdx !== idx - 1) return false;
    if (parent) return marker.token === parent.token;
    // The tab ledger is gone (a browser restart restores history but not
    // sessionStorage). The marker still names the depth it was minted for, and
    // that depth is directly below this entry. If the ledger has any records
    // but none here, the entry below was replaced and the marker is stale.
    return Object.keys(readLedger()).length === 0;
  }
  // A same-entry replace erased the marker; the tab's own record at this depth
  // is the evidence that the list is still the direct parent.
  return parent !== null;
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

/** The four equal phone roots, shared by footer, swipe and external entries. */
export const PHONE_TAB_IDS = ["sessions", "routines", "agents", "settings"] as const;
export type PhoneTabId = (typeof PHONE_TAB_IDS)[number];

/**
 * The tab a URL belongs to, as that tab's root path; null for anything else.
 *
 * A root URL may carry its own device / filter state, but not a detail path.
 * Agent Ops is a tab of the settings page, not a page of its own, yet the phone
 * footer shows it as a peer entry: a URL that names that tab belongs to the
 * Agent Ops entry, not Settings, or the Settings tab would reopen Operations.
 */
export function phoneTabPath(to: string): string | null {
  if (/^(?:[a-z][a-z\d+.-]*:)?\/\//i.test(to) || !to.startsWith("/")) return null;
  const [pathAndQuery] = to.split("#", 1);
  const [pathname, query = ""] = pathAndQuery.split("?", 2);
  if (pathname === "/settings" && new URLSearchParams(query).get("tab") === "operations") {
    return "/agents";
  }
  return PHONE_TAB_IDS.some((id) => pathname === `/${id}`) ? pathname : null;
}
export function isPhoneTabPath(to: string): boolean {
  return phoneTabPath(to) !== null;
}

function readTabUrls(): Record<string, string> {
  try {
    const raw = window.sessionStorage.getItem(PHONE_TAB_URLS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const urls: Record<string, string> = {};
    for (const [id, url] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof url === "string") urls[id] = url;
    }
    return urls;
  } catch {
    return {};
  }
}

/** Remember a root's exact URL (params included); detail paths are ignored. */
function rememberPhoneTabUrl(url: string): void {
  const root = phoneTabPath(url);
  if (root === null) return;
  const urls = readTabUrls();
  urls[root.slice(1)] = url;
  try {
    window.sessionStorage.setItem(PHONE_TAB_URLS_KEY, JSON.stringify(urls));
  } catch {
    // No storage: the tab still opens at its own root.
  }
}

/**
 * The URL a phone tab should reopen, or its own root.
 *
 * The four tabs are peers, not a hierarchy: leaving Settings must not forget
 * which settings tab was open, and leaving Routines must not forget which
 * machine was selected. Each root's last exact URL is remembered whenever the
 * shell shows that root (`notePhoneLocation`), params included. Agent Ops is a
 * settings tab but its own footer entry, so its URL is remembered under its
 * own id instead of under Settings (`phoneTabPath`).
 *
 * A remembered URL is returned only while it still names the same root. A
 * detail path (`/routines/today`), another root's URL, or an absolute URL is
 * refused and the tab opens at `fallback`. The value rides sessionStorage, so
 * a reload keeps it and a new tab starts clean.
 */
export function phoneTabUrl(id: PhoneTabId, fallback = `/${id}`): string {
  const stored = readTabUrls()[id];
  if (!stored || phoneTabPath(stored) !== `/${id}`) return fallback;
  return stored;
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
  } catch {
    // No storage: the fallback is the plain list.
  }
  registerListEntry(url, historyIndex());
}

/**
 * Note every route the shell shows.
 *
 * A list route records itself. Any other route at the same history depth as a
 * recorded list means that entry was replaced: the list at that depth is gone,
 * and leaving its record behind would let a later push mistake the new screen
 * for a child of a list that is no longer underneath it.
 */
export function notePhoneLocation(location: TrackedRoute): void {
  routeVisit += 1;
  currentRoute = {
    pathname: location.pathname,
    search: location.search,
    key: location.key,
    visit: routeVisit,
  };
  const url = `${location.pathname}${location.search}`;
  // A root keeps its own last view, so the footer can come back to it with
  // its `?device=` / `?tab=` / filter state intact.
  rememberPhoneTabUrl(url);
  if (location.pathname === LIST_PATH) {
    // `?agent=` opens the session sheet over the list; it is an overlay, not a
    // list view. The sheet's continue flow never commits a clean list
    // location, so remembering this URL would let the rail's Chats entry,
    // ⌘K → Chats and a draft close reopen a sheet the reader already closed.
    // Only `agent` goes; the list's own filters (`attention` included) stay.
    const listParams = new URLSearchParams(location.search);
    listParams.delete("agent");
    const listSearch = listParams.toString();
    rememberListUrl(listSearch ? `${location.pathname}?${listSearch}` : location.pathname);
    return;
  }
  const idx = routeIndex(location);
  if (idx === null) return;
  const ledger = readLedger();
  let changed = false;
  for (const [token, record] of Object.entries(ledger)) {
    if (record.idx === idx) {
      delete ledger[token];
      changed = true;
    }
  }
  if (changed) writeLedger(ledger);
}

/** The route the shell last rendered, or null before its first note. */
export function currentPhoneLocation(): TrackedRoute | null {
  return currentRoute;
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
  const targetPath = to.split(/[?#]/, 1)[0] || to;
  const phone = options?.phone ?? isPhoneLayout();
  // On a phone a same-screen link is a view change and must not stack the
  // machine/view behind it. On a Mac the same pathname can name a different
  // view (a routine notification switching `?device=A` to `?device=B`), and
  // replacing there would erase the A entry Back is supposed to reach. Only an
  // exact same URL — or an explicit replace — stays in this entry on a Mac.
  const sameView =
    targetPath === location.pathname &&
    to.split("#", 1)[0] === `${location.pathname}${location.search}`;
  if (targetPath === location.pathname && (phone || sameView || options?.replace)) {
    // A same-screen link (a chip that rewrites the list's own query) is a view
    // change, not a push. Replacing prevents a duplicate entry — and on a
    // phone it also prevents the synthetic-list walk that would put a second
    // list above the real one.
    navigate(to, { replace: true, state: options?.state });
    return;
  }
  if (phone && isListTarget(to) && listIsDirectParent(location)) {
    // A list route is a root only when it is not already this detail's real
    // parent. Back must pop that parent rather than replacing it away.
    navigate(-1);
    return;
  }
  if (phone && isPhoneTabPath(to)) {
    // An entry point does not change the destination's stack role. A routine
    // notification, the palette or a footer link all switch a root peer.
    // Conversation rows, projects and the draft keep their pushed Back below.
    navigate(to, { replace: true, state: options?.state });
    return;
  }
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
    if (options?.replace) {
      // Replacing the list itself means the list is no longer underneath.
      navigate(to, { replace: true, state: options?.state });
      return;
    }
    // The list is the parent, so it stays underneath as the push goes on top.
    const listIdx = routeIndex(location) ?? historyIndex();
    const token = registerListEntry(`${location.pathname}${location.search}`, listIdx);
    navigate(to, { state: listParentState(token, options?.state, listIdx) });
    return;
  }
  const idx = routeIndex(location);
  const parent = idx === null ? null : listParentAt(idx - 1);
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
    // A marker-only answer means the tab ledger is gone but the marker still
    // names the list it was minted for; its token carries forward.
    const token = parent?.token ?? markerOf(location.state)?.token;
    if (token) {
      navigate(to, {
        replace: true,
        state: listParentState(token, options?.state, idx === null ? null : idx - 1),
      });
      return;
    }
  }
  const listUrl = lastListUrl();
  const listIdx = historyIndex();
  const token = registerListEntry(listUrl, listIdx);
  navigate(listUrl, { replace: true });
  navigate(to, { state: listParentState(token, options?.state, listIdx) });
}

/**
 * Every entry point shares the phone destination rules: four roots replace
 * peers, while a pushed screen with a real list parent can still pop back to
 * it. The browser Back gesture of the old page asks its own leave-guard first.
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

/**
 * Test hook: drop this document's in-memory token and, unless a reload is
 * being simulated, the tab ledger too. A reload keeps sessionStorage, so
 * `keepStorage` is what lets a test prove the marker and ledger still agree.
 */
export function resetPhoneNavigation(options?: { keepStorage?: boolean }): void {
  currentListToken = null;
  currentRoute = null;
  if (options?.keepStorage) return;
  try {
    window.sessionStorage.removeItem(LIST_URL_KEY);
    window.sessionStorage.removeItem(LIST_TOKEN_KEY);
    window.sessionStorage.removeItem(LIST_PARENTS_KEY);
    window.sessionStorage.removeItem(PHONE_TAB_URLS_KEY);
  } catch {
    // No storage to clear.
  }
}
