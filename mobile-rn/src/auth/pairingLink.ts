/**
 * KIN-MOBILE-001 R2 — the `?token=` pairing link.
 *
 * The node prints a link the owner pastes (or scans) into a fresh install. The
 * link is parsed here, before anything is stored: the token is the secret, the
 * origin is where to send it, and the display form keeps the token out of the
 * screen and out of any URL the app later builds.
 *
 * Pure on purpose. It never reaches the Keychain or the network, so a malformed
 * or foreign link cannot leave half a session behind.
 */

export type PairingLink = {
  /** The node to talk to, or null when the link names none (a bare app link). */
  origin: string | null;
  token: string;
  /** Origin-only text safe to show and to keep for a retry. */
  display: string;
};

export type PairingLinkFailure = "no-token" | "empty-token" | "bad-link";

export type PairingLinkResult =
  | { ok: true; link: PairingLink }
  | { ok: false; reason: PairingLinkFailure };

/** The web form and the app's own deep-link form; nothing else. */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "kin:"]);

function isWebURL(url: URL): boolean {
  return url.protocol === "http:" || url.protocol === "https:";
}

/** `https://host[:port]` for web links; `kin://host` for app links. */
function displayFor(url: URL): string {
  return isWebURL(url) ? url.origin : `${url.protocol}//${url.host}`;
}

/** A kin:// link may name the node in an `origin` query parameter. */
function nodeOrigin(url: URL): string | null {
  if (isWebURL(url)) return url.origin;
  const raw = url.searchParams.get("origin");
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return isWebURL(parsed) ? parsed.origin : null;
  } catch {
    return null;
  }
}

export function parsePairingLink(raw: string): PairingLinkResult {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, reason: "bad-link" };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: "bad-link" };
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return { ok: false, reason: "bad-link" };
  }

  const rawToken = url.searchParams.get("token");
  if (rawToken === null) return { ok: false, reason: "no-token" };
  const token = rawToken.trim();
  if (token === "") return { ok: false, reason: "empty-token" };

  const origin = nodeOrigin(url);
  return {
    ok: true,
    link: { origin, token, display: origin ?? displayFor(url) },
  };
}

/**
 * The origin-only form of a link. Never contains the token or the query
 * string; an unparseable string redacts to the empty string.
 */
export function redactToken(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  try {
    const url = new URL(trimmed);
    return nodeOrigin(url) ?? displayFor(url);
  } catch {
    return "";
  }
}
