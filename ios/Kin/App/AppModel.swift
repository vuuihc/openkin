import Foundation

/// Root model owned by the app, holds navigation-level state
@Observable
final class AppModel {
    /// Conversations are what the app is for, so its tab is the one the app opens
    /// on and the first one in the bar.
    var selectedTab: Tab = .tasks

    enum Tab: String, CaseIterable {
        case tasks = "tasks.tab"
        case projects = "projects.tab"
        case artifacts = "artifacts.tab"
        case settings = "settings.tab"

        var localizationKey: String { rawValue }
    }
}
