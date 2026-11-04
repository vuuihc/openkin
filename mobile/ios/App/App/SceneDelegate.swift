import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        // KinBridgeViewController, not the stock CAPBridgeViewController: it is
        // what registers the app-local KinNativePush plugin with this bridge.
        window?.rootViewController = KinBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        for context in URLContexts {
            // The app's own auth scheme is the system-browser sign-in's way
            // back in (G9). Hand it to the plugin before Capacitor sees it:
            // the ASWebAuthenticationSession has finished either way, and the
            // console reads the callback from the plugin, not the bridge.
            if context.url.scheme?.lowercased() == "kin" {
                KinHubConfigPlugin.receiveAuthCallback(context.url)
            }
        }
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
