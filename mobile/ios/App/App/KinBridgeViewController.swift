import Capacitor

/// The console's bridge, with the one plugin this app target ships itself.
///
/// Kin's push contract only means something inside the iPhone shell: a browser
/// has no APNs token and the desktop app is reached through the node's event
/// bus. Keeping the plugin app-local avoids publishing a Capacitor package for
/// a single client and keeps its lifetime tied to this bridge.
final class KinBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(KinNativePushPlugin())
        // Runtime Hub URL and system-browser sign-in (G8/G9).
        bridge?.registerPluginInstance(KinHubConfigPlugin())
        if let webView = bridge?.webView {
            KinPushState.shared.attach(webView)
        }
    }
}
