import Foundation

/// Root model owned by the app, holds navigation-level state
@Observable
final class AppModel {
    var selectedTab: Tab = .control
    var connectionState: ConnectionState = .unconfigured
    var navigationPath: [AppRoute] = []

    /// Number of pending approvals and unanswered questions across all tasks.
    var pendingActionCount: Int {
        // View models own approval/question collections; this property provides
        // a single entry point for badge display when they report counts upstream.
        0
    }

    enum Tab: String, CaseIterable {
        case control = "control.tab"
        case tasks = "tasks.tab"
        case settings = "settings.tab"

        var localizationKey: String { rawValue }
    }
}