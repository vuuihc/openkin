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
    private(set) var isSyncing = false
    private(set) var lastSyncedAt: Date?

    @ObservationIgnored private var foregroundSyncTask: Task<Void, Never>?
    @ObservationIgnored private var syncDepth = 0
    private static let foregroundSyncInterval: UInt64 = 25_000_000_000

    init() {
        profiles = UserDefaults.loadServerProfiles()
        activeProfileID = profiles.first?.id
        if let profile = profiles.first {
            activate(profile: profile)
        }
    }

    deinit {
        foregroundSyncTask?.cancel()
    }

    var activeProfile: ServerProfile? {
        profiles.first { $0.id == activeProfileID }
    }

    var canManageDaemon: Bool {
        activeProfile?.canManageDaemon == true
    }

    /// Activates one profile and loads only its Keychain credential.
    func activate(profile: ServerProfile) {
        reconciler?.stopWebSocket()
        clearRemoteSnapshot()
        var profile = profile
        profile.lastAccessed = Date()
        UserDefaults.upsertServerProfile(profile)
        profiles = UserDefaults.loadServerProfiles()
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
            await reconcile(nextReconciler)
            guard self.reconciler === nextReconciler else { return }
            nextReconciler.startWebSocket()
        }
    }

    private func clearRemoteSnapshot() {
        tasks = []
        approvals = []
        questions = []
        lastSyncedAt = nil
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
            clearRemoteSnapshot()
            activeProfileID = profiles.first?.id
            connectionState = .unconfigured
        }
    }

    func reconcileForeground() async {
        guard let reconciler else { return }
        await reconcile(reconciler)
    }

    func startForegroundSync() {
        guard foregroundSyncTask == nil else { return }
        foregroundSyncTask = Task { [weak self] in
            await self?.reconcileForeground()
            while !Task.isCancelled {
                do {
                    try await Task.sleep(nanoseconds: Self.foregroundSyncInterval)
                } catch {
                    break
                }
                await self?.reconcileForeground()
            }
        }
    }

    func stopForegroundSync() {
        foregroundSyncTask?.cancel()
        foregroundSyncTask = nil
    }

    private func reconcile(_ target: Reconciler) async {
        beginSync()
        defer { endSync() }
        await target.reconcile()
        guard self.reconciler === target else { return }
        syncState(from: target)
        if target.connectionState == .connected {
            lastSyncedAt = Date()
        }
    }

    private func beginSync() {
        syncDepth += 1
        isSyncing = true
    }

    private func endSync() {
        syncDepth = max(0, syncDepth - 1)
        isSyncing = syncDepth > 0
    }

    private func syncState(from reconciler: Reconciler) {
        tasks = TaskPresentation.byRecency(reconciler.tasks)
        approvals = reconciler.pendingApprovals
        questions = reconciler.pendingQuestions
        connectionState = reconciler.connectionState
    }

    #if DEBUG
    func installRemoteSnapshotForTesting(tasks: [KinTask], approvals: [Approval], questions: [UserQuestion]) {
        self.tasks = TaskPresentation.byRecency(tasks)
        self.approvals = approvals
        self.questions = questions
    }

    /// The session owns its connection state, so a view that only cares about how
    /// one state renders has to ask for it.
    func installConnectionStateForTesting(_ state: ConnectionState) {
        connectionState = state
    }
    #endif

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
