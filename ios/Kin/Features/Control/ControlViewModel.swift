import Foundation
import Observation

@Observable
final class ControlViewModel {
    var connectionState: ConnectionState = .unconfigured
    var approvals: [Approval] = []
    var questions: [UserQuestion] = []
    var activeTasks: [KinTask] = []
    var isLoading = false
    var error: String?

    /// Track which approval IDs are currently submitting to disable buttons.
    var approvingIds: Set<String> = []
    /// Track which question IDs are currently submitting to disable buttons.
    var answeringIds: Set<String> = []

    private var apiClient: APIClient?

    /// Configure the view model with an active API client (e.g. after successful pairing).
    func configure(apiClient: APIClient) {
        self.apiClient = apiClient
        connectionState = .connected
        error = nil
    }

    /// Mark the view model as unconfigured (e.g. on disconnect/logout).
    func reset() {
        apiClient = nil
        connectionState = .unconfigured
        approvals = []
        questions = []
        activeTasks = []
        isLoading = false
        error = nil
        approvingIds = []
        answeringIds = []
    }

    /// Fetch approvals, questions, and active tasks from the daemon.
    @MainActor
    func load() async {
        guard let client = apiClient else { return }

        isLoading = true
        error = nil

        do {
            async let approvalsTask = client.approvals()
            async let questionsTask = client.userQuestions()
            async let tasksTask = client.tasks()

            let (fetchedApprovals, fetchedQuestions, fetchedTasks) = try await (
                approvalsTask,
                questionsTask,
                tasksTask
            )

            approvals = fetchedApprovals
                .filter { $0.status == .pending }
                .sorted { $0.createdAt > $1.createdAt }
            questions = fetchedQuestions
                .filter { $0.answeredAt == nil }
            activeTasks = fetchedTasks
                .filter { !$0.isTerminal }
                .sorted { $0.createdAt > $1.createdAt }

            connectionState = .connected
        } catch {
            applyError(error)
        }

        isLoading = false
    }

    /// Approve a pending approval request.
    @MainActor
    func approve(id: String) async {
        guard let client = apiClient, !approvingIds.contains(id) else { return }
        approvingIds.insert(id)
        error = nil

        do {
            try await client.approve(id: id)
            approvals.removeAll { $0.id == id }
        } catch {
            applyError(error)
        }

        approvingIds.remove(id)
    }

    /// Deny a pending approval request.
    @MainActor
    func deny(id: String) async {
        guard let client = apiClient, !approvingIds.contains(id) else { return }
        approvingIds.insert(id)
        error = nil

        do {
            try await client.deny(id: id)
            approvals.removeAll { $0.id == id }
        } catch {
            applyError(error)
        }

        approvingIds.remove(id)
    }

    /// Answer a pending user question.
    @MainActor
    func answer(id: String, selected: [String]? = nil, otherText: String? = nil) async {
        guard let client = apiClient, !answeringIds.contains(id) else { return }
        answeringIds.insert(id)
        error = nil

        do {
            try await client.answerQuestion(id: id, selected: selected, otherText: otherText)
            questions.removeAll { $0.id == id }
        } catch {
            applyError(error)
        }

        answeringIds.remove(id)
    }

    // MARK: - Helpers

    private func applyError(_ error: Error) {
        switch error {
        case let apiErr as APIError:
            switch apiErr {
            case .unauthorized:
                connectionState = .unauthorized
                self.error = "Unauthorized. Please reconnect."
            case .offline:
                connectionState = .offline("Cannot reach the daemon")
                self.error = "Cannot reach the daemon."
            default:
                self.error = apiErr.localizedDescription
            }
        case let urlErr as URLError:
            connectionState = .offline(urlErr.localizedDescription)
            self.error = urlErr.localizedDescription
        default:
            self.error = error.localizedDescription
        }
    }
}