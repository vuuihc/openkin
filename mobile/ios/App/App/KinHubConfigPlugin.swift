import AuthenticationServices
import Capacitor
import Security
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
        CAPPluginMethod(name: "forgetSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSystemBrowser", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "takeAuthCallback", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "takeConnectLink", returnType: CAPPluginReturnPromise),
    ]

    static let hubURLKey = "kin.hub_url"
    static let callbackKey = "kin.auth_callback"

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
        if insecure, call.getBool("confirm") != true {
            // Flag it and stop: nothing persisted, nothing navigated.
            call.resolve(["url": url.absoluteString, "insecure": true])
            return
        }
        UserDefaults.standard.set(url.absoluteString, forKey: Self.hubURLKey)
        call.resolve(["url": url.absoluteString, "insecure": insecure])
        DispatchQueue.main.async {
            guard let webView = self.bridge?.webView else { return }
            // From here the session being kept is this Hub's, not whichever
            // host the shell looked at before. Reset "seen" with it: a cookie
            // for the old Hub disappearing is not a sign-out from this one.
            let keeper = Self.sessionKeeper
            keeper?.hubHost = url.host
            keeper?.sawSession = false
            var request = URLRequest(url: url)
            request.cachePolicy = .reloadIgnoringLocalCacheData
            // The Hub being connected to may be one this phone has signed in
            // to before (a reinstall, or a switch back). Put the durable copy
            // back before this first request goes out, or the page asks the
            // Hub who this is and is told nobody.
            Self.restoreSession(for: url.host,
                                in: webView.configuration.websiteDataStore.httpCookieStore) { outcome in
                if outcome == .present { keeper?.sawSession = true }
                webView.load(request)
            }
        }
    }

    @objc func clearHubUrl(_ call: CAPPluginCall) {
        // Forgetting the Hub is forgetting the sign-in to it: a session left
        // behind would sign the next person in to an address this one cleared.
        // Both copies go — the Keychain item and the cookie in the webview,
        // which would otherwise be observed and written straight back.
        UserDefaults.standard.removeObject(forKey: Self.hubURLKey)
        Self.forgetStoredSession()
        Self.sessionKeeper?.hubHost = nil
        Self.sessionKeeper?.sawSession = false
        DispatchQueue.main.async {
            guard let store = self.bridge?.webView?.configuration.websiteDataStore.httpCookieStore else {
                call.resolve()
                return
            }
            Self.deleteSessionCookies(in: store, for: nil) { call.resolve() }
        }
    }

    /// Drop the session this shell is on, without waiting for the Hub's
    /// answer to the sign-out request.
    ///
    /// The console calls this as it signs out. The logout request carries the
    /// cookie and normally revokes the row, but a request that fails — a dead
    /// network is exactly when a person signs out — would otherwise leave a
    /// working cookie in the webview and a copy in the Keychain, and the next
    /// reinstall would silently sign them back in. Deleting the cookie here
    /// cannot leak a credential: the Hub's revocation is the real end of the
    /// session, this only removes this phone's copies.
    @objc func forgetSession(_ call: CAPPluginCall) {
        Self.forgetStoredSession()
        Self.sessionKeeper?.sawSession = false
        DispatchQueue.main.async {
            guard let store = self.bridge?.webView?.configuration.websiteDataStore.httpCookieStore else {
                call.resolve()
                return
            }
            Self.deleteSessionCookies(in: store, for: Self.currentHubHost(self.bridge)) {
                call.resolve()
            }
        }
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

    /// Read and clear a pending `kin://connect?url=…` deep link (G8).
    ///
    /// It has its own slot, not the auth callback's: the two messages travel
    /// through the same scheme, and a connect link landing in the window
    /// between a sign-in's callback and the console's 400ms poll would
    /// otherwise overwrite a one-time code mid-flight. Each consumer reads
    /// exactly the message kind it is waiting for.
    @objc func takeConnectLink(_ call: CAPPluginCall) {
        let raw = UserDefaults.standard.string(forKey: Self.connectKey) ?? ""
        if !raw.isEmpty {
            UserDefaults.standard.removeObject(forKey: Self.connectKey)
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
        if Self.isAllowedOrigin(url, serverURL: bridge?.config.serverURL,
                                localURL: bridge?.config.localURL,
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

    // MARK: - The Hub session outliving the app

    /// Where the session cookie's durable copy lives. One item, for the Hub
    /// this phone is signed in to; the item names its host, so it is never
    /// offered to another origin.
    static let sessionCookieName = "kin_session"
    static let keychainService = "dev.openkin.ios.hub-session"
    static let keychainAccount = "hub"

    /// The observer has to outlive this call, so the plugin holds it.
    static var sessionKeeper: HubSessionKeeper?

    /// Start keeping the Hub session where a reinstall cannot reach it, and
    /// put the durable copy back before the bridge's first page load.
    ///
    /// Capacitor calls this from `capacitorDidLoad`, which runs before
    /// `viewDidLoad` starts the load; `setCookie`'s completion therefore lands
    /// before the request usually. When it does not — the restore arrived
    /// while the first request was already in flight — the page it produced
    /// was the signed-out one, so reload once with the cookie in place.
    static func startSessionKeeper(in bridge: CAPBridgeProtocol?) {
        guard let webView = bridge?.webView else { return }
        let store = webView.configuration.websiteDataStore.httpCookieStore
        let host = launchHost(bridge)
        let keeper = HubSessionKeeper(host: host)
        store.add(keeper)
        sessionKeeper = keeper
        restoreSession(for: host, in: store) { outcome in
            switch outcome {
            case .restored:
                // Not `sawSession = true` here: `setCookie` reports no
                // success, and a copy that never reached the store must not
                // make the next empty read look like a sign-out. The observer
                // marks it seen when the cookie is really there.
                //
                // Issue the load again rather than wait and see: the bridge's
                // own load may already be in flight from before the cookie
                // was in the store, and a request that left without it is the
                // sign-in screen. A second load costs one page boot, once,
                // on the launch after a reinstall.
                guard let config = bridge?.config,
                      config.serverURL != config.localURL else { return }
                // Unless the console already moved the webview somewhere
                // else: a runtime `setHubUrl` that landed first chose the
                // origin this launch should keep, and reloading the baked
                // one would undo it.
                if let current = webView.url, !Self.sameOrigin(current, config.appStartServerURL) {
                    return
                }
                var request = URLRequest(url: config.appStartServerURL)
                request.cachePolicy = .reloadIgnoringLocalCacheData
                webView.load(request)
            case .present:
                keeper.sawSession = true
            case .none:
                break
            }
        }
    }

    /// The host the first page load will be on: the build-time origin when one
    /// is baked in, otherwise the Hub stored at runtime, otherwise the one the
    /// Keychain remembers from before a reinstall.
    static func launchHost(_ bridge: CAPBridgeProtocol?) -> String? {
        // serverURL is the host the bridge actually loads; an unset server.url
        // leaves it equal to the bundled console's local URL, which is not a
        // Hub and has nothing to restore.
        if let config = bridge?.config, config.serverURL != config.localURL {
            return config.serverURL.host
        }
        if let raw = storedHubURL(), let host = URL(string: raw)?.host { return host }
        return storedSession()?.host
    }

    /// The Hub the shell is on right now, when that is a Hub rather than the
    /// bundled console. A baked origin wins because that is where the webview
    /// is; otherwise the address the person connected to.
    static func currentHubHost(_ bridge: CAPBridgeProtocol?) -> String? {
        if let config = bridge?.config, config.serverURL != config.localURL {
            return config.serverURL.host
        }
        if let raw = storedHubURL(), let host = URL(string: raw)?.host { return host }
        return nil
    }

    /// Remove the Hub session cookie from the webview's store: for `host`, or
    /// every host when it is nil. Completion runs on the main thread.
    static func deleteSessionCookies(in store: WKHTTPCookieStore, for host: String?,
                                     then: @escaping () -> Void) {
        let wanted = host?.lowercased()
        store.getAllCookies { cookies in
            let matches = cookies.filter { cookie in
                cookie.name == sessionCookieName
                    && (wanted == nil || cookieHost(cookie) == wanted)
            }
            guard !matches.isEmpty else {
                DispatchQueue.main.async { then() }
                return
            }
            let group = DispatchGroup()
            for cookie in matches {
                group.enter()
                store.delete(cookie) { group.leave() }
            }
            group.notify(queue: .main) { then() }
        }
    }

    enum SessionRestore: Equatable {
        /// A saved cookie was written into the store.
        case restored
        /// The store already had a live one; the saved copy was refreshed.
        case present
        /// Nothing to restore: no saved copy, an expired one, or another host.
        case none
    }

    /// Put the saved session cookie for `host` back into `store`.
    ///
    /// A live cookie in the store always wins: it is the one the Hub most
    /// recently issued, and the saved copy is refreshed from it rather than
    /// overwriting it. Completion runs on the main thread.
    ///
    /// A restored cookie cannot be HttpOnly — the properties API has no such
    /// attribute — so the console's own scripts can read it. That is the trust
    /// the page already has: the navigation gate lets nothing but the Hub's
    /// console load in this webview.
    static func restoreSession(for host: String?, in store: WKHTTPCookieStore,
                               then: @escaping (SessionRestore) -> Void) {
        guard let host = host?.lowercased(), !host.isEmpty else {
            DispatchQueue.main.async { then(.none) }
            return
        }
        store.getAllCookies { cookies in
            if let live = cookies.first(where: { cookie in
                cookie.name == sessionCookieName && cookieHost(cookie) == host
                    && !HubSessionKeeper.hasExpired(cookie)
            }) {
                rememberSession(live)
                DispatchQueue.main.async { then(.present) }
                return
            }
            // Only this Hub's copy: a cookie saved for one origin must never
            // be handed to another.
            guard let saved = storedSession(), saved.host == host,
                  let cookie = cookie(from: saved) else {
                DispatchQueue.main.async { then(.none) }
                return
            }
            store.setCookie(cookie) {
                DispatchQueue.main.async { then(.restored) }
            }
        }
    }

    /// Save the cookie the Hub just issued, so the next install of this app
    /// starts signed in.
    ///
    /// A cookie with no `Expires` is not saved: the Hub always sets one
    /// (`setSessionCookie`), and a browser-session cookie is not a credential
    /// this shell should invent a lifetime for.
    static func rememberSession(_ cookie: HTTPCookie) {
        guard let host = cookieHost(cookie), let expires = cookie.expiresDate else { return }
        let saved = StoredSession(host: host, name: cookie.name, value: cookie.value,
                                  path: cookie.path, secure: cookie.isSecure,
                                  expires: expires.timeIntervalSince1970)
        if storedSession() == saved { return }
        writeStoredSession(saved)
    }

    static func forgetStoredSession() {
        writeStoredSession(nil)
    }

    /// The host a cookie belongs to, without the leading dot a domain cookie
    /// carries. `.example.com` and `example.com` are the same origin here.
    static func cookieHost(_ cookie: HTTPCookie) -> String? {
        let host = cookie.domain.trimmingCharacters(in: CharacterSet(charactersIn: "."))
            .lowercased()
        return host.isEmpty ? nil : host
    }

    /// Rebuild the cookie from its saved form. An expired copy is not a
    /// credential any more — the Hub would refuse it and the person would see
    /// a sign-in screen with a stale token behind it — so it is dropped.
    ///
    /// The cookie is host-only: the Hub sets no `Domain` attribute, and a
    /// domain string without a leading dot is the exact-host form. Writing it
    /// back with `.originURL` would be equivalent but silently marks the
    /// cookie secure, which would hide an http Hub's session from its own
    /// origin.
    static func cookie(from saved: StoredSession) -> HTTPCookie? {
        let expires = Date(timeIntervalSince1970: saved.expires)
        guard expires > Date() else { return nil }
        return HTTPCookie(properties: [
            .name: saved.name,
            .value: saved.value,
            .domain: saved.host,
            .path: saved.path,
            .secure: saved.secure ? "TRUE" : "FALSE",
            .expires: expires,
        ])
    }

    // MARK: - Keychain

    /// What the Keychain holds: the cookie, and the host it belongs to.
    struct StoredSession: Codable, Equatable {
        var host: String
        var name: String
        var value: String
        var path: String
        var secure: Bool
        var expires: TimeInterval
    }

    static func storedSession() -> StoredSession? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let saved = try? JSONDecoder().decode(StoredSession.self, from: data) else {
            return nil
        }
        return saved
    }

    /// Replace the saved session, or remove it when `saved` is nil.
    ///
    /// After first unlock, this device only: a session is a bearer credential,
    /// so it is not synced to iCloud and not carried to another device by a
    /// backup restore.
    static func writeStoredSession(_ saved: StoredSession?) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
        ]
        guard let saved, let data = try? JSONEncoder().encode(saved) else {
            SecItemDelete(query as CFDictionary)
            return
        }
        // Update in place when the item exists: a delete-then-add would lose
        // the previous copy if the app died in between, which is the one
        // moment the copy exists for.
        let update = SecItemUpdate(query as CFDictionary,
                                   [kSecValueData as String: data] as CFDictionary)
        guard update == errSecItemNotFound else {
            if update != errSecSuccess {
                CAPLog.print("⚡️  KinHubConfig: could not update the Hub session (\(update))")
            }
            return
        }
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        if status != errSecSuccess {
            // Without a saved copy the app still works; it just signs out on
            // reinstall like before. Say so, because the cause (an entitlement
            // or access-group problem) is invisible from the phone.
            CAPLog.print("⚡️  KinHubConfig: could not save the Hub session (\(status))")
        }
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

    /// The window the system browser presents over.
    ///
    /// A protocol, not a closure: ASWebAuthenticationSession asks an object for
    /// its anchor, and a closure cannot conform to an Objective-C protocol.
    final class PresentationContext: NSObject, ASWebAuthenticationPresentationContextProviding {
        func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
            // The plugin's own window: the key window of the connected scene.
            UIApplication.shared.connectedScenes
                .compactMap { ($0 as? UIWindowScene)?.keyWindow }
                .first ?? UIWindow()
        }
    }

    static let contextProvider = PresentationContext()

    /// A plain-HTTP origin is only tolerable on loopback, where "the network
    /// can read this" means this same machine.
    static func isLoopback(_ host: String) -> Bool {
        let h = host.lowercased()
        return h == "localhost" || h == "127.0.0.1" || h == "::1"
    }
}

/// The scheme's receiving half. SceneDelegate already forwards open URL
/// contexts to Capacitor; the app's own scheme additionally lands the callback
/// where openSystemBrowser's session expects it, and a connect deep link where
/// the console's connect screen reads it (G8: 深链填入 Hub URL).
extension KinHubConfigPlugin {
    /// The app's own callback host.
    static let callbackScheme = "kin"
    static let callbackHost = "auth-callback"
    /// The connect deep link's host: `kin://connect?url=…` pre-fills the Hub
    /// URL on a first-run shell. It carries an address, not a credential —
    /// the person still taps connect — so the worst a forged link does is
    /// put text in a field the person then reads.
    static let connectHost = "connect"
    /// The connect link's handoff slot. Separate from the auth callback's on
    /// purpose: the two message kinds travel through the same scheme, and one
    /// shared slot would let a connect link overwrite a one-time sign-in code
    /// in the window before the console's poll reads it.
    static let connectKey = "kin.connect_link"

    /// Called by SceneDelegate when the app is handed a kin:// URL.
    ///
    /// Only the two hosts this app defined are acted on. `auth-callback` is a
    /// completed sign-in; `connect` is an address to pre-fill. Any other kin://
    /// host is neither, and treating it as either would let a web page plant a
    /// value the console reads as its own.
    static func receiveAuthCallback(_ url: URL) {
        guard url.scheme?.lowercased() == callbackScheme else { return }
        switch url.host?.lowercased() {
        case callbackHost:
            UserDefaults.standard.set(url.absoluteString, forKey: callbackKey)
        case connectHost:
            // The URL parameter is the Hub origin to fill in. Stored to the
            // connect slot; the console reads it once and clears it, and a
            // second link simply overwrites the first.
            if let raw = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "url" })?.value,
                let hub = URL(string: raw),
                let scheme = hub.scheme?.lowercased(),
                scheme == "https" || scheme == "http",
                hub.host != nil {
                UserDefaults.standard.set(url.absoluteString, forKey: connectKey)
            }
        default:
            break
        }
    }
}

/// Watches the webview's cookies and keeps the Hub session in the Keychain.
///
/// A WKWebView's cookie jar lives in the app's data container: deleting the
/// app — the ordinary way to put a fresh development build on a phone — takes
/// the Hub session with it, and the next launch asks for a password the person
/// already gave. The Keychain is the one store that survives that. This writes
/// the session cookie there whenever the Hub issues one, and drops the copy
/// when the cookie leaves the store, which is what signing out looks like.
///
/// A copy that outlives the session it names is not a way back in: the Hub
/// checks the token on every request, and a revoked or expired one earns a
/// 401. Signing out still deletes both copies — the console tells the shell
/// to — because a request that never reached the Hub would otherwise leave a
/// live session behind a login screen.
final class HubSessionKeeper: NSObject, WKHTTPCookieStoreObserver {
    /// The Hub whose session this shell is keeping. Cookies for any other host
    /// are another Hub's sessions and are neither saved nor mistaken for a
    /// sign-out from this one. `setHubUrl` moves it when the person switches.
    var hubHost: String?

    /// Whether this launch has seen *this* Hub's session cookie at all. An
    /// empty answer before that is the cookie store still starting up, not a
    /// sign-out.
    var sawSession = false

    init(host: String?) {
        hubHost = host?.lowercased()
    }

    func cookiesDidChange(in cookieStore: WKHTTPCookieStore) {
        guard let host = hubHost, !host.isEmpty else { return }
        cookieStore.getAllCookies { cookies in
            // The person may have switched Hubs while this read was in
            // flight; the answer is about the old one then.
            guard self.hubHost == host else { return }
            let matching = cookies.filter {
                $0.name == KinHubConfigPlugin.sessionCookieName
                    && KinHubConfigPlugin.cookieHost($0) == host
            }
            guard let live = matching.first(where: { !Self.hasExpired($0) }) else {
                if self.sawSession {
                    self.sawSession = false
                    KinHubConfigPlugin.forgetStoredSession()
                }
                return
            }
            self.sawSession = true
            KinHubConfigPlugin.rememberSession(live)
        }
    }

    /// A cookie with no expiry is a browser-session cookie, not an expired one.
    static func hasExpired(_ cookie: HTTPCookie) -> Bool {
        guard let expires = cookie.expiresDate else { return false }
        return expires <= Date()
    }
}
