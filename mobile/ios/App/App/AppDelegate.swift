import UIKit
import Capacitor
import UserNotifications

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Set before the app finishes launching: a tap that launched a killed
        // app is delivered to this delegate once it is set, and the console may
        // not have mounted yet — KinPushState holds the link for it.
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    // MARK: - APNs

    /// iOS hands the token here whenever registration (re)starts, including
    /// when it rotates. The console reads it through the plugin and registers
    /// it with the node; nothing is stored beyond this process.
    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        KinPushState.shared.setToken(token)
    }

    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        KinPushState.shared.setRegistrationError(error.localizedDescription)
    }

    // MARK: - Notifications

    /// A notification that arrives while the app is in front becomes an in-app
    /// banner instead of a system one: the reader is already here, and the
    /// console can show the same title and body without a second announcement
    /// from iOS. If there is no console attached, fall back to the system
    /// banner rather than dropping the event.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        let content = notification.request.content
        let kin = content.userInfo["kin"] as? [String: Any]
        let delivered = KinPushState.shared.receive(
            title: content.title,
            body: content.body,
            kind: kin?["kind"] as? String ?? "",
            id: kin?["id"] as? String ?? "",
            url: kin?["url"] as? String
        )
        completionHandler(delivered ? [] : [.banner, .list, .sound])
    }

    /// The tap. The node writes the console link into `kin.url`; the console
    /// validates it again before navigating. Only a real tap opens the link:
    /// dismissing a banner is not an instruction to go anywhere.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier else {
            completionHandler()
            return
        }
        let info = response.notification.request.content.userInfo
        if let kin = info["kin"] as? [String: Any],
           let url = kin["url"] as? String,
           !url.isEmpty {
            KinPushState.shared.open(url: url)
        }
        completionHandler()
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}
