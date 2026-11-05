import AuthenticationServices
import Capacitor
import UIKit

/// The shell half of the runtime Hub URL and the system-browser sign-in (G8/G9).
///
/// The Hub origin is a fact about where the person's Hub is, not about which
/// build they installed, so the shell holds it in UserDefaults and points the
/// webview at it after launch. A first-run app has none: the webview starts on
/// the bundled console, whose connect screen collects the URL (typed, scanned,
/// or deep-linked) and hands it here.
///
/// The plugin also owns navigation policy for the webview. Capacitor injects
/// its bridge into every main-frame document, so where the webview may go is
/// a permission decision, not a convenience: this plugin allows only the
/// stored Hub origin and the bundled console, and sends everything else — an
/// OAuth provider, a stray link in rendered content — out of the webview
/// rather than handing it the bridge. `shouldOverrideLoad` runs before
/// Capacitor's own allowNavigation check, so this is the single gate.
///
/// Sign-in that needs a real browser — OAuth with a provider, or a one-time
/// link the console cannot open in its own webview without losing the
/// first-party cookie — runs through ASWebAuthenticationSession. The browser
/// is the system's, not a WKWebView (G9: an embedded browser never sees the
/// provider's session); the callback is a one-time code on this app's scheme,
/// handed to the console, which exchanges it on its own origin.
@objc(KinHubConfigPlugin)
public class KinHubConfigPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "KinHubConfigPlugin"
    public let jsName = "KinHubConfig"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getHubUrl", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setHubUrl", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearHubUrl", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSystemBrowser", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "takeAuthCallback", returnType: CAPPluginReturnPromise),
    ]

    static let hubURLKey = "kin.hub_url"
    static let callbackKey = "kin.auth_callback"

    /// A callback URL only counts when it is this app's own scheme (G9: a
    /// random app cannot be handed another app's code by a link that names a
    /// different scheme) and carries a short, opaque value.
    static let callbackScheme = "kin"
    static let callbackHost = "auth-callback"

    @objc func getHubUrl(_ call: CAPPluginCall) {
        let raw = UserDefaults.standard.string(forKey: Self.hubURLKey) ?? ""
        call.resolve(["url": raw])
    }

    /// Persist the origin and move the webview to it. Loading the origin is
    /// what makes the session cookie first-party, so this is one action, not
    /// two: a stored URL the webview is not on would be a shell pretending.
    ///
    /// A plain-HTTP origin off loopback is refused the first time — the
    /// console shows why and resubmits with `confirm: true`, which is the tap
    /// that means the warning was read. Nothing is saved and no navigation
    /// happens before that point: an origin the person has not confirmed is
    /// not one the shell acts on.
    @objc func setHubUrl(_ call: CAPPluginCall) {
        guard let raw = call.getString("url")?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty else {
            call.reject("a Hub URL is required")
            return
        }
        // Public deployments must be HTTPS (G8). A LAN origin may stay plain
        // HTTP — the console labels that — but nothing else is accepted.
        guard let url = URL(string: raw), let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http", url.host != nil else {
            call.reject("that does not look like a Hub URL (expect https://hub.example.com)")
            return
        }
        let insecure = scheme == "http" && !Self.isLoopback(url.host ?? "")
        if insecure, call.getBoolean("confirm") != true {
            // Flag it and stop: nothing persisted, nothing navigated.
            call.resolve(["url": url.absoluteString, "insecure": true])
            return
        }
        UserDefaults.standard.set(url.absoluteString, forKey: Self.hubURLKey)
        call.resolve(["url": url.absoluteString, "insecure": insecure])
        DispatchQueue.main.async {
            guard let webView = self.bridge?.webView else { return }
            var request = URLRequest(url: url)
            request.cachePolicy = .reloadIgnoringLocalCacheData
            webView.load(request)
        }
    }

    @objc func clearHubUrl(_ call: CAPPluginCall) {
        UserDefaults.standard.removeObject(forKey: Self.hubURLKey)
        call.resolve()
    }

    /// Open a URL in the system browser and come back with the callback the
    /// flow lands on. `kin://auth-callback?...` is the scheme this app owns;
    /// the session prefills it, iOS shows the consent bar, and the code never
    /// passes through this webview.
    @objc func openSystemBrowser(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"), let url = URL(string: raw),
              let scheme = url.scheme?.lowercased(), scheme == "https" else {
            call.reject("the system browser opens https URLs only")
            return
        }
        DispatchQueue.main.async {
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: Self.callbackScheme) { callbackURL, error in
                if let callbackURL, callbackURL.host == Self.callbackHost {
                    UserDefaults.standard.set(callbackURL.absoluteString, forKey: Self.callbackKey)
                }
                // A cancelled session is a normal outcome, not an error the
                // console needs a dialog for; takeAuthCallback simply stays empty.
                _ = error
            }
            // A browser window needs a presentation context; the shell's key
            // window is the one showing the console.
            session.presentationContextProvider = Self.contextProvider
            session.prefersEphemeralWebBrowserSession = false
            Self.currentSession = session
            session.start()
            call.resolve()
        }
    }

    /// Read and clear the pending callback. The console polls this after the
    /// browser reports back, exactly like takePendingURL for notifications.
    @objc func takeAuthCallback(_ call: CAPPluginCall) {
        let raw = UserDefaults.standard.string(forKey: Self.callbackKey) ?? ""
        if !raw.isEmpty {
            UserDefaults.standard.removeObject(forKey: Self.callbackKey)
        }
        call.resolve(["url": raw])
    }

    /// The navigation gate. Runs before Capacitor's own allowNavigation check
    /// (WebViewDelegationHandler consults plugins first), so this decides for
    /// every main-frame load the webview attempts. `nil` would mean "no
    /// opinion" and defer to allowNavigation; answering explicitly keeps the
    /// policy in one place, here.
    ///
    /// Allowed: the stored Hub origin, the build-time server origin (a Hub
    /// URL baked in at build time boots there), and the bundled console's own
    /// hosts. Everything else is cancelled — the console's links to external
    /// help pages go through the OS scheme handler below, not this webview.
    override public func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        // Sub-frame and other non-main-frame loads follow the main document's
        // origin, which this gate already decided on.
        guard navigationAction.targetFrame?.isMainFrame == true else { return false }
        guard let url = navigationAction.request.url else { return true }
        if Self.isAllowedOrigin(url, serverURL: bridge?.config?.serverURL,
                                localURL: bridge?.config?.localURL,
                                hubURL: Self.storedHubURL()) {
            return false
        }
        // An external origin in main-frame position is not navigated; hand it
        // to the OS the way a tap outside an app would be. Returning true
        // cancels the web load, and the scheme handler below takes it.
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:], completionHandler: nil)
        }
        return true
    }

    /// Whether `url` is an origin the webview may load in the main frame.
    static func isAllowedOrigin(_ url: URL, serverURL: URL?, localURL: URL?, hubURL: String?) -> Bool {
        // The bundled console, in both shapes Capacitor serves it.
        if url.scheme?.lowercased() == "capacitor" { return true }
        if let local = localURL, sameOrigin(url, local) { return true }
        if let server = serverURL, sameOrigin(url, server) { return true }
        // The Hub this shell is pointed at.
        if let hub = hubURL, let hubURL = URL(string: hub), sameOrigin(url, hubURL) { return true }
        return false
    }

    static func storedHubURL() -> String? {
        let raw = UserDefaults.standard.string(forKey: hubURLKey) ?? ""
        return raw.isEmpty ? nil : raw
    }

    /// Origin equality: scheme, host, and effective port. A path is not part
    /// of an origin, and the Hub serves the console from wherever it mounts
    /// it. URL.port is nil when the URL omits the port, so the scheme's
    /// default is filled in here — otherwise a stored `https://hub.example.com`
    /// and a link to `https://hub.example.com:443/` would read as different
    /// origins and the link would pointlessly open in the system browser.
    static func sameOrigin(_ a: URL, _ b: URL) -> Bool {
        guard let aHost = a.host, let bHost = b.host else { return false }
        return a.scheme?.lowercased() == b.scheme?.lowercased()
            && aHost.lowercased() == bHost.lowercased()
            && effectivePort(a) == effectivePort(b)
    }

    /// The port a URL answers on, counting a scheme's default when the URL
    /// omits it.
    static func effectivePort(_ url: URL) -> Int {
        if let port = url.port { return port }
        switch url.scheme?.lowercased() {
        case "https": return 443
        case "http", "capacitor": return 80
        default: return -1
        }
    }

    static weak var currentSession: ASWebAuthenticationSession?

    static let contextProvider: ASWebAuthenticationPresentationContextProviding = { _ in
        // The plugin's own window: the key window of the connected scene.
        UIApplication.shared.connectedScenes
            .compactMap { ($0 as? UIWindowScene)?.keyWindow }
            .first ?? UIWindow()
    }

    /// A plain-HTTP origin is only tolerable on loopback, where "the network
    /// can read this" means this same machine.
    static func isLoopback(_ host: String) -> Bool {
        let h = host.lowercased()
        return h == "localhost" || h == "127.0.0.1" || h == "::1"
    }
}

/// The scheme's receiving half. SceneDelegate already forwards open URL
/// contexts to Capacitor; the app's own scheme additionally lands the callback
/// where openSystemBrowser's session expects it.
extension KinHubConfigPlugin {
    /// Called by SceneDelegate when the app is handed `kin://auth-callback?…`.
    /// Only this app's own callback host is stored: any other kin:// host is
    /// not a sign-in answer, and treating it as one would let a web page
    /// plant a value the console reads as a completed flow.
    static func receiveAuthCallback(_ url: URL) {
        guard url.scheme?.lowercased() == callbackScheme,
              url.host?.lowercased() == callbackHost else { return }
        UserDefaults.standard.set(url.absoluteString, forKey: callbackKey)
    }
}
