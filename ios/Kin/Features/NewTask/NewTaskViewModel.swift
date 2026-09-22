import Foundation
import Observation

@MainActor
@Observable
final class NewTaskViewModel {
    struct Draft: Equatable {
        let prompt: String
        let agent: String
        let model: String?
        let cwd: String
        let permissionMode: String?
        let workspaceMode: String?
    }

    var agents: [Agent] = []
    var recentCwds: [String] = []
    var selectedAgent: Agent?
    var selectedModel: String?
    var selectedCWD: String?
    var customCWD = ""
    var prompt = ""
    var permissionMode = "default"
    var isSubmitting = false
    var showUnrestrictedAlert = false
    var confirmedUnrestricted = false
    var error: String?
    var createdTask: KinTask?
    private(set) var boundProfileID: UUID?
    private(set) var hasClient = false

    @ObservationIgnored private var loadConfiguration: (() async throws -> ([Agent], [String]))?
    @ObservationIgnored private var createTaskAction: ((Draft) async throws -> KinTask)?
    private var contextGeneration = 0

    init(apiClient: APIClient? = nil, profileID: UUID? = nil) {
        configure(apiClient: apiClient, profileID: profileID)
    }

    func configure(apiClient: APIClient?, profileID: UUID?) {
        if boundProfileID != profileID {
            contextGeneration += 1
            resetRemoteConfiguration()
        }
        self.boundProfileID = profileID

        guard let apiClient else {
            hasClient = false
            loadConfiguration = nil
            createTaskAction = nil
            return
        }

        hasClient = true
        loadConfiguration = {
            async let fetchedAgents = apiClient.agents()
            async let fetchedCwds = apiClient.recentCwds()
            return try await (fetchedAgents, fetchedCwds)
        }
        createTaskAction = { draft in
            try await apiClient.createTask(
                prompt: draft.prompt,
                agent: draft.agent,
                model: draft.model,
                cwd: draft.cwd,
                permissionMode: draft.permissionMode,
                workspaceMode: draft.workspaceMode
            )
        }
    }

    func configure(
        loadConfiguration: (() async throws -> ([Agent], [String]))?,
        createTask: @escaping (Draft) async throws -> KinTask,
        profileID: UUID?
    ) {
        if boundProfileID != profileID {
            contextGeneration += 1
            resetRemoteConfiguration()
        }
        self.boundProfileID = profileID
        hasClient = true
        self.loadConfiguration = loadConfiguration
        self.createTaskAction = createTask
    }

    func invalidateActiveProfileChange() {
        contextGeneration += 1
        hasClient = false
        loadConfiguration = nil
        createTaskAction = nil
        resetRemoteConfiguration()
    }

    /// The list of models the selected agent advertises, if any.
    var selectedAgentModels: [String]? {
        selectedAgent?.models
    }

    /// Effective working directory: the picked recent CWD, or the custom path.
    var effectiveCWD: String {
        let path = selectedCWD ?? customCWD
        return path.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func selectAgent(_ agent: Agent?) {
        selectedAgent = agent
        selectedModel = agent?.model
    }

    func isCurrentProfileContext(activeProfileID: UUID?) -> Bool {
        guard let boundProfileID, let activeProfileID else { return false }
        return boundProfileID == activeProfileID
    }

    func canSubmit(activeProfileID: UUID?) -> Bool {
        !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !isSubmitting
            && hasClient
            && isCurrentProfileContext(activeProfileID: activeProfileID)
    }

    func taskDraft() -> Draft {
        let model: String?
        if selectedAgentModels != nil {
            model = selectedModel
        } else {
            model = nil
        }

        return Draft(
            prompt: prompt.trimmingCharacters(in: .whitespacesAndNewlines),
            agent: selectedAgent?.id ?? "",
            model: model,
            cwd: effectiveCWD,
            permissionMode: permissionMode == "default" ? nil : permissionMode,
            workspaceMode: nil
        )
    }

    /// Fetch agents and recent working directories from the daemon.
    func load() async {
        guard let loadConfiguration else {
            error = String(localized: "api.error.unauthorized")
            return
        }
        let loadingProfileID = boundProfileID
        let loadingGeneration = contextGeneration

        do {
            let (agents, cwds) = try await loadConfiguration()

            guard loadingProfileID == boundProfileID, loadingGeneration == contextGeneration else { return }
            self.agents = agents
            self.recentCwds = cwds
            self.selectAgent(agents.first)
            self.error = nil
        } catch {
            guard !Task.isCancelled else { return }
            guard loadingProfileID == boundProfileID, loadingGeneration == contextGeneration else { return }
            self.error = error.localizedDescription
        }
    }

    /// Submit the task to the daemon.
    /// - Returns: The created task, or `nil` on failure.
    func submit(activeProfileID: UUID?) async -> KinTask? {
        guard isCurrentProfileContext(activeProfileID: activeProfileID) else {
            error = String(localized: "task.new.stale.error")
            return nil
        }
        guard !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        guard let createTaskAction else {
            error = String(localized: "api.error.unauthorized")
            return nil
        }
        let submittingProfileID = boundProfileID
        let submittingGeneration = contextGeneration

        isSubmitting = true
        defer { isSubmitting = false }
        let draft = taskDraft()

        do {
            let task = try await createTaskAction(draft)
            guard !Task.isCancelled,
                  submittingProfileID == boundProfileID,
                  submittingGeneration == contextGeneration
            else {
                return nil
            }
            self.createdTask = task
            self.error = nil
            return task
        } catch is CancellationError {
            return nil
        } catch {
            self.error = error.localizedDescription
            return nil
        }
    }

    // MARK: - Private helpers

    private func resetRemoteConfiguration() {
        agents = []
        recentCwds = []
        selectedAgent = nil
        selectedModel = nil
        selectedCWD = nil
        error = nil
    }
}
