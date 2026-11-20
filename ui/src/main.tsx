import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { bootstrapTokenFromURL, getToken } from "./api/client";
import {
  applyVisitGate,
  AuthError,
  beginUnansweredAccountProbe,
  clearAuthErrorFromURL,
  cleanVisitCredentials,
  endUnansweredAccountProbe,
  refreshAccount,
  signInWithLink,
} from "./api/account";
import { AstryxProvider } from "./design/AstryxProvider";
import { useAppStore } from "./store/appStore";
import { loginVisit, withoutLoginHash } from "./lib/loginLink";
import { hubAnswers, hubBootPlan } from "./lib/hubBoot";
import { bootProbe } from "./lib/bootProbe";
import { linkExchange, linkVisitPlan } from "./lib/linkExchange";
import type { AuthErrorCode } from "./lib/accountGate";
import { checkConsoleVersion } from "./lib/consoleVersion";
import { ConsoleReady } from "./lib/consoleInteractive";
import { currentHubUrl, hubConfigPlugin } from "./lib/hubConfig";
import { initTheme } from "./lib/theme";
import { cleanupLegacyWebPush } from "./lib/legacyWebPush";
import { synthesizePhoneParent } from "./lib/phoneDeepLinkParent";
import "./index.css";

initTheme();
// Web Push is gone; retire the worker an older console may have installed.
void cleanupLegacyWebPush();

const root = document.getElementById("root");
if (!root) {
  throw new Error("root element missing");
}

/**
 * Report a failed sign-in link through the same URL parameters the OIDC
 * callback uses, so the account screen has one way to show an auth failure
 * rather than a second error channel that only this path can produce.
 */
function showLinkFailure(err: unknown): void {
  const authErr = err instanceof AuthError ? err : new AuthError("sign_in_failed", "");
  const url = new URL(window.location.href);
  url.searchParams.set("auth_error_code", authErr.code);
  if (authErr.message) url.searchParams.set("auth_error", authErr.message);
  window.history.replaceState({}, "", url.toString());
}

/**
 * Reopen onto the Hub this phone was connected to, before the bundled console
 * paints.
 *
 * The shell starts on the page the build shipped with; the Hub the person
 * paired with lives in the plugin. Handing that address back to `setHubUrl` is
 * the same action the connect screen takes — it persists the origin, restores
 * that Hub's session cookie, and moves the webview — so the first page the
 * person sees is the Hub, not a connect screen that asks them to do it again.
 *
 * Returns true when the shell is navigating. The callers then render nothing:
 * the document is about to be replaced. When the address does not answer, the
 * bundled console stays up and its connect screen is the manual way back.
 */
async function bootIntoStoredHub(): Promise<boolean> {
  const plugin = hubConfigPlugin();
  if (!plugin) return false;
  let stored = "";
  try {
    stored = await currentHubUrl(plugin);
  } catch {
    return false;
  }
  const plan = hubBootPlan({
    inShell: true,
    storedUrl: stored,
    here: window.location.href,
  });
  if (plan.kind === "stay") return false;
  if (!(await hubAnswers(plan.url))) return false;
  try {
    // The address was confirmed when it was connected; reopening the app is
    // not a second consent question.
    await plugin.setHubUrl({ url: plan.url, confirm: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Reload this document when it resumes and the server has moved on to a newer
 * entry chunk.
 *
 * A webview left open across a deploy keeps running the bundle it loaded, so
 * the person keeps seeing bugs that are already fixed. Both ways a page comes
 * back — a visibility change, and a back/forward restore from the page cache —
 * run the same check. It is wired after `render()` on purpose: the check is a
 * courtesy to a console that is already on screen, and it must never sit
 * between the auth probe and the first paint.
 */
function watchConsoleVersion(): void {
  const check = (): void => {
    try {
      const script = document.querySelector<HTMLScriptElement>('script[type="module"][src]');
      void checkConsoleVersion({
        fetchImpl: (url, init) => window.fetch(url, init),
        currentEntry: script?.getAttribute("src") ?? null,
        reload: () => window.location.reload(),
        storage: window.sessionStorage,
      });
    } catch {
      // A version check is a courtesy; it never breaks the console.
    }
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") check();
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) check();
  });
}

// Resolve the auth gate before the first render, but never wait for it
// forever.
//
// Three things are needed to know which gate applies: the URL may carry a
// device token, a one-time sign-in link, or neither, and the daemon may be a
// Hub that signs browsers in with a cookie instead. Probing first means a
// signed-in Hub user never sees the token screen flash by, and a standalone
// daemon never sees a login form it cannot serve.
//
// The link is spent before `refreshAccount` so that probe already sees the new
// session: the person arrives signed in, rather than watching a login form,
// submitting nothing, and being reloaded. Its fragment is cleared first so the
// credential does not stay in history. The exchange itself is bounded too
// (`LINK_EXCHANGE_DEADLINE_MS`): a Hub that accepts the POST and never answers
// opens the console at the deadline instead of holding the splash forever.
void (async () => {
  // Before the auth probe: a stored Hub is a different origin, so asking this
  // one who the visitor is would only produce the connect screen this avoids.
  if (await bootIntoStoredHub()) return;
  await bootstrapTokenFromURL();
  const plan = linkVisitPlan(loginVisit(window.location.hash));
  let linkFailed = false;

  /** Report a failed link, and remember it for the account probe's decision. */
  const failLink = (code: AuthErrorCode, message = ""): void => {
    linkFailed = true;
    showLinkFailure(new AuthError(code, message));
  };

  // The rest of boot: the bounded account probe, the gate, and the one render.
  // `linkFailed` is read here, after the link branch below has set it, so a
  // failed or timed-out link reaches the account screen.
  const boot = async (): Promise<void> => {
    // From here to the first render the console waits for the Hub's account
    // answer. The wait is bounded: if the probe is accepted and never answered,
    // the console opens anyway and the verdict is applied when it lands. Until
    // then the store must not say "no accounts" -- that is a verdict, and there
    // is not one yet -- or App's mount effect would close the gate on a token
    // screen the deadline did not ask for.
    if (!getToken()) beginUnansweredAccountProbe();
    await bootProbe({
      probe: refreshAccount(),
      linkFailed,
      hasDeviceToken: () => !!getToken(),
      setAuthOk: () => useAppStore.getState().setAuthOk(),
      applyVisitGate,
      endUnanswered: endUnansweredAccountProbe,
      cleanVisitCredentials,
      clearAuthErrorFromURL,
      render: () => {
        // Before the router mounts, give a cold deep link a parent entry so the
        // system Back returns to the list instead of leaving Kin.
        synthesizePhoneParent();
        createRoot(root).render(
          <StrictMode>
            <AstryxProvider>
              <BrowserRouter>
                {/* Reports the first committed screen to the desktop shell; the
                    splash is gone at this point. Renders nothing. */}
                <ConsoleReady />
                <App />
              </BrowserRouter>
            </AstryxProvider>
          </StrictMode>,
        );
        // Only after the console has painted: a stale document is still a
        // document the person can use, and the reload is an upgrade, not a
        // prerequisite.
        watchConsoleVersion();
      },
    });
  };

  if (plan.kind !== "none") {
    // Clear it first: the token is about to be spent, and a reload while the
    // request is in flight must not post the same link twice.
    window.history.replaceState({}, "", withoutLoginHash(window.location.href));
  }
  if (plan.kind === "malformed") {
    // A truncated or mangled link is still a link somebody followed. Saying
    // so beats ignoring it, which looks identical to a link that never
    // existed.
    failLink("login_link_invalid");
    await boot();
  } else if (plan.kind === "exchange") {
    await linkExchange({
      token: plan.token,
      exchange: signInWithLink,
      boot,
      onFailed: failLink,
      reprobe: refreshAccount,
      setAuthOk: () => useAppStore.getState().setAuthOk(),
      cleanVisitCredentials,
      clearAuthErrorFromURL,
    });
  } else {
    await boot();
  }
})();
