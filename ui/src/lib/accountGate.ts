import type { AccountState } from "../store/appStore";

/**
 * Pure decisions behind the account gate.
 *
 * They live here rather than inside the screen because getting one wrong locks
 * the owner out of their own Hub, and because the mobile client will need the
 * same answers.
 */

export type AuthErrorCode =
  | "invalid_credentials"
  | "claim_code_invalid"
  | "registration_closed"
  | "weak_password"
  | "identity_taken"
  | "rate_limited"
  | "provider_error"
  | "session_expired"
  | "sign_in_failed";

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
 * Translated text for a failed sign-in, falling back to the server's message.
 *
 * The server sends a stable `code` next to its English prose. A code this
 * build does not know about still shows something useful rather than a raw
 * dot-path, which is what the i18n layer returns for a missing key.
 */
export function authErrorText(
  error: { code: string; message: string },
  tr: Translator,
): string {
  const key = `account.errors.${error.code}`;
  const text = tr(key);
  if (text !== key) return text;
  return error.message || tr("account.errors.sign_in_failed");
}

/**
 * Render a typed claim code the way it is printed: grouped, uppercase, and
 * limited to the ten characters the code actually has.
 */
export function formatClaimCode(raw: string): string {
  const bare = raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
  return bare.length > 5 ? `${bare.slice(0, 5)}-${bare.slice(5)}` : bare;
}
