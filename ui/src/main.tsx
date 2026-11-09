import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { setupIonicReact } from "@ionic/react";
import App from "./App";
import { bootstrapTokenFromURL, getToken } from "./api/client";
import {
  applyVisitGate,
  AuthError,
  clearAuthErrorFromURL,
  cleanVisitCredentials,
  refreshAccount,
  signInWithLink,
} from "./api/account";
import { useAppStore } from "./store/appStore";
import { loginVisit, withoutLoginHash } from "./lib/loginLink";
import { hubAnswers, hubBootPlan } from "./lib/hubBoot";
import { currentHubUrl, hubConfigPlugin } from "./lib/hubConfig";
import { initTheme } from "./lib/theme";
import { cleanupLegacyWebPush } from "./lib/legacyWebPush";
import "@ionic/react/css/core.css";
import "./index.css";

/**
 * Ionic is the console's mobile design language: the action sheet and the
 * controls built on it get the platform's touch targets, safe area and
 * dismissal behaviour without a hand-tuned copy per page. The console's own
 * tokens stay authoritative for colour and type — see the `ion-action-sheet`
 * block in `index.css`. `ios` mode everywhere keeps one look across the phone,
 * the browser and the desktop shell.
 */
setupIonicReact({ mode: "ios" });

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
 * Resolve the auth gate before the first render.
 *
 * Three things are needed to know which gate applies: the URL may carry a
 * device token, a one-time sign-in link, or neither, and the daemon may be a
 * Hub that signs browsers in with a cookie instead. Probing first means a
 * signed-in Hub user never sees the token screen flash by, and a standalone
 * daemon never sees a login form it cannot serve.
 *
 * The link is spent before `refreshAccount` so that probe already sees the new
 * session: the person arrives signed in, rather than watching a login form,
 * submitting nothing, and being reloaded. Its fragment is cleared first so the
 * credential does not stay in history.
 */
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

void (async () => {
  // Before the auth probe: a stored Hub is a different origin, so asking this
  // one who the visitor is would only produce the connect screen this avoids.
  if (await bootIntoStoredHub()) return;
  await bootstrapTokenFromURL();
  const visit = loginVisit(window.location.hash);
  let linkFailed = false;
  if (visit) {
    // Clear it first: the token is about to be spent, and a reload while the
    // request is in flight must not post the same link twice.
    window.history.replaceState({}, "", withoutLoginHash(window.location.href));
    if (visit.malformed) {
      // A truncated or mangled link is still a link somebody followed. Saying
      // so beats ignoring it, which looks identical to a link that never
      // existed.
      linkFailed = true;
      showLinkFailure(new AuthError("login_link_invalid", ""));
    } else {
      try {
        await signInWithLink(visit.token);
      } catch (err) {
        linkFailed = true;
        showLinkFailure(err);
      }
    }
  }
  const state = await refreshAccount();
  if (getToken()) {
    // A device token still works on a Hub, so it wins when one is present --
    // and this visit will never reach the account screen. A one-time code left
    // in the address bar would only sit in the history.
    cleanVisitCredentials();
    if (linkFailed) {
      // The failed exchange closed the gate on its way out. The device token is
      // still here, so the visitor is not signed out; reopen it rather than
      // flash the connect screen.
      useAppStore.getState().setAuthOk();
    }
  } else {
    applyVisitGate();
  }
  // The account screen is the only place that reads the failure parameters.
  // For a visitor who is already signed in it never renders, so the message
  // would stay in the URL and resurface on the next load.
  if (linkFailed && (getToken() || state.authenticated)) {
    clearAuthErrorFromURL();
  }
  createRoot(root).render(
    <StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </StrictMode>,
  );
})();
