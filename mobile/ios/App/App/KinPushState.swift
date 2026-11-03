import Foundation
import UIKit
import WebKit

/// The values APNs delivers asynchronously, held for the two readers that need
/// them: the plugin (JS asks for a token) and the app delegate (iOS hands one
/// over), plus the link from a notification tap.
///
/// All of it is guarded by one lock because APNs callbacks and plugin calls do
/// not share a queue. Nothing here prompts, decides, or talks to the node — it
/// only carries answers between UIKit and the console.
final class KinPushState {
    static let shared = KinPushState()

    private let lock = NSLock()
    private var token: String?
    private var waiters: [UUID: (Result<String, String>) -> Void] = [:]
    private var pendingURL: String?
    private weak var webView: WKWebView?

    private init() {}

    // MARK: - Web view

    /// Remember the console's web view so a tap can be delivered as an event
    /// without the plugin being called first.
    func attach(_ webView: WKWebView) {
        lock.lock()
        self.webView = webView
        lock.unlock()
        flushPendingURL()
    }

    // MARK: - APNs

    var currentToken: String? {
        lock.lock()
        defer { lock.unlock() }
        return token
    }

    /// A registration answer from APNs, including a rotated token.
    func setToken(_ token: String) {
        lock.lock()
        self.token = token
        let waiters = self.waiters
        self.waiters.removeAll()
        lock.unlock()
        for (_, resolve) in waiters {
            resolve(.success(token))
        }
    }

    /// APNs refused; every call waiting for a token fails with this message.
    func setRegistrationError(_ message: String) {
        lock.lock()
        let waiters = self.waiters
        self.waiters.removeAll()
        lock.unlock()
        for (_, resolve) in waiters {
            resolve(.failure(message))
        }
    }

    /// Stop delivering: the next registration starts from scratch. Waiters are
    /// failed rather than left to be resolved by a token that arrives after the
    /// person turned notifications off — which would re-register a row the
    /// console just deleted.
    func clearToken() {
        lock.lock()
        token = nil
        let waiters = self.waiters
        self.waiters.removeAll()
        lock.unlock()
        for (_, resolve) in waiters {
            resolve(.failure("registration was cancelled"))
        }
    }

    /// Resolve with the current token, or with the next one APNs delivers.
    /// A waiter that times out is removed first, so a late callback cannot
    /// resolve a call twice.
    func waitForToken(
        timeout: TimeInterval,
        completion: @escaping (Result<String, String>) -> Void
    ) {
        lock.lock()
        if let token = token {
            lock.unlock()
            completion(.success(token))
            return
        }
        let id = UUID()
        waiters[id] = completion
        lock.unlock()

        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak self] in
            guard let self = self else { return }
            self.lock.lock()
            let waiter = self.waiters.removeValue(forKey: id)
            self.lock.unlock()
            waiter?(.failure("APNs did not answer in time"))
        }
    }

    // MARK: - Foreground delivery

    /// Show a notification that arrived while the app is in front.
    ///
    /// The system banner is suppressed in that case: the reader is already
    /// looking at Kin, and two copies of the same announcement (a banner plus
    /// the console's own view) is noise. Returns false when there is no console
    /// to hand it to, which is the one case where the system banner should
    /// still be shown.
    @discardableResult
    func receive(title: String, body: String, kind: String, id: String, url: String?) -> Bool {
        lock.lock()
        guard let webView = webView else {
            lock.unlock()
            return false
        }
        lock.unlock()

        var payload: [String: String] = ["title": title, "body": body, "kind": kind, "id": id]
        if let url = url, !url.isEmpty {
            payload["url"] = url
        }
        guard
            let data = try? JSONSerialization.data(withJSONObject: payload),
            let json = String(data: data, encoding: .utf8)
        else {
            return false
        }
        let script =
            "window.dispatchEvent(new CustomEvent('kin:notification-received', " +
            "{ detail: \(json) }));"
        DispatchQueue.main.async {
            webView.evaluateJavaScript(script, completionHandler: nil)
        }
        return true
    }

    // MARK: - Notification taps

    /// Keep the tap's link and, when the console is already running, deliver it
    /// as the event its router listens for.
    func open(url: String) {
        lock.lock()
        pendingURL = url
        lock.unlock()
        flushPendingURL()
    }

    /// Read and clear the held link. The console calls this after mounting, so
    /// a tap that arrived while the page was loading still lands once — and is
    /// not replayed on the next launch.
    func takePendingURL() -> String? {
        lock.lock()
        defer { lock.unlock() }
        let url = pendingURL
        pendingURL = nil
        return url
    }

    private func flushPendingURL() {
        lock.lock()
        guard let url = pendingURL, let webView = webView else {
            lock.unlock()
            return
        }
        lock.unlock()

        // Deliberately does not clear `pendingURL`: the console acknowledges a
        // route it received with `takePendingURL`. If the page was still
        // loading, the event is lost and the mount drain picks it up.
        let script =
            "window.dispatchEvent(new CustomEvent('kin:notification', " +
            "{ detail: { url: \(Self.jsString(url)) } }));"
        DispatchQueue.main.async {
            webView.evaluateJavaScript(script, completionHandler: nil)
        }
    }

    /// Encode one string as a JavaScript literal. JSON is a subset of JS string
    /// syntax, and the brackets are stripped from a one-element array so the
    /// result is the quoted value itself.
    private static func jsString(_ value: String) -> String {
        guard
            let data = try? JSONSerialization.data(withJSONObject: [value]),
            let json = String(data: data, encoding: .utf8),
            json.count >= 2
        else {
            return "\"\""
        }
        return String(json.dropFirst().dropLast())
    }
}
