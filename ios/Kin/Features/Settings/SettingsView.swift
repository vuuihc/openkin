import SwiftUI

struct SettingsView: View {
    @State private var viewModel = SettingsViewModel()
    @State private var showConnection: Bool = false
    @State private var showForgetConfirmation: Bool = false

    /// Callback when the user wants to switch to a different device.
    var onSwitchProfile: ((ServerProfile) -> Void)?

    var body: some View {
        NavigationStack {
            List {
                // MARK: - Connection
                Section("Connection") {
                    if viewModel.connectionState == .unconfigured || viewModel.connectionState == .disconnected {
                        Label("Not connected", systemImage: "circle.slash")
                            .foregroundStyle(.secondary)
                    } else if viewModel.connectionState == .connecting {
                        HStack {
                            ProgressView()
                                .progressViewStyle(.circular)
                            Text("Connecting…")
                                .foregroundStyle(.secondary)
                        }
                    } else if case .error(let msg) = viewModel.connectionState {
                        Label(msg, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                    } else {
                        HStack {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundStyle(.green)
                            Text("Connected")
                        }
                    }

                    if let version = viewModel.daemonVersion {
                        HStack {
                            Text("Daemon version")
                            Spacer()
                            Text(version)
                                .foregroundStyle(.secondary)
                        }
                    }

                    Button("Disconnect") {
                        // Callback to AppModel to disconnect
                    }
                    .foregroundStyle(.red)
                }

                // MARK: - Devices
                Section("Devices") {
                    if viewModel.savedProfiles.isEmpty {
                        Text("No devices saved")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(viewModel.savedProfiles) { profile in
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(profile.displayName)
                                        .fontWeight(.medium)
                                    Text(profile.baseURL.absoluteString)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                    if let last = profile.lastConnected {
                                        Text("Last connected: \(last.formatted(date: .abbreviated, time: .shortened))")
                                            .font(.caption2)
                                            .foregroundStyle(.tertiary)
                                    }
                                }

                                Spacer()

                                if viewModel.isActive(profile) {
                                    Image(systemName: "checkmark.circle.fill")
                                        .foregroundStyle(.green)
                                        .accessibilityLabel("Active device")
                                }

                                Button("Switch") {
                                    viewModel.switchTo(profile)
                                    onSwitchProfile?(profile)
                                }
                                .buttonStyle(.bordered)
                                .tint(viewModel.isActive(profile) ? .gray : .accentColor)
                                .disabled(viewModel.isActive(profile))
                            }
                            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                Button("Remove", role: .destructive) {
                                    viewModel.deleteProfile(profile)
                                }
                            }
                        }
                    }

                    Button("Add Device") {
                        showConnection = true
                    }
                }

                // MARK: - Danger zone
                Section {
                    Button("Forget All Devices", role: .destructive) {
                        showForgetConfirmation = true
                    }
                }
            }
            .navigationTitle("Settings")
            .sheet(isPresented: $showConnection) {
                ConnectionView { profile in
                    // After connecting, refresh the profile list
                    viewModel.load()
                    viewModel.activeProfileId = profile.id
                    viewModel.updateLastConnected(profileId: profile.id)
                    onSwitchProfile?(profile)
                }
            }
            .alert("Forget All Devices?", isPresented: $showForgetConfirmation) {
                Button("Cancel", role: .cancel) {}
                Button("Forget All", role: .destructive) {
                    viewModel.forgetAll()
                }
            } message: {
                Text("This will remove all saved server profiles. You will need to add a device again to connect.")
            }
            .onAppear {
                viewModel.load()
            }
        }
    }
}

#Preview {
    SettingsView()
}