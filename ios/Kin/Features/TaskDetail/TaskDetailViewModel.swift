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

    /// Keep track of the current event position for retry epochs.
    private var currentEpoch: Int64?

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
            events = eventsResult.sorted {
                ($0.eventEpoch, $0.seq) < ($1.eventEpoch, $1.seq)
            }
            currentEpoch = events.last?.eventEpoch
        } catch {
            self.error = error.localizedDescription
        }

        isLoading = false
    }

    /// Poll the current event epoch. Retry can reuse sequence numbers, so a
    /// seq-only request would miss the new timeline.
    /// - Parameters:
    ///   - taskId: The task ID to poll.
    ///   - apiClient: The API client to use.
    @MainActor
    func pollEvents(taskId: String, with apiClient: APIClient) async {
        do {
            let newEvents = try await apiClient.taskEvents(id: taskId)

            guard !newEvents.isEmpty else { return }

            let incomingEpoch = newEvents.map(\.eventEpoch).max() ?? currentEpoch ?? 0
            if incomingEpoch > (currentEpoch ?? incomingEpoch) {
                events.removeAll { $0.eventEpoch < incomingEpoch }
                currentEpoch = incomingEpoch
            }
            let existingIDs = Set(events.map { "\($0.eventEpoch):\($0.seq)" })
            for event in newEvents {
                if event.eventEpoch < (currentEpoch ?? event.eventEpoch) {
                    continue
                }
                if !existingIDs.contains("\(event.eventEpoch):\(event.seq)") {
                    events.append(event)
                }
            }
            events.sort {
                ($0.eventEpoch, $0.seq) < ($1.eventEpoch, $1.seq)
            }
            currentEpoch = events.last?.eventEpoch

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

    @MainActor
    func continueAfterLimit(taskId: String, with apiClient: APIClient) async {
        error = nil
        do {
            task = try await apiClient.continueTask(id: taskId, action: "continue")
        } catch {
            self.error = error.localizedDescription
        }
    }

    @MainActor
    func fork(taskId: String, prompt: String?, with apiClient: APIClient) async -> KinTask? {
        error = nil
        do {
            return try await apiClient.forkTask(id: taskId, prompt: prompt)
        } catch {
            self.error = error.localizedDescription
            return nil
        }
    }

    @MainActor
    func delete(taskId: String, with apiClient: APIClient) async -> Bool {
        error = nil
        do {
            try await apiClient.deleteTask(id: taskId)
            return true
        } catch {
            self.error = error.localizedDescription
            return false
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
