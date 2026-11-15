import type { MouseEvent as ReactMouseEvent } from "react";
import type { Location, NavigateFunction } from "react-router-dom";
import { areaById } from "./areas";
import { resolveAreaRoute, type AreaId, type LocationLike } from "./areaNavigation";
import { runGuardedNavigation } from "./leaveGuard";

/**
 * The phone's push contract, per area.
 *
 * The signed story map (`docs/product/stories/ux-unification-story-map.md`)
 * replaces KIN-CONTINUE-002's single navigation root: the console has four
 * areas — Conversations (`/sessions`), Projects (`/projects`), Routines
 * (`/routines`) and Settings (`/settings`) — and each behaves like its own
 * stack. A row or link reached from an area root is one push, so Back is one
 * step. Switching tabs is not Back: a root target replaces the top entry and
 * never pops the area the reader left, so the depth stays constant and no
 * `[projects, conversation, projects, conversation]` cycle can form.
 *
 * A detail keeps the real entry it was opened from underneath it. Opening a
 * conversation from a project cover returns to that cover, not to
 * `/sessions`; opening a remote run from a project returns to the project
 * detail, not to `/routines`. The cold-start default parent for a URL that has
 * no in-app origin is the table in `areaNavigation.ts`; this module never
 * invents a "previous page".
 *
 * "The area root is directly underneath" is evidence, not a guess. A
 * location-state marker names an area entry this tab recorded, and the
 * tab-scoped ledger keeps that entry's history index and URL. The marker
 * therefore survives a reload and a Forward that land on the same stack, while
 * a marker copied to another depth, or a bare index with no area entry behind
 * it, is refused. The ledger is not a security boundary — a page can always
 * rewrite its own history — it is what keeps a stale or unrelated index from
 * claiming an area root as its parent.
 *
 * A same-entry replace can erase the child's marker (a tab switch). The ledger
 * entry at `idx - 1` is then the evidence: this tab really did put an area
 * root at that depth, and the entry on top of it is therefore its child.
 *
 * Each area also remembers the root URL it was last showing, including the
 * conversations list's `?search=`, `?status=` and `?scope=` and the routines
 * list's `?device=`. That is what the area's tab puts back, not a bare path.
 */
const AREA_URLS_KEY = "kin.areaUrls";
/** The conversations root used to live alone under this key; kept readable so a
 *  tab that was open across the upgrade still returns to its filters. */
const LEGACY_LIST_URL_KEY = "kin.listUrl";
const LIST_TOKEN_KEY = "kin.listToken";
const ROOT_PARENTS_KEY = "kin.listParents";
const PHONE_QUERY = "(min-width: 768px)";
const LIST_STATE_KEYS = ["search", "status", "scope"] as const;

/** Location state stamped on a destination `phonePush` placed directly above
 *  an area root. It is what lets a later push tell "the root is already my
 *  parent" from "some other screen is". */
const ROOT_PARENT_KEY = "kinListParent";
const MAX_ROOT_RECORDS = 64;

type RootParentMarker = { token: string; parentIdx: number | null; rootUrl?: string };
type RootParentRecord = { idx: number | null; url: string };
type RootParentLedger = Record<string, RootParentRecord>;
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

/** The token for the area root entry currently on screen, if this document
 *  showed it. Kept in memory for cheap pushes and mirrored into sessionStorage
 *  so a reload reuses the same token instead of orphaning every child marker. */
let currentRootToken: string | null = null;
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

/** Split a URL string into the two fields every resolver here reads. A query
 *  or hash appended to a pathname is never treated as part of a segment. */
function urlParts(url: string): LocationLike {
  const hashless = url.split("#", 1)[0];
  const query = hashless.indexOf("?");
  if (query === -1) return { pathname: hashless || "/", search: "" };
  return { pathname: hashless.slice(0, query) || "/", search: hashless.slice(query) };
}

function areaOfUrl(url: string): AreaId | null {
  return resolveAreaRoute(urlParts(url))?.area ?? null;
}

/**
 * The area and exact URL of an area root, or null for a detail / unknown URL.
 *
 * `/settings?tab=general` is the settings root; a section is a pushed page, not
 * a root. `/agents` and `/usage` redirect into the operations section and are
 * therefore not roots either.
 */
function areaRootOf(url: string): { area: AreaId; url: string } | null {
  const route = resolveAreaRoute(urlParts(url));
  return route?.root ? { area: route.area, url } : null;
}

/** The canonical URL a tab returns to for an area. Conversations keep the
 *  list's own filters in a stable order so two spellings of one view do not
 *  produce two entries; routines keep their device; general settings is the
 *  bare root. */
function canonicalRootUrl(location: LocationLike, area: AreaId): string {
  if (area === "conversations") return listUrlFor(location.search);
  const root = areaById(area).root;
  if (area === "settings") return root;
  const params = new URLSearchParams(location.search.split("#", 1)[0]);
  const text = params.toString();
  return text ? `${root}?${text}` : root;
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

function readLedger(): RootParentLedger {
  try {
    const raw = window.sessionStorage.getItem(ROOT_PARENTS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const ledger: RootParentLedger = {};
    for (const [token, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== "object" || value === null) continue;
      const record = value as Record<string, unknown>;
      const idx =
        typeof record.idx === "number" && Number.isInteger(record.idx) ? record.idx : null;
      if (typeof record.url !== "string" || areaOfUrl(record.url) === null) continue;
      ledger[token] = { idx, url: record.url };
    }
    return ledger;
  } catch {
    return {};
  }
}

function writeLedger(ledger: RootParentLedger): void {
  try {
    window.sessionStorage.setItem(ROOT_PARENTS_KEY, JSON.stringify(ledger));
  } catch {
    // No storage: pushes still work, but a reload cannot prove a parent.
  }
}

function rootParentAt(idx: number): (RootParentRecord & { token: string }) | null {
  if (!Number.isInteger(idx) || idx < 0) return null;
  for (const [token, record] of Object.entries(readLedger())) {
    if (record.idx === idx) return { token, ...record };
  }
  return null;
}

function setCurrentRootToken(token: string): void {
  currentRootToken = token;
  try {
    window.sessionStorage.setItem(LIST_TOKEN_KEY, token);
  } catch {
    // No storage: the in-memory token still serves this document.
  }
}

/**
 * Record that `url` is an area entry at history depth `idx`, and return its
 * token.
 *
 * The same depth reuses its token, so a Back to an area root followed by a
 * query change (a same-entry replace) keeps every child marker above it valid.
 * A different depth mints a new token; only the newest record for a depth is
 * kept, because a replacement there means the previous entry is gone.
 */
export function registerRootEntry(url: string, idx: number | null): string {
  const ledger = readLedger();
  // A history entry keeps its area identity for as long as the ledger says it
  // is still an entry. `notePhoneLocation` deletes a record only when another
  // screen replaces that entry, so re-registering the same depth (Back,
  // Forward, a query replace) must reuse its token instead of minting a new
  // one: the children above it still name that token.
  let token: string | null =
    idx === null
      ? null
      : (Object.entries(ledger).find(([, record]) => record.idx === idx)?.[0] ?? null);
  if (!token) {
    const remembered = currentRootToken ?? readStoredToken();
    const previous = remembered ? ledger[remembered] : undefined;
    token =
      remembered && (!previous || previous.idx === idx || idx === null)
        ? remembered
        : randomToken("kin-root");
  }
  for (const [other, record] of Object.entries(ledger)) {
    if (idx !== null && other !== token && record.idx === idx) delete ledger[other];
  }
  ledger[token] = { idx, url };
  const tokens = Object.keys(ledger);
  for (const stale of tokens.slice(0, Math.max(0, tokens.length - MAX_ROOT_RECORDS))) {
    delete ledger[stale];
  }
  writeLedger(ledger);
  setCurrentRootToken(token);
  return token;
}

function markerOf(state: unknown): RootParentMarker | null {
  if (typeof state !== "object" || state === null) return null;
  const raw = (state as Record<string, unknown>)[ROOT_PARENT_KEY];
  if (typeof raw !== "object" || raw === null) return null;
  const token = (raw as Record<string, unknown>).token;
  if (typeof token !== "string") return null;
  const parentIdx = (raw as Record<string, unknown>).parentIdx;
  const rootUrl = (raw as Record<string, unknown>).rootUrl;
  return {
    token,
    parentIdx: typeof parentIdx === "number" && Number.isInteger(parentIdx) ? parentIdx : null,
    rootUrl: typeof rootUrl === "string" ? rootUrl : undefined,
  };
}

/** Location state for a child whose direct parent is the recorded area entry. */
export function rootParentState(
  token: string,
  state?: unknown,
  parentIdx?: number | null,
  rootUrl?: string,
): Record<string, unknown> {
  const base =
    typeof state === "object" && state !== null ? (state as Record<string, unknown>) : {};
  return {
    ...base,
    [ROOT_PARENT_KEY]: {
      token,
      parentIdx: typeof parentIdx === "number" && Number.isInteger(parentIdx) ? parentIdx : null,
      ...(rootUrl ? { rootUrl } : {}),
    },
  };
}

/**
 * Whether the entry directly below this one is a root of `area`.
 *
 * The marker names the depth and URL it was minted for; the ledger proves the
 * entry at that depth is still an area entry. A marker-only answer is accepted
 * when the tab ledger is gone (a browser restart restores history but not
 * sessionStorage), because the marker still names the depth it was minted for.
 */
function rootIsDirectParent(
  location: {
    pathname: string;
    state?: unknown;
    key?: string;
  },
  area: AreaId,
): boolean {
  const idx = routeIndex(location);
  if (idx === null || idx <= 0) return false;
  const parent = rootParentAt(idx - 1);
  const marker = markerOf(location.state);
  if (marker) {
    // A marker minted for another depth is not evidence for this entry.
    if (marker.parentIdx !== null && marker.parentIdx !== idx - 1) return false;
    if (parent) {
      if (marker.token !== parent.token) return false;
      return areaRootOf(parent.url)?.area === area;
    }
    // The tab ledger is gone. The marker still names the depth and area it was
    // minted for; that depth is directly below this entry. If the ledger has
    // any records but none here, the entry below was replaced and it is stale.
    if (Object.keys(readLedger()).length > 0) return false;
    return marker.rootUrl ? areaOfUrl(marker.rootUrl) === area : area === "conversations";
  }
  // A same-entry replace erased the marker; the tab's own record at this depth
  // is the evidence that an area root is still the direct parent.
  return parent !== null && areaRootOf(parent.url)?.area === area;
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

/** The four equal phone roots, shared by footer, swipe and external entries. */
export const PHONE_TAB_IDS = ["sessions", "routines", "agents", "settings"] as const;
export type PhoneTabId = (typeof PHONE_TAB_IDS)[number];

/** A root URL may carry its own device / filter state, but not a detail path. */
export function phoneTabPath(to: string): string | null {
  if (/^(?:[a-z][a-z\d+.-]*:)?\/\//i.test(to) || !to.startsWith("/")) return null;
  const [pathname] = to.split(/[?#]/, 1);
  return PHONE_TAB_IDS.some((id) => pathname === `/${id}`) ? pathname : null;
}
export function isPhoneTabPath(to: string): boolean {
  return phoneTabPath(to) !== null;
}

/**
 * A tab target: an area root, or the operations section the Agents tab still
 * names until the router redirects it. A tab target replaces the top entry; it
 * is never pushed on top of the screen it switches away from.
 */
function isTabTarget(to: string): boolean {
  if (!to.startsWith("/")) return false;
  const route = resolveAreaRoute(urlParts(to));
  return route !== null && (route.root || route.name === "settings.operations");
}

/** Keep the list's own params, in a stable order, so two spellings of the
 *  same view do not produce two history entries. */
export function listUrlFor(search: string, fallback = "/sessions"): string {
  const params = new URLSearchParams(search);
  const next = new URLSearchParams();
  for (const key of LIST_STATE_KEYS) {
    const value = params.get(key);
    if (value) next.set(key, value);
  }
  const text = next.toString();
  return text ? `${fallback}?${text}` : fallback;
}

function readAreaUrls(): Partial<Record<AreaId, string>> {
  try {
    const raw = window.sessionStorage.getItem(AREA_URLS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const urls: Partial<Record<AreaId, string>> = {};
    for (const [area, url] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof url !== "string") continue;
      const root = areaRootOf(url);
      if (root && root.area === area) urls[root.area] = url;
    }
    return urls;
  } catch {
    return {};
  }
}

function writeAreaUrls(urls: Partial<Record<AreaId, string>>): void {
  try {
    window.sessionStorage.setItem(AREA_URLS_KEY, JSON.stringify(urls));
  } catch {
    // No storage: the fallback is the area's bare root.
  }
}

/** Remember the area root the reader is looking at, filters included. */
export function rememberAreaUrl(url: string): void {
  const root = areaRootOf(url);
  if (!root) return;
  const canonical = canonicalRootUrl(urlParts(url), root.area);
  const urls = readAreaUrls();
  urls[root.area] = canonical;
  writeAreaUrls(urls);
  if (root.area === "conversations") {
    try {
      window.sessionStorage.setItem(LEGACY_LIST_URL_KEY, canonical);
    } catch {
      // No storage: the in-memory ledger still names this entry.
    }
  }
  registerRootEntry(canonical, historyIndex());
}

/**
 * Note every route the shell shows.
 *
 * An area root records itself. Any other route at the same history depth as a
 * recorded entry means that entry was replaced: the root at that depth is
 * gone, and leaving its record behind would let a later push mistake the new
 * screen for a child of a root that is no longer underneath it.
 */
export function notePhoneLocation(location: TrackedRoute): void {
  routeVisit += 1;
  currentRoute = {
    pathname: location.pathname,
    search: location.search,
    key: location.key,
    visit: routeVisit,
  };
  if (areaRootOf(`${location.pathname}${location.search}`)) {
    rememberAreaUrl(`${location.pathname}${location.search}`);
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

/** The last root URL this tab showed for `area`, or the area's bare root. */
export function lastAreaUrl(area: AreaId): string {
  const stored = readAreaUrls()[area];
  if (stored) return stored;
  if (area === "conversations") {
    try {
      const legacy = window.sessionStorage.getItem(LEGACY_LIST_URL_KEY);
      if (legacy && areaRootOf(legacy)?.area === "conversations") return legacy;
    } catch {
      // No storage: the bare root is the fallback.
    }
  }
  return areaById(area).root;
}

/** The last conversations root this tab showed, or `fallback`. */
export function lastListUrl(fallback = "/sessions"): string {
  const stored = readAreaUrls().conversations;
  if (stored) return stored;
  try {
    const legacy = window.sessionStorage.getItem(LEGACY_LIST_URL_KEY);
    if (legacy && areaRootOf(legacy)?.area === "conversations") return legacy;
  } catch {
    // No storage: the caller's fallback is the answer.
  }
  return fallback;
}

/** The conversations root a screen at `location` should return to. */
export function returnListUrl(location: Pick<Location, "pathname" | "search">): string {
  const route = resolveAreaRoute(location);
  if (route?.area === "conversations" && route.root) return listUrlFor(location.search);
  return lastListUrl();
}

/** The root URL of the area `location` belongs to. */
export function returnAreaUrl(location: Pick<Location, "pathname" | "search">): string {
  const route = resolveAreaRoute(location);
  if (route?.root) return canonicalRootUrl(location, route.area);
  return lastAreaUrl(route?.area ?? "conversations");
}

/** Extra location state a draft entry carries, so closing it can restore the
 *  exact area root the person came from rather than a bare `/sessions`. */
export type DraftEntryState = { kinDraftFrom?: string };

export function draftEntryState(from: string): DraftEntryState {
  return { kinDraftFrom: from };
}

/** Where closing the draft should land. A recorded area root wins; a cold
 *  `/new` has none and falls back to the last conversations root. */
export function draftReturnUrl(state: unknown, fallback = "/sessions"): string {
  const from = (state as DraftEntryState | null)?.kinDraftFrom;
  return from && areaRootOf(from) ? from : lastListUrl(fallback);
}

/**
 * A bare tab path resolves to the root URL the area was last showing, so the
 * footer, the tab swipe and the palette all return the reader to their
 * filters, not to a reset. A URL that already carries its own query — a
 * notification with `?device=` — is left exactly as asked; the explicit value
 * wins over the remembered one. `/` is the start route, not a tab.
 */
function rememberedTabUrl(to: string): string {
  const parts = urlParts(to);
  if (parts.search) return to;
  const root = areaRootOf(to);
  if (!root || areaById(root.area).root !== parts.pathname) return to;
  return lastAreaUrl(root.area);
}

/**
 * Push a phone screen above the entry in front of it.
 *
 * A tab target (an area root) replaces the top entry, or pops when the target
 * area's root is the proven direct parent: a tab switch never pops the area the
 * reader left. Everything else is a push, so the real entry — a project cover,
 * a routines list, another detail — stays underneath. No guard is asked here;
 * callers wrap this in `runGuardedNavigation`.
 */
export function phonePush(
  navigate: NavigateFunction,
  location: Pick<Location, "pathname" | "search"> & { state?: unknown; key?: string },
  to: string,
  options?: { replace?: boolean; phone?: boolean; state?: unknown },
): void {
  const phone = options?.phone ?? isPhoneLayout();
  // Only a phone returns a tab to the area root it last showed; the Mac's
  // sidebar and links keep the URL they asked for and ordinary history.
  const destination = phone && isTabTarget(to) ? rememberedTabUrl(to) : to;
  const targetPath = destination.split(/[?#]/, 1)[0] || destination;
  const here = resolveAreaRoute({
    pathname: location.pathname,
    search: location.search,
  });
  const there = resolveAreaRoute(urlParts(destination));
  // On a phone, another view of the same screen (the list's filters, a
  // settings section's neighbour) replaces the entry. A different route under
  // the same pathname — `/settings` to `/settings?tab=providers` — is a pushed
  // section, not a view change. On a Mac the same pathname can name a
  // different view (a routine notification switching `?device=A` to
  // `?device=B`), and replacing there would erase the A entry Back should
  // reach; so only an exact same URL, or an explicit replace, stays in this
  // entry.
  const sameView = destination.split("#", 1)[0] === `${location.pathname}${location.search}`;
  const sameScreen =
    here !== null && there !== null && here.area === there.area && here.name === there.name;
  if (targetPath === location.pathname && (options?.replace || (phone ? sameScreen : sameView))) {
    navigate(destination, { replace: true, state: options?.state });
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
  if (isTabTarget(to)) {
    // A tab switch is a root-only action: replace the top entry, keeping the
    // depth constant. When the target area's root is the proven direct parent,
    // popping is the one-step return and restores that root's filters.
    if (!options?.replace && there && rootIsDirectParent(location, there.area)) {
      navigate(-1);
      return;
    }
    navigate(destination, { replace: true, state: options?.state });
    return;
  }
  if (options?.replace) {
    // Replacing this entry means it is no longer underneath the destination.
    navigate(to, { replace: true, state: options?.state });
    return;
  }
  const origin = areaRootOf(`${location.pathname}${location.search}`);
  const idx = routeIndex(location) ?? historyIndex();
  const parent = idx !== null && idx > 0 ? rootParentAt(idx - 1) : null;
  const area = origin?.area ?? here?.area ?? null;
  const crossArea = area === null || !there || there.area !== area;
  // A root, the legacy operations page and an unknown page are entry points,
  // not details. Above another entry they were reached from that screen (a
  // link or a notification, not a tab switch), so a push into another area
  // replaces them: Back must still reach the screen before this area.
  const entryPoint = origin !== null || here === null || here.name === "settings.operations";
  if (
    idx !== null &&
    idx > 0 &&
    entryPoint &&
    (origin !== null || parent !== null) &&
    crossArea
  ) {
    navigate(to, { replace: true, state: options?.state });
    return;
  }
  // A project cover is the entry the signed table comes back to, so it stays
  // underneath a conversation opened from it. Every other non-root screen
  // sitting directly above an area root is replaced by the next push: a fork
  // or a notification takes over that slot, and Back reaches the root.
  if (idx !== null && idx > 0 && parent !== null && here?.name !== "projects.detail") {
    navigate(to, { replace: true, state: options?.state });
    return;
  }
  if (origin) {
    // Leaving a root at the start of its stack: the same push is the child's
    // parent, recorded so a tab press can pop straight back to this URL
    // (filters included).
    const token = registerRootEntry(`${location.pathname}${location.search}`, idx);
    navigate(to, { state: rootParentState(token, options?.state, idx, origin.url) });
    return;
  }
  // A detail or a cross-area entry: the original entry stays underneath and
  // Back pops to it. No parent is invented.
  navigate(to, { state: options?.state });
}

/**
 * Every entry point shares the phone destination rules: four roots replace
 * peers, while a pushed screen with a real parent can still pop back to it.
 * The browser Back gesture asks its own leave guard first.
 *
 * A tab switch is legal only at an area root (the tabs are not shown on editor
 * screens), so it never consults the editor's guard: there is nothing to lose
 * at the root the reader is standing on.
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
  const atAreaRoot = resolveAreaRoute(location)?.root === true;
  const tabSwitch = atAreaRoot && isPhoneLayout() && isTabTarget(to);
  return runGuardedNavigation(
    () => phonePush(navigate, location, to, { state: options?.state }),
    options?.approved === true || tabSwitch,
  );
}

/**
 * Test hook: drop this document's in-memory token and, unless a reload is
 * being simulated, the tab ledger too. A reload keeps sessionStorage, so
 * `keepStorage` is what lets a test prove the marker and ledger still agree.
 */
export function resetPhoneNavigation(options?: { keepStorage?: boolean }): void {
  currentRootToken = null;
  currentRoute = null;
  if (options?.keepStorage) return;
  try {
    window.sessionStorage.removeItem(AREA_URLS_KEY);
    window.sessionStorage.removeItem(LEGACY_LIST_URL_KEY);
    window.sessionStorage.removeItem(LIST_TOKEN_KEY);
    window.sessionStorage.removeItem(ROOT_PARENTS_KEY);
  } catch {
    // No storage to clear.
  }
}
