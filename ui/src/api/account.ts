import { apiFetch, ApiError } from "./client";
import { gateForVisit, type AuthErrorCode } from "../lib/accountGate";
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
    // Somebody who is already signed in has nothing to do with an invitation,
    // and an unspent one is a live credential for the next seven days. Left in
    // the address bar it is also left in the history and in whatever gets
    // bookmarked from this page, so it goes. Only `invite`: a token or a
    // pairing code in the URL may be the reason this visit is authenticated.
    const url = new URL(window.location.href);
    if (url.searchParams.has("invite")) {
      url.searchParams.delete("invite");
      window.history.replaceState({}, "", url.toString());
    }
    return;
  }
  const gate = gateForVisit(account, window.location.search);
  if (gate !== "token") requireAccount(gate);
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
  try {
    await apiFetch("/api/auth/logout", { method: "POST" });
  } catch {
    // Clearing the local session matters more than the server's answer.
  }
  useAppStore.getState().setAccount({ ...NO_ACCOUNT, enabled: true });
}

/**
 * Begin an OIDC sign-in. This is a full-page navigation, not a fetch: the
 * provider needs to own the address bar for its own redirect dance.
 */
export function startOIDC(provider: AccountProvider, returnTo = "/"): void {
  const base = provider.start_url || "/api/auth/oidc/start";
  const target = new URL(base, window.location.origin);
  target.searchParams.set("return_to", returnTo);
  window.location.assign(target.toString());
}
