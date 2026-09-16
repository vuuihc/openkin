import SwiftUI

struct AgentUsageView: View {
    @Environment(AppSession.self) private var appSession
    @State private var agents: [AgentManagement] = []
    @State private var limits: [AgentUsageLimit] = []
    @State private var error: String?

    var body: some View {
        List {
            if let error {
                Text(error).foregroundStyle(.red)
            }

            Section("Agent access") {
                ForEach(agents) { agent in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(agent.id)
                                .font(.headline)
                            Spacer()
                            Text(agent.authStatus.replacingOccurrences(of: "_", with: " ").capitalized)
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

            Section("Usage limits") {
                ForEach(limits) { limit in
                    VStack(alignment: .leading, spacing: 5) {
                        HStack {
                            Text(limit.agent).font(.headline)
                            Spacer()
                            Text(limit.status.uppercased())
                                .font(.caption2)
                                .foregroundStyle(limit.status == "over" ? .red : .secondary)
                        }
                        Text("\(limit.usedTokens) tokens")
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
        .navigationTitle("Agents & Usage")
        .refreshable { await load() }
        .task { await load() }
    }

    private func load() async {
        guard let client = appSession.apiClient else { return }
        do {
            async let fetchedAgents = client.agentManagement()
            async let fetchedLimits = client.usageLimits()
            agents = try await fetchedAgents
            limits = (try? await fetchedLimits) ?? []
        } catch {
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
    @State private var error: String?

    var body: some View {
        Form {
            if let error {
                Text(error).foregroundStyle(.red)
            }

            if let response {
                Section("Configured providers") {
                    ForEach(response.providers) { provider in
                        Button {
                            select(provider)
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(provider.name)
                                        .foregroundStyle(.primary)
                                    Text("\(provider.kind) · \(provider.model)")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                if provider.id == response.activeId {
                                    Image(systemName: "checkmark.circle.fill")
                                        .foregroundStyle(.green)
                                }
                            }
                        }
                    }
                }
            }

            Section("Provider") {
                if appSession.canManageDaemon {
                    TextField("Name", text: $name)
                    TextField("Kind", text: $kind)
                    TextField("Base URL", text: $baseURL)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                    TextField("Model", text: $model)
                    SecureField("API key (leave blank to keep)", text: $apiKey)
                    Button {
                        Task { await save() }
                    } label: {
                        HStack {
                            Spacer()
                            if isSaving { ProgressView() } else { Text("Save Provider") }
                            Spacer()
                        }
                    }
                    .disabled(isSaving || selectedId == nil || name.isEmpty || baseURL.isEmpty || model.isEmpty)

                    if let selectedId, response?.activeId != selectedId {
                        Button {
                            Task { await activate(selectedId) }
                        } label: {
                            Label("Use for new tasks", systemImage: "checkmark.circle")
                        }
                        .disabled(isSaving)
                    }
                } else {
                    Text("Read-only pairing. Scan the Desktop master-token link to edit providers.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("Providers")
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        guard let client = appSession.apiClient else { return }
        do {
            response = try await client.providers()
            if let selectedId, let provider = response?.providers.first(where: { $0.id == selectedId }) {
                select(provider)
            } else if let provider = response?.providers.first(where: { $0.active }) ?? response?.providers.first {
                select(provider)
            }
        } catch {
            self.error = error.localizedDescription
        }
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
        guard let client = appSession.apiClient, let selectedId else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            let updated = try await client.updateProvider(
                id: selectedId,
                body: ProviderWriteBody(
                    name: name, kind: kind, baseURL: baseURL,
                    apiKey: apiKey.isEmpty ? nil : apiKey, model: model,
                    stream: nil, active: nil, clearApiKey: nil
                )
            )
            response = updated
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func activate(_ id: String) async {
        guard let client = appSession.apiClient else { return }
        do {
            response = try await client.activateProvider(id: id)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}
