import Foundation
import Observation

/// Composition root for one authenticated daemon profile and its live state.
@MainActor
@Observable
final class AppSession {
    private(set) var profiles: [ServerProfile] = []
    private(set) var activeProfileID: UUID?
    private(set) var apiClient: APIClient?
    private(set) var reconciler: Reconciler?
    private(set) var connectionState: ConnectionState = .unconfigured
    private(set) var tasks: [KinTask] = []
    private(set) var approvals: [Approval] = []
    private(set) var questions: [UserQuestion] = []

    init() {
        profiles = UserDefaults.loadServerProfiles()
        activeProfileID = profiles.first?.id
        if let profile = profiles.first {
            activate(profile: profile)
        }
    }

    var activeProfile: ServerProfile? {
        profiles.first { $0.id == activeProfileID }
    }

    /// Activates one profile and loads only its Keychain credential.
    func activate(profile: ServerProfile) {
        reconciler?.stopWebSocket()
        let profileToken = try? KeychainStore.readToken(for: profile.id)
        let legacyToken = profileToken == nil ? (try? KeychainStore.readToken()) : nil
        guard let token = profileToken ?? legacyToken, !token.isEmpty else {
            apiClient = nil
            reconciler = nil
            tasks = []
            approvals = []
            questions = []
            activeProfileID = profile.id
            connectionState = .unconfigured
            return
        }
        if profileToken == nil, legacyToken != nil {
            do {
                try KeychainStore.store(token: token, for: profile.id)
                try KeychainStore.deleteToken()
            } catch {
                // Keep using the legacy credential for this session; a later
                // activation can retry the migration.
            }
        }
        let client = APIClient(
            baseURL: profile.baseURL, token: token,
            relayKey: profile.relayKey, relayRoom: profile.relayRoom
        )
        let socket = WebSocketClient(
            baseURL: profile.baseURL, token: token,
            relayKey: profile.relayKey, relayRoom: profile.relayRoom
        )
        apiClient = client
        let nextReconciler = Reconciler(apiClient: client, wsClient: socket)
        nextReconciler.onConnectionStateChange = { [weak self, weak nextReconciler] state in
            guard let self, self.reconciler === nextReconciler else { return }
            self.connectionState = state
        }
        nextReconciler.onDataChange = { [weak self, weak nextReconciler] in
            guard let self, let nextReconciler, self.reconciler === nextReconciler else { return }
            self.syncState(from: nextReconciler)
        }
        reconciler = nextReconciler
        activeProfileID = profile.id
        connectionState = .connecting
        Task {
            await nextReconciler.reconcile()
            guard self.reconciler === nextReconciler else { return }
            syncState(from: nextReconciler)
            nextReconciler.startWebSocket()
        }
    }

    func refreshProfiles() {
        profiles = UserDefaults.loadServerProfiles()
        if activeProfileID == nil {
            activeProfileID = profiles.first?.id
        }
    }

    func delete(profile: ServerProfile) {
        try? KeychainStore.deleteToken(for: profile.id)
        UserDefaults.deleteServerProfile(id: profile.id)
        refreshProfiles()
        if activeProfileID == profile.id {
            reconciler?.stopWebSocket()
            apiClient = nil
            reconciler = nil
            tasks = []
            approvals = []
            questions = []
            activeProfileID = profiles.first?.id
            connectionState = .unconfigured
        }
    }

    func reconcileForeground() async {
        await reconciler?.reconcile()
        if let reconciler, self.reconciler === reconciler {
            syncState(from: reconciler)
        }
    }

    private func syncState(from reconciler: Reconciler) {
        tasks = reconciler.tasks
        approvals = reconciler.pendingApprovals
        questions = reconciler.pendingQuestions
        connectionState = reconciler.connectionState
    }

    func approve(id: String) async throws {
        try await reconciler?.approve(id: id)
    }

    func deny(id: String) async throws {
        try await reconciler?.deny(id: id)
    }

    func answerQuestion(id: String, selected: [String]?, otherText: String?) async throws {
        try await reconciler?.answerQuestion(id: id, selected: selected, otherText: otherText)
    }
}
