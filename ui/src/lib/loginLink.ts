/**
 * One-time sign-in links arrive as `#login=<64 hex characters>`.
 *
 * The token sits in the fragment rather than the query string on purpose: a
 * fragment is never sent to a server, so a chat client's link preview, a proxy
 * access log, or a `Referer` header cannot spend the link before the person
 * opens it. The console is the only thing that reads it, and it reads it once.
 *
 * Parsing lives here rather than in `main.tsx` so the shape is testable without
 * a DOM: getting it wrong turns a working link into a sign-in form, which is the
 * one failure that looks like a wrong password.
 */

/**
 * The token's shape, matching auth.NewToken: 32 random bytes as hex.
 *
 * Case-insensitive because the Hub lowercases before hashing: a chat client
 * that uppercases a sentence containing the link must not turn a working link
 * into a silent no-op. Anything that is not the full 64 characters is rejected
 * before it is posted -- a truncated token would spend a rate-limit attempt and
 * come back "expired", which reads as a dead link rather than a mangled one.
 */
const LOGIN_TOKEN = /^[0-9a-fA-F]{64}$/;

/** The sign-in token carried by a URL fragment, or "" when there is none. */
export function loginTokenFromHash(hash: string): string {
  // `hash` may arrive with or without the leading "#"; URLSearchParams handles
  // both, but stripping it first keeps "login" from becoming "#login" as a key.
  const bare = hash.startsWith("#") ? hash.slice(1) : hash;
  const token = new URLSearchParams(bare).get("login") ?? "";
  return LOGIN_TOKEN.test(token) ? token : "";
}

/**
 * Whether the fragment carries a login parameter at all, valid or not.
 *
 * A link mangled by a chat client is still a link somebody meant to follow.
 * `loginTokenFromHash` cannot tell that apart from an ordinary visit, so the
 * entry point asks this to know whether to clear the fragment and say the link
 * was unusable rather than silently ignoring it.
 */
export function hasLoginHash(hash: string): boolean {
  const bare = hash.startsWith("#") ? hash.slice(1) : hash;
  return new URLSearchParams(bare).has("login");
}

/** What the entry point should do with the sign-in link this visit carries. */
export type LoginVisit = {
  /** The token to post, or "" when the link was mangled. */
  token: string;
  /** Whether the link named a token that is not a full one. */
  malformed: boolean;
};

/**
 * The one-time link in this hash, or null when the visit is an ordinary one.
 *
 * The two "no usable token" cases are not the same: an absent parameter is an
 * ordinary visit, while a present-but-truncated one is a link somebody meant to
 * follow and has to be answered. Deciding that here keeps the entry point from
 * reading the fragment twice and disagreeing with itself.
 */
export function loginVisit(hash: string): LoginVisit | null {
  if (!hasLoginHash(hash)) return null;
  const token = loginTokenFromHash(hash);
  return { token, malformed: token === "" };
}

/**
 * The same address with the sign-in token removed from the fragment.
 *
 * Called before the token is spent, not after: a reload while the request is in
 * flight would otherwise post the same link again, and the address bar (with
 * its history entry) is the one place a browser keeps a URL whether or not
 * anybody meant to save it. Only `login` goes: a fragment may carry other
 * state that this visit still needs.
 */
export function withoutLoginHash(href: string): string {
  const url = new URL(href);
  const params = new URLSearchParams(url.hash.replace(/^#/, ""));
  if (!params.has("login")) return href;
  params.delete("login");
  url.hash = params.toString();
  return url.toString();
}

/**
 * The same address with a claim code removed from the fragment, if it is there.
 *
 * A claim code is the whole proof of ownership of an unclaimed Hub and lives
 * for a day. It travels in the fragment for the same reason a sign-in token
 * does, so the console is the only thing that ever sees it -- and once the claim
 * screen has read it into the form, it has no business staying in the address
 * bar or the history entry behind it.
 */
export function withoutClaimHash(href: string): string {
  const url = new URL(href);
  const params = new URLSearchParams(url.hash.replace(/^#/, ""));
  if (!params.has("claim")) return href;
  params.delete("claim");
  url.hash = params.toString();
  return url.toString();
}
