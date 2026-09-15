import SwiftUI

/// Settings screen showing connection status and app information.
struct SettingsView: View {
    @Environment(AppModel.self) private var appModel
    @State private var settingsModel = SettingsViewModel()
    @State private var serverVersion: String?
    @State private var showDisconnectConfirmation = false
    @State private var showErrorAlert = false
    @State private var errorMessage = ""
    @State private var isReconnecting = false
    @State private var showConnection = false

    private var profile: ServerProfile? {
        UserDefaults.loadServerProfile()
    }

    var body: some View {
        NavigationStack {
            Form {
                connectionSection
                devicesSection
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
            }
            .sheet(isPresented: $showConnection) {
                ConnectionView { client in
                    showConnection = false
                    settingsModel.load()
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

            if appModel.connectionState.isConnected {
                Button(role: .destructive) {
                    showDisconnectConfirmation = true
                } label: {
                    Text(String(localized: "settings.disconnect"))
                }
            }

            if !appModel.connectionState.isConnected && profile != nil {
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

            if appModel.connectionState == .unconfigured {
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
            }
            .onDelete { indexSet in
                for i in indexSet {
                    let p = settingsModel.savedProfiles[i]
                    settingsModel.deleteProfile(p)
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
        switch appModel.connectionState {
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
        switch appModel.connectionState {
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
        guard let profile,
              let token = try? KeychainStore.readToken() else { return }

        let client = APIClient(baseURL: profile.baseURL, token: token)
        serverVersion = try? await client.version()
    }

    private func disconnect() {
        try? KeychainStore.deleteToken()
        UserDefaults.deleteServerProfile()
        appModel.connectionState = .unconfigured
        serverVersion = nil
    }

    private func reconnect() async {
        guard let profile,
              let token = try? KeychainStore.readToken() else {
            errorMessage = String(localized: "api.error.unauthorized")
            showErrorAlert = true
            return
        }

        isReconnecting = true
        appModel.connectionState = .connecting

        do {
            let (_, version) = try await ServerProfileValidator.validate(
                baseURL: profile.baseURL,
                token: token
            )
            serverVersion = version
            appModel.connectionState = .connected
        } catch ServerProfileError.unreachable {
            appModel.connectionState = .offline(String(localized: "connection.state.offline"))
            errorMessage = String(localized: "api.error.invalid_url")
            showErrorAlert = true
        } catch ServerProfileError.unauthorized {
            appModel.connectionState = .unauthorized
            errorMessage = String(localized: "api.error.unauthorized")
            showErrorAlert = true
        } catch ServerProfileError.incompatible {
            appModel.connectionState = .incompatible
            errorMessage = String(localized: "api.error.invalid_response")
            showErrorAlert = true
        } catch {
            appModel.connectionState = .offline(error.localizedDescription)
            errorMessage = error.localizedDescription
            showErrorAlert = true
        }

        isReconnecting = false
    }
}

#Preview {
    SettingsView()
        .environment(AppModel())
}