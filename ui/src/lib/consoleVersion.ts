/**
 * Notice that the document this code is running in is older than the one the
 * server now serves.
 *
 * A phone webview left open across a deploy keeps executing the bundle it
 * loaded days ago: the server has moved on, and the person keeps seeing bugs
 * that were already fixed. The only cheap moment to catch up is when the page
 * comes back to the foreground. Then compare the entry chunk this document
 * loaded with the one the server's index names, and reload once if they differ.
 *
 * The check is deliberately quiet — no endpoint, no banner, no copy. Anything
 * that is not a clear answer (offline, a dev server, a proxy answering
 * something else) is "nothing to say", never a reason to reload.
 */

/**
 * A production entry chunk: Vite writes `/assets/index-<hash>.js`. The hash is
 * opaque, so only the shape is matched; the only thing this check cares about
 * is that both sides are describing the same build artefact.
 */
const ENTRY_CHUNK = /^\/assets\/index-[A-Za-z0-9_-]+\.js$/;

const SCRIPT_TAG = /<script\b[^>]*>/gi;
const TYPE_ATTR = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
const SRC_ATTR = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

function attr(tag: string, pattern: RegExp): string | null {
  const match = pattern.exec(tag);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

/**
 * The pathname of a production entry chunk, or null for anything else.
 *
 * `new URL` drops the origin and any query, which is what lets a cache-busting
 * `?v=` or an elective absolute `src` compare equal to the pathname the server
 * names. Relative dev entries (`/src/main.tsx`) do not match the shape and are
 * therefore never mistaken for a build artefact.
 */
function entryPath(src: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(src, "http://localhost").pathname;
  } catch {
    return null;
  }
  return ENTRY_CHUNK.test(pathname) ? pathname : null;
}

/**
 * The module entry chunk an index document names, or null when it names none.
 *
 * Used on both sides of the comparison: the served index, and (through
 * `entryPath`) the `src` of the script this document is running.
 */
export function parseEntryChunk(html: string): string | null {
  for (const tag of html.matchAll(SCRIPT_TAG)) {
    const markup = tag[0];
    const type = attr(markup, TYPE_ATTR);
    if (!type || type.toLowerCase() !== "module") continue;
    const src = attr(markup, SRC_ATTR);
    if (!src) continue;
    const path = entryPath(src);
    if (path) return path;
  }
  return null;
}

export type ConsoleFreshness = "current" | "stale" | "skipped";

/** The parts of a `fetch` response this check reads. */
export interface ConsoleVersionResponse {
  ok: boolean;
  text(): Promise<string>;
}

export interface ConsoleVersionDeps {
  fetchImpl: (url: string, init: RequestInit) => Promise<ConsoleVersionResponse>;
  /** The entry chunk the running document loaded, or null when it has none. */
  currentEntry: string | null;
  reload: () => void;
  /**
   * The document's sessionStorage. It holds the loop marker, and its identity
   * is what "this document has already reloaded" is recorded against.
   */
  storage: Pick<Storage, "getItem" | "setItem">;
}

/**
 * Documents already sent to `reload()`.
 *
 * `reload()` does not stop this document on the spot, so a second resume can
 * arrive before the navigation begins. Identifying the document by its storage
 * object is exact — one sessionStorage exists per document — and keeps two
 * documents (or two tests) from sharing the guard.
 */
const reloadedDocuments = new WeakSet<object>();

/** One marker per stale entry, because that is the reload it would cause. */
const RELOAD_MARKER = "kin.consoleReloaded";

function markerFor(entry: string): string {
  return `${RELOAD_MARKER}:${entry}`;
}

/**
 * Compare the running document with the server's index, reloading at most once.
 *
 * A failed or inconclusive check returns `"skipped"` and never reloads: an
 * offline phone, a dev server, or a captive portal must not cost the person the
 * page they are reading.
 */
export async function checkConsoleVersion(deps: ConsoleVersionDeps): Promise<ConsoleFreshness> {
  const current = deps.currentEntry ? entryPath(deps.currentEntry) : null;
  if (!current) return "skipped";

  let html: string;
  try {
    const response = await deps.fetchImpl("/", {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!response.ok) return "skipped";
    html = await response.text();
  } catch {
    return "skipped";
  }

  const served = parseEntryChunk(html);
  if (!served) return "skipped";
  if (served === current) return "current";

  // Stale. Reload once per document, and remember the stale entry so a document
  // that comes back still running the old bundle (a cache kept serving the old
  // index) does not reload in a loop.
  const marker = markerFor(served);
  let alreadyMarked = false;
  try {
    alreadyMarked = deps.storage.getItem(marker) === "1";
  } catch {
    // Storage can be unavailable (private mode, a sandboxed frame); the
    // in-memory guard still keeps this document from reloading twice.
  }

  if (!alreadyMarked && !reloadedDocuments.has(deps.storage)) {
    reloadedDocuments.add(deps.storage);
    try {
      deps.storage.setItem(marker, "1");
    } catch {
      // Losing the marker only risks a second reload after a full document
      // replacement, never a loop inside this one.
    }
    try {
      deps.reload();
    } catch {
      // A reload that cannot run must not surface as a console failure.
    }
  }

  return "stale";
}
