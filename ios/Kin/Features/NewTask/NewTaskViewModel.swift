import Foundation
import Observation

@MainActor
@Observable
final class NewTaskViewModel {
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

    private let apiClient: APIClient?

    init(apiClient: APIClient? = nil) {
        if let apiClient {
            self.apiClient = apiClient
        } else {
            self.apiClient = Self.makeAPIClientFromStorage()
        }
    }

    /// The list of models the selected agent advertises, if any.
    var selectedAgentModels: [String]? {
        selectedAgent?.models
    }

    /// Effective working directory: the picked recent CWD, or the custom path.
    var effectiveCWD: String {
        let path = selectedCWD ?? customCWD
        return path.trimmingCharacters(in: .whitespaces)
    }

    /// Fetch agents and recent working directories from the daemon.
    func load() async {
        guard let apiClient else {
            error = String(localized: "api.error.unauthorized")
            return
        }

        do {
            async let fetchedAgents = apiClient.agents()
            async let fetchedCwds = apiClient.recentCwds()
            let (agents, cwds) = try await (fetchedAgents, fetchedCwds)

            await MainActor.run {
                self.agents = agents
                self.recentCwds = cwds
                self.selectedAgent = agents.first
                if let first = agents.first {
                    if let models = first.models, let defaultModel = first.defaultModel {
                        self.selectedModel = defaultModel
                    } else {
                        self.selectedModel = first.model
                    }
                }
                self.error = nil
            }
        } catch {
            await MainActor.run {
                self.error = error.localizedDescription
            }
        }
    }

    /// Submit the task to the daemon.
    /// - Returns: The created task, or `nil` on failure.
    func submit() async -> KinTask? {
        guard let apiClient else {
            await MainActor.run { self.error = String(localized: "api.error.unauthorized") }
            return nil
        }

        isSubmitting = true
        defer { isSubmitting = false }

        let agentID = selectedAgent?.id ?? ""
        let cwd = effectiveCWD
        let model: String?
        if selectedAgentModels != nil {
            model = selectedModel
        } else {
            model = nil
        }
        let permMode: String? = permissionMode == "default" ? nil : permissionMode

        do {
            let task = try await apiClient.createTask(
                prompt: prompt.trimmingCharacters(in: .whitespacesAndNewlines),
                agent: agentID,
                model: model,
                cwd: cwd,
                permissionMode: permMode,
                workspaceMode: nil
            )
            await MainActor.run {
                self.createdTask = task
                self.error = nil
            }
            return task
        } catch {
            await MainActor.run {
                self.error = error.localizedDescription
            }
            return nil
        }
    }

    // MARK: - Private helpers

    private static func makeAPIClientFromStorage() -> APIClient? {
        guard let profile = UserDefaults.loadServerProfile(),
              let token = try? KeychainStore.readToken() else {
            return nil
        }
        return APIClient(baseURL: profile.baseURL, token: token)
    }
}