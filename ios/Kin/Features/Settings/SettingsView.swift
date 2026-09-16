import SwiftUI

/// Settings screen showing connection status and app information.
struct SettingsView: View {
    @Environment(AppSession.self) private var appSession
    @State private var settingsModel = SettingsViewModel()
    @State private var serverVersion: String?
    @State private var showDisconnectConfirmation = false
    @State private var showErrorAlert = false
    @State private var errorMessage = ""
    @State private var isReconnecting = false
    @State private var showConnection = false

    private var profile: ServerProfile? {
        appSession.activeProfile
    }

    var body: some View {
        NavigationStack {
            Form {
                connectionSection
                devicesSection
                consoleSection
                daemonSection
                aboutSection
            }
            .navigationTitle(String(localized: "settings.title"))
            .navigationBarTitleDisplayMode(.inline)
            .alert(String(localized: "settings.disconnect.confirm"), isPresented: $showDisconnectConfirmation) {
                Button(String(localized: "action.cancel"), role: .cancel) { }
                Button(String(localized: "settings.disconnect"), role: .destructive) {
                    disconnect()
                }
            }
            .alert(String(localized: "common.error"), isPresented: $showErrorAlert) {
                Button(String(localized: "common.ok")) { }
            } message: {
                Text(errorMessage)
            }
            .task {
                await loadVersion()
                settingsModel.load()
                settingsModel.activeProfileId = appSession.activeProfileID
            }
            .sheet(isPresented: $showConnection) {
                ConnectionView { _ in
                    showConnection = false
                    settingsModel.load()
                    appSession.refreshProfiles()
                    if let profile = appSession.profiles.last {
                        appSession.activate(profile: profile)
                        settingsModel.activeProfileId = profile.id
                    }
                }
            }
        }
    }

    // MARK: - Connection Section

    private var connectionSection: some View {
        Section(String(localized: "settings.connection")) {
            if let profile {
                LabeledContent(String(localized: "settings.server")) {
                    Text(profile.origin)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }

                LabeledContent("Transport") {
                    Text(profile.isLAN ? "LAN (HTTP)" : "HTTPS Tunnel")
                }
            }

            LabeledContent(String(localized: "settings.status")) {
                HStack(spacing: 6) {
                    Circle()
                        .fill(statusColor)
                        .frame(width: 8, height: 8)
                    Text(statusText)
                        .foregroundColor(.secondary)
                }
            }

            if appSession.connectionState.isConnected {
                Button(role: .destructive) {
                    showDisconnectConfirmation = true
                } label: {
                    Text(String(localized: "settings.disconnect"))
                }
            }

            if !appSession.connectionState.isConnected && profile != nil {
                Button {
                    Task { await reconnect() }
                } label: {
                    if isReconnecting {
                        HStack {
                            ProgressView()
                            Text(String(localized: "settings.reconnect"))
                        }
                    } else {
                        Text(String(localized: "settings.reconnect"))
                    }
                }
                .disabled(isReconnecting)
            }

            if appSession.connectionState == .unconfigured {
                Text(String(localized: "settings.security_hint"))
                    .foregroundColor(.secondary)
            }
        }
    }

    // MARK: - Devices Section

    private var devicesSection: some View {
        Section("Devices") {
            if settingsModel.savedProfiles.isEmpty {
                Text("No devices saved")
                    .foregroundStyle(.secondary)
            }
            ForEach(settingsModel.savedProfiles) { savedProfile in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(savedProfile.displayName)
                            .fontWeight(.medium)
                        Text(savedProfile.origin)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    Spacer()
                    if settingsModel.isActive(savedProfile) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                            .imageScale(.small)
                    }
                }
                .contentShape(Rectangle())
                .onTapGesture {
                    appSession.activate(profile: savedProfile)
                    settingsModel.activeProfileId = savedProfile.id
                }
            }
            .onDelete { indexSet in
                for i in indexSet {
                    let p = settingsModel.savedProfiles[i]
                    settingsModel.deleteProfile(p)
                    appSession.delete(profile: p)
                }
            }

            Button {
                showConnection = true
            } label: {
                Label("Add Device", systemImage: "plus.circle")
            }
        }
    }

    // MARK: - Daemon Section

    private var daemonSection: some View {
        Section("Daemon") {
            LabeledContent(String(localized: "settings.version")) {
                Text(serverVersion ?? "—")
            }
        }
    }

    private var consoleSection: some View {
        Section("Console") {
            NavigationLink {
                RoutinesView()
            } label: {
                Label("Routines", systemImage: "clock.arrow.circlepath")
            }
            NavigationLink {
                AgentUsageView()
            } label: {
                Label("Agents & Usage", systemImage: "chart.bar")
            }
            NavigationLink {
                ProviderSettingsView()
            } label: {
                Label("Providers", systemImage: "server.rack")
            }
        }
    }

    // MARK: - About Section

    private var aboutSection: some View {
        Section("About") {
            LabeledContent("App Version") {
                Text(appVersion)
            }

            if let url = URL(string: "https://github.com/openkin/kin") {
                Link("GitHub", destination: url)
            }
        }
    }

    // MARK: - Helpers

    private var statusColor: Color {
        switch appSession.connectionState {
        case .connected:
            return .green
        case .connecting, .reconnecting:
            return .yellow
        case .unauthorized, .incompatible, .offline:
            return .red
        case .unconfigured:
            return .gray
        }
    }

    private var statusText: String {
        switch appSession.connectionState {
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
            return message.isEmpty
                ? String(localized: "connection.state.offline")
                : message
        }
    }

    private var appVersion: String {
        (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "—"
    }

    private func loadVersion() async {
        guard let client = appSession.apiClient else { return }
        serverVersion = try? await client.version()
    }

    private func disconnect() {
        if let profile = appSession.activeProfile {
            appSession.delete(profile: profile)
        }
        serverVersion = nil
    }

    private func reconnect() async {
        guard appSession.apiClient != nil else {
            errorMessage = String(localized: "api.error.unauthorized")
            showErrorAlert = true
            return
        }

        isReconnecting = true
        do {
            await appSession.reconcileForeground()
            let version = try await appSession.apiClient?.version()
            serverVersion = version
        } catch ServerProfileError.unreachable {
            errorMessage = String(localized: "api.error.invalid_url")
            showErrorAlert = true
        } catch ServerProfileError.unauthorized {
            errorMessage = String(localized: "api.error.unauthorized")
            showErrorAlert = true
        } catch ServerProfileError.incompatible {
            errorMessage = String(localized: "api.error.invalid_response")
            showErrorAlert = true
        } catch {
            errorMessage = error.localizedDescription
            showErrorAlert = true
        }

        isReconnecting = false
    }
}

#Preview {
    SettingsView()
        .environment(AppSession())
}
