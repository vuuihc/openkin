import Foundation
import Observation

/// View model for the task history list screen.
@Observable
final class TaskListViewModel {
    var tasks: [KinTask] = []
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
            let fetched = try await apiClient.tasks()
            tasks = fetched.sorted { $0.createdAt > $1.createdAt }
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
