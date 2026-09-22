import SwiftUI

struct AgentUsageView: View {
    @Environment(AppSession.self) private var appSession
    @State private var agents: [AgentManagement] = []
    @State private var limits: [AgentUsageLimit] = []
    @State private var isLoading = false
    @State private var loadedProfileID: UUID?
    @State private var error: String?

    var body: some View {
        List {
            OperationsScopeSection(profile: appSession.activeProfile, connectionState: appSession.connectionState)

            Section(String(localized: "operations.agents.access")) {
                if isLoading {
                    ProgressView()
                } else if agents.isEmpty && error == nil {
                    ContentUnavailableView(
                        String(localized: "operations.agents.empty.title"),
                        systemImage: "person.crop.circle.badge.questionmark",
                        description: Text(String(localized: "operations.agents.empty.message"))
                    )
                } else {
                    ForEach(agents) { agent in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(agent.id)
                                    .font(.headline)
                                Spacer()
                                Text(OperationsPresentation.agentAuthStatusLabel(agent.authStatus))
                                    .font(.caption)
                                    .foregroundStyle(agent.authStatus == "signed_in" ? .green : .secondary)
                            }
                            if let detail = agent.authDetail, !detail.isEmpty {
                                Text(detail).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .padding(.vertical, 3)
                    }
                }
            }

            Section(String(localized: "operations.usage.limits")) {
                if limits.isEmpty && !isLoading && error == nil {
                    Text(String(localized: "operations.usage.empty"))
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(limits) { limit in
                        VStack(alignment: .leading, spacing: 5) {
                            HStack {
                                Text(limit.agent).font(.headline)
                                Spacer()
                                Text(OperationsPresentation.usageStatusLabel(limit.status))
                                    .font(.caption2)
                                    .foregroundStyle(limit.status == "over" ? .red : .secondary)
                            }
                            Text(
                                String(
                                    format: String(localized: "operations.usage.tokens_format"),
                                    limit.usedTokens
                                )
                            )
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            if let spend = limit.limitSpendUSD {
                                Text(String(format: "$%.2f / $%.2f", limit.usedSpendUSD, spend))
                                    .font(.caption)
                                    .foregroundStyle(.tertiary)
                            }
                        }
                        .padding(.vertical, 3)
                    }
                }
            }

            if let error {
                Section {
                    Text(error).foregroundStyle(.red)
                }
            }
        }
        .navigationTitle(String(localized: "settings.agents_usage"))
        .refreshable { await load() }
        .task(id: appSession.activeProfileID) { await load() }
    }

    private func load() async {
        guard let requestedProfileID = appSession.activeProfileID, let client = appSession.apiClient else {
            agents = []
            limits = []
            loadedProfileID = appSession.activeProfileID
            isLoading = false
            error = nil
            return
        }
        if loadedProfileID != requestedProfileID {
            agents = []
            limits = []
        }
        isLoading = true
        do {
            async let fetchedAgents = client.agentManagement()
            async let fetchedLimits = client.usageLimits()
            let nextAgents = try await fetchedAgents
            let nextLimits = (try? await fetchedLimits) ?? []
            guard appSession.activeProfileID == requestedProfileID else { return }
            agents = nextAgents
            limits = nextLimits
            loadedProfileID = requestedProfileID
            isLoading = false
            error = nil
        } catch {
            guard appSession.activeProfileID == requestedProfileID else { return }
            agents = []
            limits = []
            loadedProfileID = requestedProfileID
            isLoading = false
            self.error = error.localizedDescription
        }
    }
}

struct ProviderSettingsView: View {
    @Environment(AppSession.self) private var appSession
    @State private var response: ProvidersResponse?
    @State private var selectedId: String?
    @State private var name = ""
    @State private var kind = "openai"
    @State private var baseURL = ""
    @State private var model = ""
    @State private var apiKey = ""
    @State private var isSaving = false
    @State private var isLoading = false
    @State private var loadedProfileID: UUID?
    @State private var error: String?

    var body: some View {
        Form {
            OperationsScopeSection(profile: appSession.activeProfile, connectionState: appSession.connectionState)

            if let response {
                Section {
                    if response.providers.isEmpty {
                        ContentUnavailableView(
                            String(localized: "providers.empty.title"),
                            systemImage: "server.rack",
                            description: Text(String(localized: "providers.empty.message"))
                        )
                    } else {
                        ForEach(response.providers) { provider in
                            Button {
                                select(provider)
                            } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(provider.name)
                                            .foregroundStyle(.primary)
                                        Text("\(OperationsPresentation.providerKindLabel(provider.kind)) · \(provider.model)")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    if provider.id == response.activeId {
                                        Image(systemName: "checkmark.circle.fill")
                                            .foregroundStyle(.green)
                                            .accessibilityLabel(String(localized: "providers.active"))
                                    }
                                }
                            }
                            .disabled(!canMutateLoadedProfile)
                        }
                    }
                } header: {
                    Text(String(localized: "providers.configured"))
                } footer: {
                    Text(String(localized: "providers.registry.footer"))
                }
            } else if isLoading {
                Section {
                    ProgressView()
                }
            } else if error == nil {
                Section {
                    ContentUnavailableView(
                        String(localized: "providers.unavailable.title"),
                        systemImage: "desktopcomputer.slash",
                        description: Text(String(localized: "providers.unavailable.message"))
                    )
                }
            }

            Section {
                if appSession.canManageDaemon {
                    TextField(String(localized: "providers.name"), text: $name)
                    TextField(String(localized: "providers.kind"), text: $kind)
                    TextField(String(localized: "providers.base_url"), text: $baseURL)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                    TextField(String(localized: "providers.model"), text: $model)
                    SecureField(String(localized: "providers.api_key.placeholder"), text: $apiKey)
                    Button {
                        Task { await save() }
                    } label: {
                        HStack {
                            Spacer()
                            if isSaving {
                                ProgressView()
                            } else {
                                Text(String(localized: "providers.save"))
                            }
                            Spacer()
                        }
                    }
                    .disabled(!OperationsPresentation.canSaveProvider(
                        loadedProfileID: loadedProfileID,
                        activeProfileID: appSession.activeProfileID,
                        canManageDaemon: appSession.canManageDaemon,
                        isSaving: isSaving,
                        selectedID: selectedId,
                        name: name,
                        baseURL: baseURL,
                        model: model
                    ))

                    if let selectedId, response?.activeId != selectedId {
                        Button {
                            Task { await activate(selectedId) }
                        } label: {
                            Label(String(localized: "providers.use_for_new_tasks"), systemImage: "checkmark.circle")
                        }
                        .disabled(isSaving || !canMutateLoadedProfile)
                    }
                } else {
                    Text(String(localized: "providers.read_only.message"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } header: {
                Text(String(localized: "providers.provider"))
            } footer: {
                Text(String(localized: "providers.secret.footer"))
            }

            if let error {
                Section {
                    Text(error).foregroundStyle(.red)
                }
            }
        }
        .navigationTitle(String(localized: "settings.providers"))
        .task(id: appSession.activeProfileID) { await load() }
        .refreshable { await load() }
    }

    private var canMutateLoadedProfile: Bool {
        OperationsPresentation.canMutateLoadedProfile(
            loadedProfileID: loadedProfileID,
            activeProfileID: appSession.activeProfileID,
            canManageDaemon: appSession.canManageDaemon
        )
    }

    private func load() async {
        guard let requestedProfileID = appSession.activeProfileID, let client = appSession.apiClient else {
            response = nil
            clearSelection()
            loadedProfileID = appSession.activeProfileID
            isLoading = false
            error = nil
            return
        }
        if loadedProfileID != requestedProfileID {
            response = nil
            clearSelection()
        }
        isLoading = true
        do {
            let nextResponse = try await client.providers()
            guard appSession.activeProfileID == requestedProfileID else { return }
            response = nextResponse
            loadedProfileID = requestedProfileID
            if let selectedId, let provider = response?.providers.first(where: { $0.id == selectedId }) {
                select(provider)
            } else if let provider = response?.providers.first(where: { $0.active }) ?? response?.providers.first {
                select(provider)
            } else {
                clearSelection()
            }
            isLoading = false
            error = nil
        } catch {
            guard appSession.activeProfileID == requestedProfileID else { return }
            response = nil
            clearSelection()
            loadedProfileID = requestedProfileID
            isLoading = false
            self.error = error.localizedDescription
        }
    }

    private func clearSelection() {
        selectedId = nil
        name = ""
        kind = "openai"
        baseURL = ""
        model = ""
        apiKey = ""
    }

    private func select(_ provider: ProviderEntry) {
        selectedId = provider.id
        name = provider.name
        kind = provider.kind
        baseURL = provider.baseURL
        model = provider.model
        apiKey = ""
    }

    private func save() async {
        guard let requestedProfileID = appSession.activeProfileID,
              loadedProfileID == requestedProfileID,
              let client = appSession.apiClient,
              let selectedId,
              response?.providers.contains(where: { $0.id == selectedId }) == true,
              appSession.canManageDaemon else { return }
        let trimmedAPIKey = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        isSaving = true
        defer { isSaving = false }
        do {
            let updated = try await client.updateProvider(
                id: selectedId,
                body: ProviderWriteBody(
                    name: name.trimmingCharacters(in: .whitespacesAndNewlines),
                    kind: kind.trimmingCharacters(in: .whitespacesAndNewlines),
                    baseURL: baseURL.trimmingCharacters(in: .whitespacesAndNewlines),
                    apiKey: trimmedAPIKey.isEmpty ? nil : trimmedAPIKey,
                    model: model.trimmingCharacters(in: .whitespacesAndNewlines),
                    stream: nil, active: nil, clearApiKey: nil
                )
            )
            guard appSession.activeProfileID == requestedProfileID else { return }
            response = updated
            error = nil
        } catch {
            guard appSession.activeProfileID == requestedProfileID else { return }
            self.error = error.localizedDescription
        }
    }

    private func activate(_ id: String) async {
        guard let requestedProfileID = appSession.activeProfileID,
              loadedProfileID == requestedProfileID,
              let client = appSession.apiClient,
              response?.providers.contains(where: { $0.id == id }) == true,
              appSession.canManageDaemon else { return }
        do {
            let updated = try await client.activateProvider(id: id)
            guard appSession.activeProfileID == requestedProfileID else { return }
            response = updated
            error = nil
        } catch {
            guard appSession.activeProfileID == requestedProfileID else { return }
            self.error = error.localizedDescription
        }
    }
}

struct OperationsScopeSection: View {
    let profile: ServerProfile?
    let connectionState: ConnectionState

    var body: some View {
        Section {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "desktopcomputer")
                    .foregroundStyle(statusColor)
                    .frame(width: 28)

                VStack(alignment: .leading, spacing: 4) {
                    Text(profile?.activeDesktopName ?? String(localized: "control.no_desktop"))
                        .font(.body.weight(.semibold))
                    Text(scopeText)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer()

                Text(statusText)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(statusColor)
            }
            .padding(.vertical, 4)
        }
    }

    private var scopeText: String {
        guard let profile else {
            return String(localized: "settings.remote.scope.unconfigured")
        }
        return String(
            format: String(localized: "settings.remote.scope_format"),
            profile.activeDesktopName
        )
    }

    private var statusText: String {
        switch connectionState {
        case .unconfigured:
            return String(localized: "connection.state.unconfigured")
        case .connecting:
            return String(localized: "connection.state.connecting")
        case .connected:
            return String(localized: "connection.state.connected")
        case .reconnecting:
            return String(localized: "connection.state.reconnecting")
        case .unauthorized:
            return String(localized: "connection.state.unauthorized")
        case .incompatible:
            return String(localized: "connection.state.incompatible")
        case .offline(let message):
            return message.isEmpty ? String(localized: "connection.state.offline") : message
        }
    }

    private var statusColor: Color {
        switch connectionState {
        case .connected:
            return .green
        case .connecting, .reconnecting:
            return .orange
        case .unconfigured:
            return .secondary
        case .offline, .unauthorized, .incompatible:
            return .red
        }
    }
}
