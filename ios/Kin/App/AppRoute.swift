import Foundation

/// Navigation routes within the app
enum AppRoute: Hashable {
    case taskDetail(id: String)
    case newTask
    case settings
    case connection
}