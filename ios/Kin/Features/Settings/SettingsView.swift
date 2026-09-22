import SwiftUI

struct SettingsView: View {
    @Environment(AppSession.self) private var appSession
    @State private var settingsModel = SettingsViewModel()

    private var profile: ServerProfile? {
        appSession.activeProfile
    }

    var body: some View {
        NavigationStack {
            Form {
                activeDesktopSection
                localPhoneSection
                remoteOperationsSection
                aboutLinkSection
            }
            .navigationTitle(String(localized: "settings.title"))
            .navigationBarTitleDisplayMode(.inline)
            .task {
                settingsModel.load()
                settingsModel.activeProfileId = appSession.activeProfileID
            }
            .onChange(of: appSession.activeProfileID) { _, activeID in
                settingsModel.load()
                settingsModel.activeProfileId = activeID
            }
        }
    }

    private var activeDesktopSection: some View {
        Section {
            NavigationLink {
                ConnectionSettingsView()
            } label: {
                SettingsDestinationRow(
                    icon: "desktopcomputer",
                    title: profile?.activeDesktopName ?? String(localized: "control.no_desktop"),
                    subtitle: activeDesktopSubtitle,
                    status: statusText,
                    statusColor: statusColor
                )
            }
        } header: {
            Text(String(localized: "settings.connection"))
        } footer: {
            Text(String(localized: "settings.connection.footer"))
        }
    }

    private var localPhoneSection: some View {
        Section {
            NavigationLink {
                ConnectionSettingsView()
            } label: {
                SettingsDestinationRow(
                    icon: "iphone",
                    title: String(localized: "settings.devices"),
                    subtitle: localProfilesSubtitle,
                    status: nil,
                    statusColor: .secondary
                )
            }
        } header: {
            Text(String(localized: "settings.local"))
        } footer: {
            Text(String(localized: "settings.local.footer"))
        }
    }

    private var remoteOperationsSection: some View {
        Section {
            NavigationLink {
                RemoteStatusView()
            } label: {
                SettingsDestinationRow(
                    icon: "point.3.connected.trianglepath.dotted",
                    title: String(localized: "settings.remote"),
                    subtitle: String(localized: "settings.remote.subtitle"),
                    status: nil,
                    statusColor: .secondary
                )
            }

            NavigationLink {
                AgentUsageView()
            } label: {
                SettingsDestinationRow(
                    icon: "chart.bar",
                    title: String(localized: "settings.agents_usage"),
                    subtitle: String(localized: "settings.agents_usage.subtitle"),
                    status: nil,
                    statusColor: .secondary
                )
            }

            NavigationLink {
                ProviderSettingsView()
            } label: {
                SettingsDestinationRow(
                    icon: "server.rack",
                    title: String(localized: "settings.providers"),
                    subtitle: providerSubtitle,
                    status: nil,
                    statusColor: .secondary
                )
            }

            NavigationLink {
                RoutinesView()
            } label: {
                SettingsDestinationRow(
                    icon: "clock.arrow.circlepath",
                    title: String(localized: "settings.routines"),
                    subtitle: String(localized: "settings.routines.subtitle"),
                    status: nil,
                    statusColor: .secondary
                )
            }
        } header: {
            Text(String(localized: "settings.operations"))
        } footer: {
            Text(String(localized: "settings.operations.footer"))
        }
    }

    private var aboutLinkSection: some View {
        Section {
            NavigationLink {
                AboutSettingsView()
            } label: {
                SettingsDestinationRow(
                    icon: "info.circle",
                    title: String(localized: "settings.about"),
                    subtitle: String(localized: "settings.about.subtitle"),
                    status: nil,
                    statusColor: .secondary
                )
            }
        }
    }

    private var activeDesktopSubtitle: String {
        guard let profile else {
            return String(localized: "settings.connection.unconfigured")
        }
        return String(
            format: String(localized: "settings.connection.subtitle_format"),
            profile.origin
        )
    }

    private var localProfilesSubtitle: String {
        let count = settingsModel.savedProfiles.count
        return String(
            format: String(localized: "settings.devices.count_format"),
            count
        )
    }

    private var providerSubtitle: String {
        appSession.canManageDaemon
            ? String(localized: "settings.providers.subtitle.manage")
            : String(localized: "settings.providers.subtitle.read_only")
    }

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
}

private struct ConnectionSettingsView: View {
    @Environment(AppSession.self) private var appSession
    @State private var settingsModel = SettingsViewModel()
    @State private var showDisconnectConfirmation = false
    @State private var showErrorAlert = false
    @State private var errorMessage = ""
    @State private var isReconnecting = false
    @State private var showConnection = false

    private var profile: ServerProfile? {
        appSession.activeProfile
    }

    var body: some View {
        Form {
            activeSection
            devicesSection
        }
        .navigationTitle(String(localized: "settings.connection"))
        .navigationBarTitleDisplayMode(.inline)
        .task {
            reloadProfiles()
        }
        .onChange(of: appSession.activeProfileID) { _, _ in
            reloadProfiles()
        }
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
        .sheet(isPresented: $showConnection) {
            ConnectionView { _, profile in
                showConnection = false
                appSession.refreshProfiles()
                appSession.activate(profile: profile)
                reloadProfiles()
            }
        }
    }

    private var activeSection: some View {
        Section {
            if let profile {
                let summary = SettingsPresentation.profileSummary(
                    for: profile,
                    activeProfileID: appSession.activeProfileID
                )
                LabeledContent(String(localized: "settings.server")) {
                    Text(summary.origin)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                LabeledContent(String(localized: "settings.transport")) {
                    Text(String(localized: String.LocalizationValue(summary.transportKey)))
                }
                LabeledContent(String(localized: "settings.profile.credential")) {
                    Text(String(localized: String.LocalizationValue(summary.credentialKey)))
                }
                LabeledContent(String(localized: "settings.management")) {
                    Text(String(localized: String.LocalizationValue(summary.managementAccessKey)))
                }
            } else {
                ContentUnavailableView(
                    String(localized: "settings.connection.unconfigured.title"),
                    systemImage: "desktopcomputer.slash",
                    description: Text(String(localized: "settings.connection.unconfigured.message"))
                )
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

            Button {
                showConnection = true
            } label: {
                Label(String(localized: "settings.devices.add"), systemImage: "plus.circle")
            }
        } header: {
            Text(String(localized: "settings.active_desktop"))
        } footer: {
            Text(String(localized: "settings.connection.actions.footer"))
        }
    }

    private var devicesSection: some View {
        Section {
            if settingsModel.savedProfiles.isEmpty {
                Text(String(localized: "settings.devices.empty"))
                    .foregroundStyle(.secondary)
            }

            ForEach(settingsModel.savedProfiles) { savedProfile in
                let summary = SettingsPresentation.profileSummary(
                    for: savedProfile,
                    activeProfileID: settingsModel.activeProfileId
                )
                Button {
                    guard !summary.isActive else { return }
                    appSession.activate(profile: savedProfile)
                    reloadProfiles()
                } label: {
                    ProfileSummaryRow(summary: summary)
                }
                .buttonStyle(.plain)
            }
            .onDelete { indexSet in
                for index in indexSet {
                    let profile = settingsModel.savedProfiles[index]
                    settingsModel.deleteProfile(profile)
                    appSession.delete(profile: profile)
                    reloadProfiles()
                }
            }
        } header: {
            Text(String(localized: "settings.devices"))
        } footer: {
            Text(String(localized: "settings.devices.footer"))
        }
    }

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

    private func reloadProfiles() {
        settingsModel.load()
        settingsModel.activeProfileId = appSession.activeProfileID
    }

    private func disconnect() {
        if let profile = appSession.activeProfile {
            appSession.delete(profile: profile)
        }
        reloadProfiles()
    }

    private func reconnect() async {
        guard let requestedProfileID = appSession.activeProfileID, let client = appSession.apiClient else {
            errorMessage = String(localized: "api.error.unauthorized")
            showErrorAlert = true
            return
        }

        isReconnecting = true
        do {
            await appSession.reconcileForeground()
            guard appSession.activeProfileID == requestedProfileID else {
                isReconnecting = false
                return
            }
            _ = try await client.version()
            guard appSession.activeProfileID == requestedProfileID else {
                isReconnecting = false
                return
            }
            isReconnecting = false
        } catch ServerProfileError.unreachable {
            guard appSession.activeProfileID == requestedProfileID else {
                isReconnecting = false
                return
            }
            errorMessage = String(localized: "api.error.invalid_url")
            showErrorAlert = true
            isReconnecting = false
        } catch ServerProfileError.unauthorized {
            guard appSession.activeProfileID == requestedProfileID else {
                isReconnecting = false
                return
            }
            errorMessage = String(localized: "api.error.unauthorized")
            showErrorAlert = true
            isReconnecting = false
        } catch ServerProfileError.incompatible {
            guard appSession.activeProfileID == requestedProfileID else {
                isReconnecting = false
                return
            }
            errorMessage = String(localized: "api.error.invalid_response")
            showErrorAlert = true
            isReconnecting = false
        } catch {
            guard appSession.activeProfileID == requestedProfileID else {
                isReconnecting = false
                return
            }
            errorMessage = error.localizedDescription
            showErrorAlert = true
            isReconnecting = false
        }
    }
}

private struct RemoteStatusView: View {
    @Environment(AppSession.self) private var appSession
    @State private var serverVersion: String?
    @State private var workers: [WorkerRecord] = []
    @State private var isLoading = false
    @State private var loadedProfileID: UUID?
    @State private var error: String?

    var body: some View {
        List {
            SettingsScopeSection(profile: appSession.activeProfile, connectionState: appSession.connectionState)

            Section(String(localized: "settings.daemon")) {
                LabeledContent(String(localized: "settings.version")) {
                    Text(serverVersion ?? "—")
                }
            }

            Section(String(localized: "settings.workers")) {
                if isLoading {
                    ProgressView()
                } else if workers.isEmpty && error == nil {
                    ContentUnavailableView(
                        String(localized: "settings.workers.none"),
                        systemImage: "server.rack",
                        description: Text(String(localized: "settings.workers.none.message"))
                    )
                }

                ForEach(workers) { worker in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(OperationsPresentation.workerDisplayName(worker))
                            .fontWeight(.medium)
                        LabeledContent(String(localized: "settings.worker.state")) {
                            Text(OperationsPresentation.workerStateLabel(worker.state))
                                .foregroundStyle(worker.state == "online" ? .green : .orange)
                        }
                        Text(
                            String(
                                format: String(localized: "settings.worker.capacity_format"),
                                worker.maxConcurrent
                            )
                        )
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 3)
                }
            }

            if let error {
                Section {
                    Text(error)
                        .foregroundStyle(.red)
                }
            }
        }
        .navigationTitle(String(localized: "settings.remote"))
        .refreshable { await load() }
        .task(id: appSession.activeProfileID) { await load() }
    }

    private func load() async {
        guard let requestedProfileID = appSession.activeProfileID, let client = appSession.apiClient else {
            serverVersion = nil
            workers = []
            loadedProfileID = appSession.activeProfileID
            isLoading = false
            error = nil
            return
        }
        if loadedProfileID != requestedProfileID {
            serverVersion = nil
            workers = []
        }
        isLoading = true

        do {
            async let nextVersion = client.version()
            async let nextWorkers = client.workers()
            let loadedVersion = try await nextVersion
            let loadedWorkers = try await nextWorkers
            guard appSession.activeProfileID == requestedProfileID else { return }
            serverVersion = loadedVersion
            workers = loadedWorkers
            loadedProfileID = requestedProfileID
            isLoading = false
            error = nil
        } catch {
            guard appSession.activeProfileID == requestedProfileID else { return }
            serverVersion = nil
            workers = []
            loadedProfileID = requestedProfileID
            isLoading = false
            self.error = error.localizedDescription
        }
    }
}

private struct AboutSettingsView: View {
    @Environment(AppSession.self) private var appSession
    @State private var serverVersion: String?
    @State private var isLoading = false
    @State private var loadedProfileID: UUID?
    @State private var error: String?

    var body: some View {
        Form {
            Section(String(localized: "settings.about")) {
                LabeledContent(String(localized: "settings.app_version")) {
                    Text(appVersion)
                }
                LabeledContent(String(localized: "settings.version")) {
                    if isLoading {
                        ProgressView()
                    } else {
                        Text(serverVersion ?? "—")
                    }
                }

                if let url = URL(string: "https://github.com/openkin/kin") {
                    Link(String(localized: "settings.github"), destination: url)
                }
            }

            if let error {
                Section {
                    Text(error)
                        .foregroundStyle(.red)
                }
            }
        }
        .navigationTitle(String(localized: "settings.about"))
        .task(id: appSession.activeProfileID) {
            await loadVersion()
        }
        .refreshable { await loadVersion() }
    }

    private var appVersion: String {
        (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "—"
    }

    private func loadVersion() async {
        guard let requestedProfileID = appSession.activeProfileID, let client = appSession.apiClient else {
            serverVersion = nil
            loadedProfileID = appSession.activeProfileID
            isLoading = false
            error = nil
            return
        }
        if loadedProfileID != requestedProfileID {
            serverVersion = nil
        }
        isLoading = true
        do {
            let version = try await client.version()
            guard appSession.activeProfileID == requestedProfileID else { return }
            serverVersion = version
            loadedProfileID = requestedProfileID
            isLoading = false
            error = nil
        } catch {
            guard appSession.activeProfileID == requestedProfileID else { return }
            serverVersion = nil
            loadedProfileID = requestedProfileID
            isLoading = false
            self.error = error.localizedDescription
        }
    }
}

private struct SettingsDestinationRow: View {
    let icon: String
    let title: String
    let subtitle: String
    let status: String?
    let statusColor: Color

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .foregroundStyle(statusColor)
                .frame(width: 28)

            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.body.weight(.medium))
                    .foregroundStyle(.primary)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }

            Spacer(minLength: 8)

            if let status {
                Text(status)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(statusColor)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 4)
    }
}

private struct ProfileSummaryRow: View {
    let summary: SettingsPresentation.ProfileSummary

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "desktopcomputer")
                .foregroundStyle(summary.isActive ? .green : .secondary)
                .frame(width: 28)

            VStack(alignment: .leading, spacing: 4) {
                Text(summary.title)
                    .fontWeight(.medium)
                Text(summary.origin)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                HStack(spacing: 6) {
                    Text(String(localized: String.LocalizationValue(summary.transportKey)))
                    Text("·")
                    Text(String(localized: String.LocalizationValue(summary.credentialKey)))
                }
                .font(.caption2.weight(.medium))
                .foregroundStyle(.tertiary)
            }

            Spacer()

            if summary.isActive {
                VStack(alignment: .trailing, spacing: 3) {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                        .imageScale(.small)
                    Text(String(localized: "desktop.active"))
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 4)
    }
}

private struct SettingsScopeSection: View {
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

#Preview {
    SettingsView()
        .environment(AppSession())
}
