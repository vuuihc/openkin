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

/** ASCII control characters: `0x00`–`0x1F` and DEL. */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/**
 * A same-origin path, or `/`.
 *
 * Only a value that begins with a single `/` stays; `//host` and `/\host` are
 * protocol-relative and would change origin, and an absolute URL is another
 * origin outright. Surrounding whitespace is dropped, as the Hub's own check
 * does.
 *
 * The value is also judged by what it decodes to, not only how it was typed:
 * a hop in front of the Hub (a reverse proxy, a log-and-redirect tool) may
 * percent-decode once, so `/%09/host` and `/%2F/host` reach it as `//host`.
 * Every escape before the first `?` or `#` is decoded twice — `%2509` reaches
 * the same tab one round later — and a decoded `/`, `\` or ASCII control is a
 * refusal, as is a malformed escape. The query and the fragment are data, are
 * not decoded, and come back exactly as they were written, so the passing
 * value keeps its `%20`s and its parameter order.
 *
 * The Hub mirrors this set in `safeReturnTo` (`internal/api/auth.go`); the two
 * must accept and refuse exactly the same values.
 */
export function safeReturnTo(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "" || !trimmed.startsWith("/")) return "/";
  if (trimmed.startsWith("//") || trimmed.startsWith("/\\")) return "/";
  // `trim()` only drops the control characters at the ends; one in the middle
  // is not part of a path anybody typed.
  if (CONTROL_CHARACTER.test(trimmed)) return "/";
  // Only what precedes the first `?` or `#` decides the origin.
  const query = trimmed.search(/[?#]/);
  const origin = query < 0 ? trimmed : trimmed.slice(0, query);
  return originStaysLocal(origin) ? trimmed : "/";
}

/**
 * Whether the origin-deciding span survives percent-decoding as a local path.
 *
 * Decoding up to twice catches the double-encoded form; the loop stops as soon
 * as a round changes nothing. Two facts make the checks below sufficient: a
 * decoded control character cannot have been literal (that was refused above),
 * and decoding never removes a slash, so a count that grows means an escape
 * produced one — which after one hop is the `//host` prefix the raw check
 * refuses.
 */
function originStaysLocal(origin: string): boolean {
  let current = origin;
  for (let round = 0; round < 2; round++) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      // Malformed escape, or a sequence that is not valid UTF-8. Go's
      // `url.PathUnescape` also fails the first, and the Hub additionally
      // rejects the second, so both sides refuse the same values.
      return false;
    }
    if (decoded === current) return true;
    if (slashCount(decoded) > slashCount(current)) return false;
    if (CONTROL_CHARACTER.test(decoded)) return false;
    current = decoded;
  }
  return true;
}

function slashCount(value: string): number {
  let count = 0;
  for (const ch of value) if (ch === "/" || ch === "\\") count++;
  return count;
}

/**
 * The exact address the reader was on, query and fragment included.
 *
 * Concatenated rather than rebuilt through `URL`/`URLSearchParams`: those
 * re-encode (`%20` becomes `+`) and reorder parameters, so the person would
 * come back to an address that is merely equivalent, not the one they left.
 * `search` and `hash` carry their own leading `?`/`#`, and are empty when the
 * page has neither.
 *
 * A fragment travels inside the `return_to` query parameter, so it reaches the
 * Hub's access logs rather than staying client-side. Credential-shaped
 * fragments are not a live leak on this path: the known carriers (`#login`,
 * claim links) are consumed and stripped before the sign-in button exists.
 */
export function returnToFrom(loc: { pathname: string; search: string; hash: string }): string {
  return safeReturnTo(loc.pathname + loc.search + loc.hash);
}
