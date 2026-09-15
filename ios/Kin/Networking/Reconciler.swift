import Foundation

/// Owns the authoritative app state by merging HTTP snapshots with WebSocket live events.
///
/// Rules from the architecture plan:
/// - initial connection: fetch HTTP snapshots
/// - WebSocket messages update visible state optimistically
/// - every reconnect and app foreground transition re-fetches tasks, pending approvals, pending questions
/// - an open task fetches events via `since_seq`
/// - unknown message kinds are ignored safely
/// - events are keyed by (task_id, seq) and merged idempotently
@MainActor
final class Reconciler {
    // MARK: - Published state

    @Published private(set) var tasks: [KinTask] = []
    @Published private(set) var taskEvents: [String: [TaskEvent]] = [:]  // taskID -> events
    @Published private(set) var pendingApprovals: [Approval] = []
    @Published private(set) var pendingQuestions: [UserQuestion] = []
    @Published private(set) var connectionState: ConnectionState = .unconfigured

    private let apiClient: APIClient
    private let wsClient: WebSocketClient
    private var wsGeneration: UInt64 = 0
    private var loadedOnce = false

    init(apiClient: APIClient, wsClient: WebSocketClient) {
        self.apiClient = apiClient
        self.wsClient = wsClient
        setupWebSocketCallbacks()
    }

    // MARK: - Public API

    /// Full reconciliation — called on connect and foreground.
    /// Fetches tasks, approvals, and questions in parallel, then updates published state.
    /// After initial load, also fetches events for any open (non-terminal) tasks.
    func reconcile() async {
        connectionState = .connecting
        do {
            async let tasksResult = apiClient.tasks()
            async let approvalsResult = apiClient.approvals()
            async let questionsResult = apiClient.userQuestions()

            let (fetchedTasks, fetchedApprovals, fetchedQuestions) = try await (
                tasksResult,
                approvalsResult,
                questionsResult
            )

            tasks = fetchedTasks.sorted { $0.createdAt > $1.createdAt }
            pendingApprovals = fetchedApprovals.sorted { $0.createdAt > $1.createdAt }
            pendingQuestions = fetchedQuestions // server order preserved
            connectionState = .connected
            loadedOnce = true

            // For any open task, fetch events since the highest seq number
            let openTasks = fetchedTasks.filter { !$0.isTerminal }
            for task in openTasks {
                await reconcileTaskEvents(taskId: task.id)
            }
        } catch {
            applyError(error)
        }
    }

    /// Incremental reconciliation for an open task.
    /// Fetches events since the highest known sequence number for the task.
    func reconcileTaskEvents(taskId: String) async {
        let current = taskEvents[taskId] ?? []
        let highestSeq = current.map(\.seq).max()
        do {
            let newEvents: [TaskEvent]
            if let since = highestSeq {
                newEvents = try await apiClient.taskEvents(id: taskId, sinceSeq: since)
            } else {
                newEvents = try await apiClient.taskEvents(id: taskId)
            }
            mergeEvents(newEvents, taskId: taskId)
        } catch {
            // Silently fail for incremental event fetches — the next reconcile will retry
        }
    }

    // MARK: - User actions

    func approve(id: String) async throws {
        do {
            try await apiClient.approve(id: id)
            pendingApprovals.removeAll { $0.id == id }
        } catch APIError.conflict {
            // Another client already handled it; refresh
            await reconcile()
        } catch {
            applyError(error)
            throw error
        }
    }

    func deny(id: String) async throws {
        do {
            try await apiClient.deny(id: id)
            pendingApprovals.removeAll { $0.id == id }
        } catch APIError.conflict {
            await reconcile()
        } catch {
            applyError(error)
            throw error
        }
    }

    func answerQuestion(id: String, selected: [String]?, otherText: String?) async throws {
        do {
            try await apiClient.answerQuestion(id: id, selected: selected, otherText: otherText)
            pendingQuestions.removeAll { $0.id == id }
        } catch APIError.conflict {
            await reconcile()
        } catch {
            applyError(error)
            throw error
        }
    }

    func cancelTask(id: String) async throws {
        do {
            try await apiClient.cancelTask(id: id)
            // The WebSocket will deliver the updated task, but we optimistically
            // update state here for immediate feedback.
            if let index = tasks.firstIndex(where: { $0.id == id }) {
                var updated = tasks[index]
                updated = KinTask(
                    id: updated.id,
                    status: .cancelled,
                    agent: updated.agent,
                    model: updated.model,
                    cwd: updated.cwd,
                    prompt: updated.prompt,
                    permissionMode: updated.permissionMode,
                    workspaceMode: updated.workspaceMode,
                    approvalIds: updated.approvalIds,
                    questionIds: updated.questionIds,
                    createdAt: updated.createdAt,
                    updatedAt: updated.updatedAt,
                    elapsedSeconds: updated.elapsedSeconds,
                    costCents: updated.costCents,
                    sessionId: updated.sessionId,
                    error: updated.error
                )
                tasks[index] = updated
            }
        } catch {
            applyError(error)
            throw error
        }
    }

    func promptTask(id: String, message: String) async throws {
        do {
            try await apiClient.promptTask(id: id, message: message)
        } catch {
            applyError(error)
            throw error
        }
    }

    func retryTask(id: String) async throws -> KinTask {
        do {
            let task = try await apiClient.retryTask(id: id)
            updateOrAppendTask(task)
            return task
        } catch {
            applyError(error)
            throw error
        }
    }

    func createTask(
        prompt: String,
        agent: String,
        model: String?,
        cwd: String,
        permissionMode: String?,
        workspaceMode: String?
    ) async throws -> KinTask {
        do {
            let task = try await apiClient.createTask(
                prompt: prompt,
                agent: agent,
                model: model,
                cwd: cwd,
                permissionMode: permissionMode,
                workspaceMode: workspaceMode
            )
            tasks.insert(task, at: 0)
            tasks.sort { $0.createdAt > $1.createdAt }
            return task
        } catch {
            applyError(error)
            throw error
        }
    }

    // MARK: - WebSocket setup

    private func setupWebSocketCallbacks() {
        let currentGen = wsGeneration
        Task {
            await wsClient.setCallbacks(
                onMessage: { [weak self] message, generation in
                    guard let self else { return }
                    guard generation == currentGen else { return }
                    Task { @MainActor in
                        self.handleServerMessage(message)
                    }
                },
                onStateChange: { [weak self] state in
                    guard let self else { return }
                    Task { @MainActor in
                        switch state {
                        case .connected:
                            self.connectionState = .connected
                        case .disconnected:
                            self.connectionState = .offline("Disconnected")
                        case .connecting:
                            self.connectionState = .connecting
                        case .reconnecting(let delay):
                            self.connectionState = .reconnecting(delay: delay)
                        }
                    }
                }
            )
        }
    }

    func startWebSocket() {
        Task {
            let gen = await wsClient.currentGeneration
            wsGeneration = gen &+ 1
            await wsClient.connect()
        }
    }

    func stopWebSocket() {
        wsGeneration &+= 1
        Task { await wsClient.disconnect() }
    }

    // MARK: - Server message handling

    private func handleServerMessage(_ message: ServerMessage) {
        switch message {
        case .taskUpdate(let task):
            updateOrAppendTask(task)
        case .taskDeleted(let id):
            tasks.removeAll { $0.id == id }
            taskEvents[id] = nil
        case .event(let taskId, let event):
            mergeEvents([event], taskId: taskId)
        case .approvalUpdate(let approval):
            pendingApprovals.removeAll { $0.id == approval.id }
            if approval.status == .pending {
                pendingApprovals.append(approval)
                pendingApprovals.sort { $0.createdAt > $1.createdAt }
            }
        case .userQuestionUpdate(let question):
            pendingQuestions.removeAll { $0.id == question.id }
            if question.answeredAt == nil {
                pendingQuestions.append(question)
            }
        case .unknown:
            break
        }
    }

    // MARK: - Helpers

    private func updateOrAppendTask(_ task: KinTask) {
        if let index = tasks.firstIndex(where: { $0.id == task.id }) {
            tasks[index] = task
        } else {
            tasks.append(task)
        }
        tasks.sort { $0.createdAt > $1.createdAt }
    }

    /// Merge events into the task's event list, de-duplicating by seq number.
    private func mergeEvents(_ incoming: [TaskEvent], taskId: String) {
        var existing = taskEvents[taskId] ?? []
        let existingSeqs = Set(existing.map(\.seq))
        for event in incoming {
            if !existingSeqs.contains(event.seq) {
                existing.append(event)
            }
        }
        existing.sort { $0.seq < $1.seq }
        taskEvents[taskId] = existing
    }

    private func applyError(_ error: Error) {
        switch error {
        case APIError.unauthorized:
            connectionState = .unauthorized
        case APIError.incompatible:
            connectionState = .incompatible
        case APIError.offline:
            connectionState = .offline("Cannot reach the daemon")
        default:
            connectionState = .offline(error.localizedDescription)
        }
    }
}