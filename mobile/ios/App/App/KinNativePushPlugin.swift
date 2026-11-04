import Capacitor
import UIKit
import UserNotifications

/// The iPhone shell's own Capacitor plugin.
///
/// It exists only in this app target, so it is registered by
/// `KinBridgeViewController` rather than packaged separately. Its job is the
/// part only native code can do: ask iOS for the notification permission, wait
/// for the APNs token, and hand both to the console. The console decides when
/// to ask (a tap, never on load) and registers the token with the node.
@objc(KinNativePushPlugin)
public class KinNativePushPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "KinNativePushPlugin"
    public let jsName = "KinNativePush"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "permission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "register", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unregister", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "takePendingURL", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearDelivered", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deliveredTargets", returnType: CAPPluginReturnPromise),
    ]

    /// The registration answer can take a few seconds on a cold launch or a
    /// poor connection; long enough not to turn a slow network into "failed".
    private static let tokenTimeout: TimeInterval = 20

    @objc func permission(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            call.resolve(["status": Self.statusName(settings.authorizationStatus)])
        }
    }

    @objc func requestPermission(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().requestAuthorization(
            options: [.alert, .badge, .sound]
        ) { _, _ in
            // Re-read rather than trust `granted`: provisional and ephemeral
            // authorizations report as granted here but the console's contract
            // is the three statuses it shows and stores.
            UNUserNotificationCenter.current().getNotificationSettings { settings in
                call.resolve(["status": Self.statusName(settings.authorizationStatus)])
            }
        }
    }

    /// Resolve with a registration the node can store. Registers with APNs on
    /// every call that has no token yet, which is also how a rotated token is
    /// picked up after the console re-syncs on launch.
    @objc func register(_ call: CAPPluginCall) {
        if let token = KinPushState.shared.currentToken {
            call.resolve(Self.registration(token: token))
            return
        }
        DispatchQueue.main.async {
            UIApplication.shared.registerForRemoteNotifications()
        }
        KinPushState.shared.waitForToken(timeout: Self.tokenTimeout) { result in
            switch result {
            case .success(let token):
                call.resolve(Self.registration(token: token))
            case .failure(let error):
                call.reject(error.message)
            }
        }
    }

    /// Stop APNs delivery for this installation. The console deletes the node's
    /// row first, so this only has to make the phone quiet.
    @objc func unregister(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            UIApplication.shared.unregisterForRemoteNotifications()
        }
        KinPushState.shared.clearToken()
        call.resolve()
    }

    /// The only way back from "Blocked by iOS" is the system settings page.
    @objc func openSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let url = URL(string: UIApplication.openSettingsURLString) else {
                call.resolve()
                return
            }
            UIApplication.shared.open(url, options: [:]) { _ in
                call.resolve()
            }
        }
    }

    /// Remove the banner for an item the person already handled. Delivered
    /// notifications belong to the system, so the only way to take one away is
    /// to ask by identifier; the `kin` payload the node attached says which
    /// item each one is about. No match is a normal outcome, not a failure.
    @objc func clearDelivered(_ call: CAPPluginCall) {
        let kind = call.getString("kind") ?? ""
        let id = call.getString("id") ?? ""
        guard !id.isEmpty else {
            call.resolve()
            return
        }
        let center = UNUserNotificationCenter.current()
        center.getDeliveredNotifications { delivered in
            let identifiers = delivered.compactMap { notification -> String? in
                guard
                    let kin = notification.request.content.userInfo["kin"] as? [String: Any],
                    let deliveredID = kin["id"] as? String,
                    deliveredID == id
                else { return nil }
                if !kind.isEmpty, (kin["kind"] as? String) != kind { return nil }
                return notification.request.identifier
            }
            if !identifiers.isEmpty {
                center.removeDeliveredNotifications(withIdentifiers: identifiers)
            }
            call.resolve()
        }
    }

    /// What is still sitting in Notification Center. A banner can outlive the
    /// console process, so a cold start reconciles this against the node's
    /// pending list instead of learning about old banners from a diff it never
    /// saw. Only the `kin` targets cross over; the notification text stays in
    /// the system.
    @objc func deliveredTargets(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().getDeliveredNotifications { delivered in
            let targets: [[String: String]] = delivered.compactMap { notification in
                guard
                    let kin = notification.request.content.userInfo["kin"] as? [String: Any],
                    let id = kin["id"] as? String,
                    !id.isEmpty
                else { return nil }
                return ["kind": (kin["kind"] as? String) ?? "", "id": id]
            }
            call.resolve(["targets": targets])
        }
    }

    /// A notification tap that arrived before the console had a router. The
    /// console drains this once on mount; the link is cleared as it is read.
    ///
    /// Deliberately does not attach the web view: `KinBridgeViewController`
    /// attaches it when the bridge loads, and attaching again here would flush
    /// the event path and this held link for the same tap — two deliveries of
    /// one tap.
    @objc func takePendingURL(_ call: CAPPluginCall) {
        if let url = KinPushState.shared.takePendingURL() {
            call.resolve(["url": url])
        } else {
            call.resolve()
        }
    }

    // MARK: - Values

    private static func registration(token: String) -> [String: Any] {
        var payload: [String: Any] = [
            // identifierForVendor is stable for this install and, unlike the
            // APNs token, survives a token rotation. The node upserts on it.
            "installId": UIDevice.current.identifierForVendor?.uuidString ?? "",
            "token": token.lowercased(),
            "environment": environment,
        ]
        let name = UIDevice.current.name
        if !name.isEmpty {
            payload["name"] = name
        }
        return payload
    }

    /// The same value the aps-environment entitlement is built from, so a
    /// development build cannot send a sandbox token to production.
    private static var environment: String {
        let configured =
            Bundle.main.object(forInfoDictionaryKey: "KinAPNsEnvironment") as? String
        if configured == "production" { return "production" }
        if configured == "development" || configured == "sandbox" { return "sandbox" }
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }

    private static func statusName(_ status: UNAuthorizationStatus) -> String {
        switch status {
        case .authorized, .provisional, .ephemeral:
            return "granted"
        case .denied:
            return "denied"
        case .notDetermined:
            return "prompt"
        @unknown default:
            return "prompt"
        }
    }
}
