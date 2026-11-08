import { apiFetch, ApiError, clearToken, deletePushDevice, getToken } from "./client";
import { gateForVisit, type AuthErrorCode } from "../lib/accountGate";
import { disableNativePushOnSignOut } from "../lib/nativePush";
import { forgetHubSession } from "../lib/hubConfig";
import { withoutClaimHash } from "../lib/loginLink";
import {
  NO_ACCOUNT,
  useAppStore,
  type AccountState,
  type AccountProvider,
} from "../store/appStore";

/**
 * The Hub's account surface.
 *
 * A standalone daemon has no accounts and answers /api/auth/status with no
 * providers. The console reads that as "keep using the device token" and never
 * shows a login form. Everything here is written so the token flow keeps
 * working untouched on those daemons.
 */

type AuthStatusResponse = {
  needs_bootstrap?: boolean;
  claimable?: boolean;
  authenticated?: boolean;
  providers?: AccountProvider[];
  user?: {
    email?: string;
    display_name?: string;
    identities?: string[];
    linked?: { id: string; provider: string }[];
  };
};

export class AuthError extends Error {
  code: AuthErrorCode;
  constructor(code: AuthErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function toAuthError(err: unknown): AuthError {
  if (err instanceof ApiError) {
    const body = err.body as { code?: unknown } | undefined;
    const code = typeof body?.code === "string" ? (body.code as AuthErrorCode) : "sign_in_failed";
    return new AuthError(code, err.message);
  }
  return new AuthError("sign_in_failed", err instanceof Error ? err.message : "");
}

function toState(res: AuthStatusResponse): AccountState {
  const providers = Array.isArray(res.providers) ? res.providers : [];
  return {
    enabled: providers.length > 0,
    authenticated: res.authenticated === true,
    needsBootstrap: res.needs_bootstrap === true,
    claimable: res.claimable === true,
    providers,
    email: res.user?.email,
    displayName: res.user?.display_name,
    identities: Array.isArray(res.user?.identities) ? res.user.identities : [],
    linked: Array.isArray(res.user?.linked) ? res.user.linked : [],
  };
}

/**
 * Read the Hub's account state into the store and return it.
 *
 * Failure is not fatal: an unreachable or older daemon answers nothing, which
 * reads as "no accounts", leaving the token screen as the fallback.
 */
export async function refreshAccount(): Promise<AccountState> {
  let state = NO_ACCOUNT;
  try {
    state = toState(await apiFetch<AuthStatusResponse>("/api/auth/status"));
  } catch {
    state = NO_ACCOUNT;
  }
  useAppStore.getState().setAccount(state);
  return state;
}

/**
 * Remove one-time credentials from the address bar.
 *
 * An invitation and an unclaimed-Hub claim code are live credentials. Left in
 * the URL they stay in the history and in whatever gets bookmarked from this
 * page, and an invitation is meant for exactly one person. A claim code may
 * arrive in the fragment (current links) or the query string (older ones); both
 * are removed. Only these two: a device token or a pairing code in the URL may
 * be the reason this visit is authenticated.
 *
 * Callers run this once they no longer need the value. The account screen reads
 * a claim code before this, which is why it is never called before the gate is
 * decided.
 */
export function cleanVisitCredentials(): void {
  const url = new URL(window.location.href);
  let cleaned = false;
  for (const key of ["invite", "claim"]) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      cleaned = true;
    }
  }
  const withoutClaim = withoutClaimHash(url.toString());
  if (withoutClaim !== url.toString()) cleaned = true;
  if (cleaned) window.history.replaceState({}, "", withoutClaim);
}

/**
 * Drop a failed-link message that no screen is going to show.
 *
 * A failed one-time link is reported by putting the reason in the URL, the same
 * way an OIDC callback does, and the account screen moves it into view. A
 * visitor who is already signed in -- through a device token or the Hub's
 * session cookie -- never reaches that screen, so the parameters would sit in
 * the address bar and reappear as a stale error after a later reload.
 */
export function clearAuthErrorFromURL(): void {
  const url = new URL(window.location.href);
  let cleaned = false;
  for (const key of ["auth_error", "auth_error_code", "auth_notice"]) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      cleaned = true;
    }
  }
  if (cleaned) window.history.replaceState({}, "", url.toString());
}

/**
 * Decide which gate this visit faces and put it in the store.
 *
 * Both entry points call this rather than assembling the answer themselves:
 * `main.tsx` before the first render, `App.tsx` on mount. They have to agree,
 * because the second answer overwrites the first -- and assembling the inputs
 * separately is exactly how an invitation link turned into a sign-in screen.
 * One caller read the Hub's state and the address bar, the other read only the
 * Hub, so the URL-blind answer won.
 */
export function applyVisitGate(): void {
  const { account, requireAccount } = useAppStore.getState();
  if (!account.enabled) return;
  if (account.authenticated) {
    // Somebody who is already signed in has nothing to do with an invitation or
    // an unclaimed-Hub code.
    cleanVisitCredentials();
    // A dead one-time link goes through the API layer, whose 401 handler closes
    // the gate before the account state is known. This visitor is not that
    // case, and leaving the gate closed would flash a sign-in screen at them
    // until App's mount effect opens it again.
    useAppStore.getState().setAuthOk();
    return;
  }
  const gate = gateForVisit(account, window.location.search);
  if (gate !== "token") requireAccount(gate);
}

/**
 * Spend a one-time sign-in link. The console posts the token it read from the
 * URL fragment; the server answers with the same session cookie a password
 * login sets, so everything downstream treats the two identically.
 */
export async function signInWithLink(token: string): Promise<void> {
  try {
    await apiFetch("/api/auth/login-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
  } catch (err) {
    throw toAuthError(err);
  }
}

/**
 * Swap a system-browser sign-in's code for a one-time login link (G9).
 *
 * The link, not a session token, is what comes back: the shell's webview opens
 * it like any sign-in link, the cookie it sets is first-party for the Hub
 * origin that webview is on, and the code itself was device-bound and
 * single-use. What never crosses this call is the provider's authorization
 * code or the browser's cookie — the exchange consumed both server-side.
 */
export async function exchangeLoginCode(code: string, deviceKey: string): Promise<string> {
  try {
    const res = await apiFetch<{ login_token?: string }>("/api/auth/login-code/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, device_key: deviceKey }),
    });
    if (!res?.login_token) {
      throw new AuthError("sign_in_failed", "the exchange returned no login link");
    }
    return res.login_token;
  } catch (err) {
    throw toAuthError(err);
  }
}

export async function signIn(email: string, password: string): Promise<void> {
  try {
    await apiFetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
  } catch (err) {
    throw toAuthError(err);
  }
}

/**
 * Create an account from a code.
 *
 * Both enrolled routes take the same body and differ only in which kind of code
 * is in it: bootstrap makes the Hub's owner, join makes a member. They share
 * one function because a divergence between them would be a divergence in what
 * an account is -- and the role, which is the part that matters, is decided by
 * the route and never sent from here.
 */
async function enrol(
  path: string,
  input: { code: string; email: string; password: string; displayName: string },
): Promise<void> {
  try {
    await apiFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: input.code,
        email: input.email,
        password: input.password,
        display_name: input.displayName,
      }),
    });
  } catch (err) {
    throw toAuthError(err);
  }
}

export function claimOwner(input: {
  code: string;
  email: string;
  password: string;
  displayName: string;
}): Promise<void> {
  return enrol("/api/auth/bootstrap", input);
}

export function joinHub(input: {
  code: string;
  email: string;
  password: string;
  displayName: string;
}): Promise<void> {
  return enrol("/api/auth/join", input);
}

export async function signOut(): Promise<void> {
  // Drop this console's copy of the token before the first request. The token
  // is a second way in; a network that never settles must not leave it behind,
  // and waiting for the requests would do exactly that. The requests below
  // carry the captured token explicitly, so the unregister-then-logout order
  // still runs under the credential it revokes.
  const token = getToken();
  clearToken();
  const headers: HeadersInit | undefined = token
    ? { Authorization: `Bearer ${token}` }
    : undefined;
  // Unregister first: the delete is authorized by the cookie logout revokes,
  // and a phone left showing the sign-in screen must not keep ringing with
  // this account's work. The node deletes session-bound rows on logout too;
  // this covers the shell's own row while it still has a credential. A failure
  // here must not trap the person: leaving is the point, and the node's own
  // logout deletion is the backstop.
  try {
    await disableNativePushOnSignOut({
      deletePushDevice: (id) => deletePushDevice(id, headers),
    });
  } catch {
    // Best effort; logout below still ends the session and its registrations.
  }
  try {
    await apiFetch("/api/auth/logout", { method: "POST", headers });
  } catch {
    // Clearing the local session matters more than the server's answer.
  }
  // The shell keeps a copy of this session so a reinstall does not sign the
  // person out. Signing out is exactly when that copy must go: the request
  // above may have failed, and a live cookie behind the login screen would
  // sign them back in on the next install.
  await forgetHubSession();
  useAppStore.getState().setAccount({ ...NO_ACCOUNT, enabled: true });
}

/**
 * Remove one federated login from the signed-in account (G19: 可解绑).
 *
 * The Hub refuses the account's last credential — the answer to "can I remove
 * this?" is the server's, so a 409 surfaces as a toast rather than being
 * predicted client-side. The account state is refreshed either way: what the
 * chips show must be what the Hub actually holds after the attempt.
 */
export async function unlinkIdentity(id: string): Promise<void> {
  try {
    await apiFetch(`/api/auth/identities/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      throw new AuthError("last_credential", err.message);
    }
    throw toAuthError(err);
  } finally {
    await refreshAccount();
  }
}

/**
 * Begin an OIDC sign-in.
 *
 * In a browser this is a full-page navigation: the provider needs to own the
 * address bar for its own redirect dance. Inside the native shell the address
 * bar is the system browser's (G9) — the shell opens the start URL there, the
 * callback lands on kin://auth-callback, and the account screen picks the flow
 * up from the pending callback. The device key travels on the start URL and
 * comes back with the code; the caller keeps it in memory in between.
 */
export function startOIDC(provider: AccountProvider, returnTo = "/"): void {
  const base = provider.start_url || "/api/auth/oidc/start";
  const target = new URL(base, window.location.origin);
  target.searchParams.set("return_to", returnTo);
  const pending = useAppStore.getState().pendingAppSignIn;
  if (pending) {
    target.searchParams.set("device_key", pending.deviceKey);
    // The shell opens the URL externally; navigating this page away would
    // lose the flow that is about to hand the callback back.
    pending.open(target.toString());
    return;
  }
  window.location.assign(target.toString());
}
