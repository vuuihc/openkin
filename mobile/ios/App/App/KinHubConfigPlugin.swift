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
        if scheme == "http", !Self.isLoopback(url.host ?? "") {
            // Allowed — a LAN install is a normal way to run a Hub — but the
            // console has to be the one to offer it, so the answer carries the
            // fact and the console decides.
            call.resolve(["url": url.absoluteString, "insecure": true])
            // …and still navigate: the person typed the LAN address on
            // purpose, and the console's warning is already on screen.
        } else {
            call.resolve(["url": url.absoluteString, "insecure": false])
        }
        UserDefaults.standard.set(url.absoluteString, forKey: Self.hubURLKey)
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
    static func receiveAuthCallback(_ url: URL) {
        guard url.scheme?.lowercased() == callbackScheme else { return }
        UserDefaults.standard.set(url.absoluteString, forKey: callbackKey)
    }
}
