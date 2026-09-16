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
    private var loadedOnce = false
    private var socketWasConnected = false
    private var reconciliationInFlight = false
    var onConnectionStateChange: ((ConnectionState) -> Void)?
    var onDataChange: (() -> Void)?

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
        guard !reconciliationInFlight else { return }
        reconciliationInFlight = true
        defer { reconciliationInFlight = false }
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
            notifyDataChange()

            // Full snapshots also detect event-epoch changes after a retry.
            let openTasks = fetchedTasks.filter { !$0.isTerminal }
            for task in openTasks {
                await reconcileTaskEvents(taskId: task.id, forceFull: true)
            }
        } catch {
            applyError(error)
        }
    }

    /// Incremental reconciliation for an open task.
    /// Fetches events since the highest known sequence number for the task.
    func reconcileTaskEvents(taskId: String, forceFull: Bool = false) async {
        let current = taskEvents[taskId] ?? []
        let highestSeq = current.map(\.seq).max()
        do {
            let newEvents: [TaskEvent]
            if !forceFull, let since = highestSeq {
                newEvents = try await apiClient.taskEvents(id: taskId, sinceSeq: since)
            } else {
                newEvents = try await apiClient.taskEvents(id: taskId)
            }
            mergeEvents(newEvents, taskId: taskId)
        } catch {
            applyError(error)
        }
    }

    // MARK: - User actions

    func approve(id: String) async throws {
        do {
            try await apiClient.approve(id: id)
            pendingApprovals.removeAll { $0.id == id }
            notifyDataChange()
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
            notifyDataChange()
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
            notifyDataChange()
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
                    startedAt: updated.startedAt,
                    finishedAt: updated.finishedAt,
                    elapsedSeconds: updated.elapsedSeconds,
                    costUSD: updated.costUSD,
                    sessionRef: updated.sessionRef,
                    error: updated.error
                )
                tasks[index] = updated
                notifyDataChange()
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
            notifyDataChange()
            return task
        } catch {
            applyError(error)
            throw error
        }
    }

    // MARK: - WebSocket setup

    private func setupWebSocketCallbacks() {
        Task {
            await wsClient.setCallbacks(
                onMessage: { [weak self] message, generation in
                    guard let self else { return }
                    Task { @MainActor in
                        // WebSocketClient already filters stale generations. Keep
                        // the callback generation in the signature for protocol
                        // compatibility, but do not cache a second generation
                        // counter here; reconnects must continue delivering events.
                        _ = generation
                        self.handleServerMessage(message)
                    }
                },
                onStateChange: { [weak self] state in
                    guard let self else { return }
                    Task { @MainActor in
                        switch state {
                        case .connected:
                            self.connectionState = .connected
                            self.onConnectionStateChange?(.connected)
                            if !self.socketWasConnected {
                                self.socketWasConnected = true
                                if self.loadedOnce {
                                    Task { await self.reconcile() }
                                }
                            }
                        case .disconnected:
                            self.socketWasConnected = false
                            self.connectionState = .offline("Disconnected")
                            self.onConnectionStateChange?(.offline("Disconnected"))
                        case .connecting:
                            self.connectionState = .connecting
                            self.onConnectionStateChange?(.connecting)
                        case .reconnecting(let delay):
                            self.socketWasConnected = false
                            self.connectionState = .reconnecting(delay: delay)
                            self.onConnectionStateChange?(.reconnecting(delay: delay))
                        }
                    }
                }
            )
        }
    }

    func startWebSocket() {
        Task {
            await wsClient.connect()
        }
    }

    func stopWebSocket() {
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
        case .event(let event):
            mergeEvents([event], taskId: event.taskId)
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
        notifyDataChange()
    }

    // MARK: - Helpers

    private func updateOrAppendTask(_ task: KinTask) {
        if let index = tasks.firstIndex(where: { $0.id == task.id }) {
            tasks[index] = task
        } else {
            tasks.append(task)
        }
        tasks.sort { $0.createdAt > $1.createdAt }
        notifyDataChange()
    }

    /// Merge events into the task's event list, de-duplicating by epoch and seq.
    private func mergeEvents(_ incoming: [TaskEvent], taskId: String) {
        var existing = taskEvents[taskId] ?? []
        let incomingEpoch = incoming.map(\.eventEpoch).max()
        if let incomingEpoch, incomingEpoch > (existing.map(\.eventEpoch).max() ?? incomingEpoch) {
            existing.removeAll { $0.eventEpoch < incomingEpoch }
        }
        let activeEpoch = existing.map(\.eventEpoch).max()
        let existingIDs = Set(existing.map { "\($0.eventEpoch):\($0.seq)" })
        for event in incoming {
            if let activeEpoch, event.eventEpoch < activeEpoch {
                continue
            }
            if !existingIDs.contains("\(event.eventEpoch):\(event.seq)") {
                existing.append(event)
            }
        }
        existing.sort {
            ($0.eventEpoch, $0.seq) < ($1.eventEpoch, $1.seq)
        }
        taskEvents[taskId] = existing
        notifyDataChange()
    }

    private func notifyDataChange() {
        onDataChange?()
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
        onConnectionStateChange?(connectionState)
    }
}
