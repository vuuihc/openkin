import type { AccountMode, AccountState } from "../store/appStore";

/**
 * Pure decisions behind the account gate.
 *
 * They live here rather than inside the screen because getting one wrong locks
 * the owner out of their own Hub, and because the mobile client will need the
 * same answers.
 */

/**
 * The stable codes the Hub can answer an auth request with.
 *
 * The list is the type. Declaring them separately would let a code exist in one
 * and not the other, and the failure is quiet: `authErrorText` falls back to the
 * server's English prose, so a missing translation shows up as the wrong
 * language rather than as an error. `locales.test.ts` iterates this array
 * against both catalogs, which it can only do because it is a value.
 */
export const AUTH_ERROR_CODES = [
  "invalid_credentials",
  "claim_code_invalid",
  "invite_invalid",
  "registration_closed",
  "weak_password",
  "identity_taken",
  "email_taken",
  "rate_limited",
  "provider_error",
  "session_expired",
  "sign_in_failed",
] as const;

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

type Translator = (key: string, params?: Record<string, string>) => string;

/**
 * Which gate an unauthenticated visitor faces.
 *
 * "token" is the standalone daemon: it has no accounts, so the console keeps
 * asking for the device token it has always asked for. A Hub with no owner can
 * only be claimed -- signing in is not an option until an account exists, even
 * when the printed code has expired.
 */
export function gateFor(account: AccountState): "token" | "claim" | "login" {
  if (!account.enabled) return "token";
  return account.needsBootstrap ? "claim" : "login";
}

/**
 * The gate a visitor actually faces, once the URL has had its say.
 *
 * `gateFor` answers for the Hub alone, which is the right answer for a 401 in
 * the middle of a session -- nothing about the address bar changes who the
 * caller is. This is the whole answer, for the one moment the URL is an
 * intention: arriving.
 *
 * An invitation beats what a Hub that has an owner thinks of itself. Somebody
 * holding an invitation link has no claim code, so the login screen could only
 * turn them away; the join screen is the one that can take the code they have.
 * Whether it works is the Hub's answer to give, not this guess's.
 *
 * Two gates end the matter first, because neither is a guess:
 *
 * - A daemon with no accounts has no join screen at all.
 * - A Hub with no owner has nothing to join. `RedeemInvite` refuses there
 *   (`internal/auth/service.go`), so the join screen could only ever fail --
 *   and it would hide the claim screen, which is the one route that produces a
 *   working Hub. An operator whose address bar still carries an old `?invite=`
 *   would be locked out of claiming their own machine.
 */
export function gateForVisit(account: AccountState, search: string): "token" | AccountMode {
  const gate = gateFor(account);
  if (gate !== "login") return gate;
  return inviteFromQuery(search) ? "join" : gate;
}

/**
 * Translated text for a failed sign-in, falling back to the server's message.
 *
 * The server sends a stable `code` next to its English prose. A code this
 * build does not know about still shows something useful rather than a raw
 * dot-path, which is what the i18n layer returns for a missing key.
 */
export function authErrorText(error: { code: string; message: string }, tr: Translator): string {
  const key = `account.errors.${error.code}`;
  const text = tr(key);
  if (text !== key) return text;
  return error.message || tr("account.errors.sign_in_failed");
}

/**
 * The two code shapes the Hub mints, in groups of five.
 *
 * A claim code is read off a log by the person who owns the machine; an
 * invitation is forwarded to somebody else and has to survive being typed off a
 * phone screen, which is why it is twice as long (`internal/auth/service.go`).
 */
const CLAIM_CODE_GROUPS = 2;
const INVITE_CODE_GROUPS = 4;

/**
 * Render a typed code the way the Hub prints it: grouped, uppercase, and
 * limited to the characters the code actually has.
 *
 * The group count is a parameter rather than a constant because getting it
 * wrong is not cosmetic. Slicing an invitation to a claim code's ten characters
 * produces something that looks complete, is accepted by the field, and never
 * works -- which the person who was invited reads as "the code you sent me is
 * wrong".
 */
function formatAccessCode(raw: string, groups: number): string {
  const bare = raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, groups * 5);
  return bare.replace(/(.{5})(?=.)/g, "$1-");
}

/** Format a claim code: ten characters, printed as two groups. */
export function formatClaimCode(raw: string): string {
  return formatAccessCode(raw, CLAIM_CODE_GROUPS);
}

/** Format an invitation: twenty characters, printed as four groups. */
export function formatInviteCode(raw: string): string {
  return formatAccessCode(raw, INVITE_CODE_GROUPS);
}

/**
 * The code field, for the two modes that have one.
 *
 * It sits next to the formatters rather than in the screen because the pairing
 * is the load-bearing part and it is invisible where it was: each formatter is
 * correct on its own, so swapping the two rows below leaves every other test in
 * the suite green and shows up only when a person types a code into the wrong
 * screen and watches it get cut to the wrong length. `accountGate.test.ts`
 * checks the pairing against the placeholders.
 */
export const CODE_FIELDS = {
  claim: {
    label: "account.codeLabel",
    placeholder: "account.codePlaceholder",
    format: formatClaimCode,
  },
  join: {
    label: "account.inviteCodeLabel",
    placeholder: "account.inviteCodePlaceholder",
    format: formatInviteCode,
  },
} as const satisfies Record<
  "claim" | "join",
  { label: string; placeholder: string; format: (raw: string) => string }
>;

/**
 * The invitation a visitor arrived with, normalized, or "" when the URL carries
 * none.
 *
 * This is how an invitation travels: the owner mints one and sends the link,
 * and the recipient opens a join screen with the code already in it. Twenty
 * characters is not something anybody types correctly on a phone, and a code
 * that has to be retyped is a code that gets sent as a screenshot.
 *
 * It takes the query string instead of reading `window.location` because it
 * decides which gate a visitor faces, and vitest runs here without a DOM --
 * the same reason the rest of this file is pure.
 */
export function inviteFromQuery(search: string): string {
  return formatInviteCode(new URLSearchParams(search).get("invite") ?? "");
}

/**
 * The code to open `mode`'s screen with, or "" when the URL's code is not that
 * screen's to take.
 *
 * Only the join screen is entitled to what the URL carries. The query string
 * says what link somebody followed, never which screen they ended up on: a
 * visitor can arrive at the claim screen with a stale `?invite=` in the address
 * bar, and prefilling there would put twenty characters into a field that holds
 * ten. The formatter only runs on the next keystroke, so the wrong value would
 * sit there looking accepted until the claim failed.
 *
 * It lives here, next to the gate that chose the screen, for the reason this
 * file exists: a screen deciding for itself what the URL meant is how the
 * invitation link came to render a sign-in form.
 */
export function prefilledCode(mode: AccountMode, search: string): string {
  return mode === "join" ? inviteFromQuery(search) : "";
}
