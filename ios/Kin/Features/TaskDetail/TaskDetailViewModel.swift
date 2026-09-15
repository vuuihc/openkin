import Foundation
import Observation

/// View model for the task detail and timeline screen.
@Observable
final class TaskDetailViewModel {
    var task: KinTask?
    var events: [TaskEvent] = []
    var workspaces: [Workspace] = []
    var isLoading = false
    var isSending = false
    var error: String?

    /// Keep track of the highest event seq so we can poll incrementally.
    private var highestSeq: Int?

    // MARK: - Public API

    /// Load the task and its full event list from the daemon.
    /// - Parameters:
    ///   - taskId: The task ID to load.
    ///   - apiClient: The API client to use for requests.
    @MainActor
    func load(taskId: String, with apiClient: APIClient) async {
        isLoading = true
        error = nil

        do {
            async let fetchedTask = apiClient.task(id: taskId)
            async let fetchedEvents = apiClient.taskEvents(id: taskId)

            let (taskResult, eventsResult) = try await (fetchedTask, fetchedEvents)

            task = taskResult
            events = eventsResult.sorted { $0.seq < $1.seq }
            highestSeq = events.last?.seq
        } catch {
            self.error = error.localizedDescription
        }

        isLoading = false
    }

    /// Poll for new events since the last known sequence number.
    /// - Parameters:
    ///   - taskId: The task ID to poll.
    ///   - apiClient: The API client to use.
    @MainActor
    func pollEvents(taskId: String, with apiClient: APIClient) async {
        do {
            let newEvents: [TaskEvent]
            if let since = highestSeq {
                newEvents = try await apiClient.taskEvents(id: taskId, sinceSeq: since)
            } else {
                newEvents = try await apiClient.taskEvents(id: taskId)
            }

            guard !newEvents.isEmpty else { return }

            // Merge new events, de-duplicating by seq
            let existingSeqs = Set(events.map(\.seq))
            for event in newEvents {
                if !existingSeqs.contains(event.seq) {
                    events.append(event)
                }
            }
            events.sort { $0.seq < $1.seq }
            highestSeq = events.last?.seq

            // Also refresh the task object to get updated status/elapsed
            let updatedTask = try await apiClient.task(id: taskId)
            task = updatedTask
        } catch {
            // Silently fail for poll — the next poll will retry
        }
    }

    /// Send guidance (a follow-up message) to an active task.
    /// - Parameters:
    ///   - taskId: The task ID.
    ///   - message: The guidance text.
    ///   - apiClient: The API client.
    @MainActor
    func sendGuidance(taskId: String, message: String, with apiClient: APIClient) async -> Bool {
        guard !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return false
        }

        isSending = true
        error = nil

        do {
            try await apiClient.promptTask(id: taskId, message: message)
            isSending = false
            return true
        } catch {
            self.error = error.localizedDescription
            isSending = false
            return false
        }
    }

    /// Cancel an active task.
    /// - Parameters:
    ///   - taskId: The task ID.
    ///   - apiClient: The API client.
    @MainActor
    func cancel(taskId: String, with apiClient: APIClient) async {
        error = nil

        do {
            try await apiClient.cancelTask(id: taskId)
            // Refresh the task to reflect cancelled state
            let updatedTask = try await apiClient.task(id: taskId)
            task = updatedTask
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Retry a finished (failed or cancelled) task.
    /// - Parameters:
    ///   - taskId: The task ID.
    ///   - apiClient: The API client.
    /// - Returns: The new task ID from the retry, or nil on failure.
    @MainActor
    func retry(taskId: String, with apiClient: APIClient) async -> String? {
        error = nil

        do {
            let newTask = try await apiClient.retryTask(id: taskId)
            return newTask.id
        } catch {
            self.error = error.localizedDescription
            return nil
        }
    }

    /// Load workspaces for the given task.
    /// - Parameters:
    ///   - taskId: The task ID.
    ///   - apiClient: The API client.
    @MainActor
    func loadWorkspaces(taskId: String, with apiClient: APIClient) async {
        do {
            workspaces = try await apiClient.workspaces(taskId: taskId)
        } catch {
            self.error = error.localizedDescription
        }
    }
}