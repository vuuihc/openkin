import Foundation
import Observation

/// View model for the task history list screen metadata.
@Observable
final class TaskListViewModel {
    /// Projects are loaded only to bucket sessions: a session carries its folder
    /// and, when the daemon filed it, a project id, but the directory that maps a
    /// folder to a project lives on the project. `status: "all"` so a session in a
    /// paused or archived project still groups under it instead of falling out of
    /// the list's grouping.
    var projects: [Project] = []
    var isLoading = false
    var error: String?

    /// Whether an initial load has been attempted.
    private(set) var hasLoadedOnce = false
    private var boundProfileID: UUID?

    // MARK: - Computed

    /// Fetch the project list used to group chats.
    /// - Parameter apiClient: The API client to use for the request.
    @MainActor
    func loadProjects(with apiClient: APIClient, profileID: UUID?, isProfileCurrent: () -> Bool) async {
        if boundProfileID != profileID {
            projects = []
            hasLoadedOnce = false
            boundProfileID = profileID
        }
        isLoading = true
        error = nil

        do {
            let loadedProjects = try await apiClient.projects(status: "all")
            guard isProfileCurrent() else { return }
            projects = loadedProjects
            hasLoadedOnce = true
        } catch {
            guard isProfileCurrent() else { return }
            self.error = error.localizedDescription
        }

        if isProfileCurrent() {
            isLoading = false
        }
    }
}
