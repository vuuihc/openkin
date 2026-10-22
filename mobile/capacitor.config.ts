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
 * The Hub origin is baked in at sync time, so this is per-deployment: build the
 * app against the domain your Hub is reachable at.
 */
const hubUrl = process.env.KIN_HUB_URL;
if (!hubUrl) {
  throw new Error(
    "Set KIN_HUB_URL to the origin your Hub is served at, e.g.\n" +
      "  KIN_HUB_URL=https://kin.example.com npm run sync",
  );
}
const origin = new URL(hubUrl);

const config: CapacitorConfig = {
  appId: "dev.openkin.ios",
  appName: "Kin",
  // Still shipped inside the app: if the Hub cannot be reached on launch, the
  // user sees the console's own connection screen instead of a blank webview.
  webDir: "../web/dist",
  server: {
    url: hubUrl,
    allowNavigation: [origin.host],
    // A Hub on the LAN over plain http is a normal way to run this while
    // setting the NAS up; iOS blocks it unless the app says otherwise.
    cleartext: origin.protocol === "http:",
  },
  ios: {
    // The console draws its own chrome; keep it out from under the status bar
    // and the home indicator.
    contentInset: "always",
  },
};

export default config;
