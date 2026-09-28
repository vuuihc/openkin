import Foundation
import Observation

/// View model for the task history list screen.
@Observable
final class TaskListViewModel {
    var tasks: [KinTask] = []
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

    // MARK: - Computed

    /// Tasks that are still in progress (not in a terminal state).
    var activeTasks: [KinTask] {
        tasks.filter { !$0.isTerminal }
    }

    /// Tasks that have reached a terminal state.
    var completedTasks: [KinTask] {
        tasks.filter { $0.isTerminal }
    }

    // MARK: - Public API

    /// Fetch the latest task list from the daemon.
    /// - Parameter apiClient: The API client to use for the request.
    @MainActor
    func load(with apiClient: APIClient) async {
        isLoading = true
        error = nil

        do {
            async let fetchedTasks = apiClient.tasks()
            async let fetchedProjects = apiClient.projects(status: "all")
            let loadedTasks = try await fetchedTasks
            // Sessions are the screen's content and the project list only decides
            // how they are bucketed, so a project fetch that fails degrades the
            // grouping instead of emptying the screen.
            let loadedProjects = (try? await fetchedProjects) ?? []
            tasks = loadedTasks.sorted { $0.createdAt > $1.createdAt }
            projects = loadedProjects
            hasLoadedOnce = true
        } catch {
            self.error = error.localizedDescription
        }

        isLoading = false
    }

    /// Filter the task list by a search query, matching prompt, cwd, and agent.
    /// - Parameter query: The user's search string.
    /// - Returns: Filtered tasks; if `query` is empty, returns all tasks.
    func filteredTasks(query: String) -> [KinTask] {
        TaskPresentation.filter(tasks, query: query)
    }
}
