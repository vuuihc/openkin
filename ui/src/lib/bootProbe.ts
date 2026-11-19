import type { AccountState } from "../store/appStore";

/**
 * How long the console waits for the pre-render account probe.
 *
 * 1500 ms is about five times the worst healthy handover measured on this
 * machine (306 ms from the daemon answering to the first commit, of which
 * 54 ms is renderer work after the document loads), and stays under the ~2 s
 * point where a splash stops reading as "loading" and starts reading as
 * "broken". The stored-Hub decision in `bootIntoStoredHub()` runs before this
 * and keeps its own 2500 ms bound, so the worst first render is ~4000 ms on
 * the shell's stored-Hub path and 1500 ms everywhere else.
 *
 * A probe that answers is never delayed by this: the deadline only decides
 * when the console opens, not what the account verdict is.
 */
export const PRE_RENDER_DEADLINE_MS = 1500;

export type BootProbeDeps = {
  /** The account probe. A rejection is "no answer", not a crash. */
  probe: Promise<AccountState>;
  /** Render the console. Called exactly once, whatever the probe does. */
  render: () => void;
  /** Open the gate. */
  setAuthOk: () => void;
  /** Decide the gate from the account state the probe put in the store. */
  applyVisitGate: () => void;
  /** Release the "answer not in yet" hold in the account store. */
  endUnanswered: () => void;
  /** Whether a device token is present. It outranks the Hub's answer. */
  hasDeviceToken: () => boolean;
  /** Remove one-time credentials from the address bar. */
  cleanVisitCredentials: () => void;
  /** Drop a failed-link message no screen is going to show. */
  clearAuthErrorFromURL?: () => void;
  /** True when a one-time sign-in link failed earlier in boot. */
  linkFailed?: boolean;
  deadlineMs?: number;
};

type EarlyAnswer = { answered: true; state: AccountState | null } | { answered: false };

/**
 * The probe's answer if it arrives within the deadline, otherwise "too late".
 *
 * Both outcomes of the promise are answers here: `refreshAccount` already turns
 * an unreachable daemon into NO_ACCOUNT, and a probe handed in from a test may
 * reject instead. Either way the console does not wait any longer than the
 * deadline, and the timer is cleared the moment the answer lands so a settled
 * launch never carries a stray deadline into its later life.
 */
function settlesWithin(probe: Promise<AccountState>, deadlineMs: number): Promise<EarlyAnswer> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ answered: false }), deadlineMs);
    const answer = (state: AccountState | null): void => {
      clearTimeout(timer);
      resolve({ answered: true, state });
    };
    probe.then(
      (state) => answer(state),
      () => answer(null),
    );
  });
}

/**
 * Wire the account probe to the first render.
 *
 * The healthy path is the old one: wait for the answer, decide the gate, then
 * render, so a signed-in Hub visitor never sees the token screen and a
 * standalone daemon never sees a login form. The deadline exists for the other
 * path — a probe that is accepted and never answered. Then the console opens
 * immediately with the gate held open, and the verdict is applied when it
 * lands: a signed-out Hub gets its account screen late rather than never, a
 * signed-in visitor's one-time credentials are cleaned, and an unanswered or
 * failed probe changes nothing at all.
 *
 * The one invariant every branch keeps: at most one `render`. The desktop
 * shell turns the first commit into its `console-interactive` mark, once per
 * launch, and a second render would be a console that restarted on its own.
 */
export async function bootProbe(deps: BootProbeDeps): Promise<void> {
  const early = await settlesWithin(deps.probe, deps.deadlineMs ?? PRE_RENDER_DEADLINE_MS);

  if (early.answered) {
    deps.endUnanswered();
    decideBeforeRender(deps, early.state);
    deps.render();
    return;
  }

  // The deadline: the token, if there is one, is already known and outranks a
  // verdict that does not exist yet, so its credentials are cleaned now.
  if (deps.hasDeviceToken()) deps.cleanVisitCredentials();
  deps.setAuthOk();
  deps.render();

  // The original probe is left running on purpose: this is the answer the
  // account screen is owed, and it is worth having even after the render.
  const state = await deps.probe.catch(() => null);
  deps.endUnanswered();
  if (deps.hasDeviceToken()) {
    // A device token still works on a Hub, so a signed-out verdict cannot
    // close this gate. Cleaning already happened at the deadline.
  } else if (state?.authenticated) {
    deps.cleanVisitCredentials();
    deps.setAuthOk();
  } else if (state?.enabled) {
    // Signed out on a Hub: the honest gate, at the moment it is known.
    deps.applyVisitGate();
  }
  // Same rule as the pre-deadline path: a failed link's message belongs to the
  // account screen, which a visitor who turns out to be signed in never sees.
  if (deps.linkFailed && (deps.hasDeviceToken() || state?.authenticated)) {
    deps.clearAuthErrorFromURL?.();
  }
}

/**
 * Today's pre-render decision, unchanged: a device token wins and its
 * credentials are cleaned; otherwise the visit gate reads the answer the probe
 * put in the store.
 */
function decideBeforeRender(deps: BootProbeDeps, state: AccountState | null): void {
  if (deps.hasDeviceToken()) {
    deps.cleanVisitCredentials();
    if (deps.linkFailed) {
      // The failed exchange closed the gate on its way out. The device token is
      // still here, so the visitor is not signed out.
      deps.setAuthOk();
    }
  } else {
    deps.applyVisitGate();
  }
  if (deps.linkFailed && (deps.hasDeviceToken() || state?.authenticated)) {
    deps.clearAuthErrorFromURL?.();
  }
}
