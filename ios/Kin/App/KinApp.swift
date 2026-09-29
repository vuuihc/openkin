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
            .task {
                if scenePhase == .active {
                    appSession.startForegroundSync()
                }
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active {
                    appSession.startForegroundSync()
                } else {
                    appSession.stopForegroundSync()
                }
            }
        }
    }
}
