/**
 * Where a sign-in round trip comes back to.
 *
 * The provider owns the address bar for the length of the hop, so the page to
 * return to travels as the `return_to` parameter and comes back to the Hub.
 * `internal/api/auth.go safeReturnTo` already accepts a local absolute path
 * with a query and a fragment — these two functions are the browser-side half
 * of that same contract, and mirror its refusals so a crafted value never
 * leaves the origin even if a future Hub build stopped checking.
 *
 * Nothing here reads `window` at module load or depends on the router: the
 * screen hands in the location it is looking at, and tests can hand in their
 * own.
 */

/**
 * A same-origin path, or `/`.
 *
 * Only a value that begins with a single `/` stays; `//host` and `/\host` are
 * protocol-relative and would change origin, and an absolute URL is another
 * origin outright. Surrounding whitespace is dropped, as the Hub's own check
 * does.
 */
export function safeReturnTo(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "" || !trimmed.startsWith("/")) return "/";
  if (trimmed.startsWith("//") || trimmed.startsWith("/\\")) return "/";
  return trimmed;
}

/**
 * The exact address the reader was on, query and fragment included.
 *
 * Concatenated rather than rebuilt through `URL`/`URLSearchParams`: those
 * re-encode (`%20` becomes `+`) and reorder parameters, so the person would
 * come back to an address that is merely equivalent, not the one they left.
 * `search` and `hash` carry their own leading `?`/`#`, and are empty when the
 * page has neither.
 */
export function returnToFrom(loc: { pathname: string; search: string; hash: string }): string {
  return safeReturnTo(loc.pathname + loc.search + loc.hash);
}
