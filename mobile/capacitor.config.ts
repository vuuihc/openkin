import type { CapacitorConfig } from "@capacitor/cli";

/**
 * The phone runs the Hub's own console.
 *
 * Kin has one console, and it is served by the Hub; the app is a shell around
 * the Hub's URL rather than a second UI that has to be kept in step with it.
 * That also settles the awkward part of a native client: the console signs in
 * with a cookie, and a cookie is only first-party when the page is loaded from
 * the origin that set it. Loading the Hub's URL directly makes the webview that
 * origin, so login, and every relative /api call, behave exactly as they do in
 * a browser. The Electron desktop shell already works this way.
 *
 * The Hub origin is a fact about where the person's Hub is, not about which
 * build they installed (G8). KIN_HUB_URL, when given, is only the origin the
 * app opens first; at runtime the origin lives in the app's own settings —
 * typed, scanned, or deep-linked on the connect screen, changeable in
 * Settings, persisted by the shell (KinHubConfig plugin). One universal build
 * works for every deployment, hosted or self-hosted.
 *
 * The build-time value is therefore optional. When absent the app boots on its
 * bundled console (`webDir`), which shows the connect screen; the bundled copy
 * also serves as the fallback when a stored Hub cannot be reached.
 */
const hubUrl = process.env.KIN_HUB_URL;
if (hubUrl !== undefined && hubUrl !== "") {
  // Fail at build time on something that would silently not work.
  const parsed = new URL(hubUrl);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`KIN_HUB_URL must be an http(s) origin, got: ${hubUrl}`);
  }
}

const origin = hubUrl ? new URL(hubUrl) : null;

const config: CapacitorConfig = {
  appId: "dev.openkin.ios",
  appName: "Kin",
  // Still shipped inside the app: the first-run connect screen, and the
  // fallback a phone falls back to when its Hub cannot be reached.
  webDir: "../web/dist",
  // allowNavigation cannot name every Hub a build may point at — that is the
  // point of the runtime URL — so any https origin (and http for a LAN Hub)
  // may take over the webview. The scheme a hostile page could reach the
  // bridge through is not widened by this: Capacitor only honors http(s)
  // navigations here, and the bundled console is still what executes first.
  allowNavigation: ["*"],
  ...(origin
    ? {
        server: {
          url: origin.href,
          allowNavigation: [origin.host],
          // A Hub on the LAN over plain http is a normal way to run this while
          // setting the NAS up; iOS blocks it unless the app says otherwise.
          cleartext: origin.protocol === "http:",
        },
      }
    : {}),
  ios: {
    // "never", not Capacitor's other insets: the console already pads itself
    // for the notch and the home indicator with env(safe-area-inset-*), and it
    // asks for the whole screen with `viewport-fit=cover`. Letting UIKit inset
    // the scroll view as well applied the safe area twice — the page started
    // below the status bar and stopped above the home indicator, and the strip
    // left over was the webview's own background. On a phone in light mode that
    // background is the system's (white), so the strip read as a white bar at
    // the top and bottom of the app.
    contentInset: "never",
    // What shows through before the console has painted, and in any gap it
    // leaves. It has to be `--kin-page` in the console's default (dark) scheme,
    // not the system background: a light-mode phone would otherwise flash white
    // around a console that is dark. Kept in step with
    // `ui/src/design/theme.css` by `tokens.test.ts`.
    backgroundColor: "#0e0e10",
  },
};

export default config;
