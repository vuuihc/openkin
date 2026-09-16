import SwiftUI

@main
struct KinApp: App {
    @State private var appModel = AppModel()
    @State private var appSession = AppSession()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(appModel)
                .environment(appSession)
            .onChange(of: scenePhase) { _, phase in
                guard phase == .active else { return }
                Task { await appSession.reconcileForeground() }
            }
        }
    }
}
