import type { AuthErrorCode } from "./accountGate";
import type { LoginVisit } from "./loginLink";
import type { AccountState } from "../store/appStore";

/**
 * How long the console waits for the one-time-link exchange before it opens
 * anyway.
 *
 * 1500 ms is the same bound `bootProbe` gives the account probe (#431). The
 * exchange runs *before* that probe, so a Hub that accepts
 * `POST /api/auth/login-link` and never answers would otherwise hold the
 * splash with no text, no timeout and no retry -- the account probe's deadline
 * never gets a turn. An exchange that answers is never delayed by this: the
 * deadline decides when the console opens, not what the exchange meant.
 *
 * The two bounds are sequential rather than shared: a Hub that holds both the
 * exchange and the account probe delays the first render by up to their sum
 * (~3000 ms). In the recorded browser proof only the exchange is held, and the
 * console commits at this deadline.
 */
export const LINK_EXCHANGE_DEADLINE_MS = 1500;

export type LinkExchangeDeps = {
  /** The one-time token from the URL fragment. */
  token: string;
  /** POST the token. A rejection is an answer: it keeps its own code. */
  exchange: (token: string) => Promise<void>;
  /**
   * The rest of boot: probe the account, decide the gate and render once. The
   * session a successful exchange created is visible to that probe.
   */
  boot: () => Promise<void>;
  /** Report the one failure the console should show. Called at most once. */
  onFailed: (code: AuthErrorCode, message?: string) => void;
  /** Ask the Hub who the visitor is now, after a late success. */
  reprobe: () => Promise<AccountState>;
  /** Open the gate for a session that arrived after the console did. */
  setAuthOk: () => void;
  /** Remove one-time credentials from the address bar. */
  cleanVisitCredentials: () => void;
  /** Drop the timeout message once a late success makes it false. */
  clearAuthErrorFromURL: () => void;
  deadlineMs?: number;
};

/** What the entry point should do with the sign-in link this visit carries. */
export type LinkVisitPlan =
  { kind: "none" } | { kind: "malformed" } | { kind: "exchange"; token: string };

/**
 * Decide the visit's link branch before anything is posted.
 *
 * A malformed link is answered without an exchange. It is still a link somebody
 * followed -- saying so beats ignoring it, which looks identical to a link that
 * never existed -- but posting a truncated token would spend a rate-limit
 * attempt and come back "expired", which reads as a dead link rather than a
 * mangled one. Keeping the branch here, next to the exchange it gates, lets
 * `main.tsx` dispatch on one value instead of re-reading the fragment and
 * disagreeing with itself.
 */
export function linkVisitPlan(visit: LoginVisit | null): LinkVisitPlan {
  if (!visit) return { kind: "none" };
  if (visit.malformed) return { kind: "malformed" };
  return { kind: "exchange", token: visit.token };
}

type ExchangeOutcome = { ok: true } | { ok: false; code: AuthErrorCode; message: string };

/**
 * Both answers of the POST, as values.
 *
 * Nothing below treats a rejection as a crash, and attaching the rejection
 * handler here means an exchange that lands after the deadline cannot surface
 * as an unhandled rejection on a console that has moved on.
 */
function outcomeOf(exchange: Promise<void>): Promise<ExchangeOutcome> {
  return exchange.then(
    () => ({ ok: true }) as const,
    (err: unknown) => {
      const code = (err as { code?: unknown } | null)?.code;
      return {
        ok: false,
        // The Hub's stable codes are strings; one this build does not know
        // still reaches `authErrorText`, which falls back to the prose below.
        code: typeof code === "string" ? (code as AuthErrorCode) : "sign_in_failed",
        message: err instanceof Error ? err.message : "",
      } as const;
    },
  );
}

type Bounded<T> = { answered: true; value: T } | { answered: false };

/** The answer if it lands within the deadline, otherwise "too late". */
function settlesWithin<T>(work: Promise<T>, deadlineMs: number): Promise<Bounded<T>> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ answered: false }), deadlineMs);
    work.then((value) => {
      // Cleared the moment the answer lands, so a settled launch never carries
      // a stray deadline into its later life.
      clearTimeout(timer);
      resolve({ answered: true, value });
    });
  });
}

/**
 * Spend the one-time link without holding the splash forever.
 *
 * The healthy path is the old one, in the old order: the POST completes, then
 * `boot()` probes the account -- which now sees the cookie the exchange just
 * set -- decides the gate and renders once. A rejection keeps the code the Hub
 * sent and still boots, so the account screen can show it; a rejection is not a
 * reason to leave the person on a blank splash.
 *
 * At the deadline the console opens first and the exchange is left running on
 * purpose. If it then succeeds, the session is real but the probe may already
 * have answered without it, so the account is asked once more: an authenticated
 * answer opens the gate, clears the one-time credentials and removes the
 * timeout message that has just become false. A late failure changes nothing --
 * the timeout message already on screen is the honest account of what happened,
 * and replacing it with "invalid" would claim more than is known.
 *
 * The one invariant every branch keeps: `boot()` (and so `render`) runs
 * exactly once. A late answer only edits the store and the address bar -- never
 * a second render, which the desktop shell would read as a console that
 * restarted on its own.
 */
export async function linkExchange(deps: LinkExchangeDeps): Promise<void> {
  const outcome = outcomeOf(deps.exchange(deps.token));
  const bounded = await settlesWithin(outcome, deps.deadlineMs ?? LINK_EXCHANGE_DEADLINE_MS);

  if (bounded.answered) {
    if (!bounded.value.ok) deps.onFailed(bounded.value.code, bounded.value.message);
    await deps.boot();
    return;
  }

  // The deadline. The person is told the link did not finish -- not that it is
  // invalid or expired, which would be a false claim about a link that may
  // still work -- and the console opens instead of waiting behind the POST.
  deps.onFailed("login_link_timeout");
  await deps.boot();

  const late = await outcome;
  if (!late.ok) return;
  const state = await deps.reprobe().catch(() => null);
  if (!state?.authenticated) return;
  deps.cleanVisitCredentials();
  deps.clearAuthErrorFromURL();
  deps.setAuthOk();
}
