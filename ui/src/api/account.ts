import { apiFetch, ApiError } from "./client";
import type { AuthErrorCode } from "../lib/accountGate";
import { NO_ACCOUNT, useAppStore, type AccountState, type AccountProvider } from "../store/appStore";

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

export async function claimOwner(input: {
  code: string;
  email: string;
  password: string;
  displayName: string;
}): Promise<void> {
  try {
    await apiFetch("/api/auth/bootstrap", {
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
