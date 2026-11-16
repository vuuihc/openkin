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
 *
 * Navigation is gated by the KinHubConfig plugin, not by an allowNavigation
 * wildcard: Capacitor injects the native bridge into every main-frame
 * document, so a wildcard would hand the plugin surface — including the
 * pending auth callback — to whatever origin the webview lands on. The plugin
 * allows only the stored Hub origin (and the bundled console) and sends
 * everything else to the system browser. `server.allowNavigation` stays empty
 * for the same reason; the build-time origin, when present, is listed there so
 * the very first load is allowed before any plugin state exists.
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
  ...(origin
    ? {
        server: {
          url: origin.href,
          // The build-time origin may take over the webview; every runtime
          // origin is the plugin's decision (see above).
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
