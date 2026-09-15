import SwiftUI

@main
struct KinApp: App {
    @State private var appModel = AppModel()
    @State private var showProfilePicker = false

    var body: some Scene {
        WindowGroup {
            Group {
                if appModel.connectionState == .unconfigured || appModel.connectionState == .disconnected {
                    if showProfilePicker && appModel.savedProfiles.count > 1 {
                        ProfilePickerView(appModel: appModel)
                    } else {
                        ConnectionView { profile in
                            appModel.addProfile(profile)
                            appModel.connect(to: profile)
                        }
                    }
                } else {
                    MainTabView(appModel: appModel)
                }
            }
            .onAppear {
                // Auto-connect if exactly one profile exists
                if let profile = appModel.resolveStartupProfile() {
                    appModel.connect(to: profile)
                } else if appModel.savedProfiles.count > 1 {
                    showProfilePicker = true
                }
            }
        }
    }
}

/// Shown when multiple saved profiles exist at launch.
struct ProfilePickerView: View {
    @State var appModel: AppModel

    var body: some View {
        NavigationStack {
            List {
                Section("Select a device") {
                    ForEach(appModel.savedProfiles) { profile in
                        Button {
                            appModel.connect(to: profile)
                        } label: {
                            VStack(alignment: .leading) {
                                Text(profile.displayName)
                                    .fontWeight(.medium)
                                Text(profile.baseURL.absoluteString)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                if let last = profile.lastConnected {
                                    Text("Last connected: \(last.formatted())")
                                        .font(.caption2)
                                        .foregroundStyle(.tertiary)
                                }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }

                Section {
                    Button("Add New Device") {
                        // Will present connection view — simplified for this slice
                    }
                }
            }
            .navigationTitle("Kin")
        }
    }
}

/// Placeholder main tab view after connection.
struct MainTabView: View {
    @State var appModel: AppModel

    var body: some View {
        TabView {
            Text("Control")
                .tabItem { Label("Control", systemImage: "terminal") }

            Text("Tasks")
                .tabItem { Label("Tasks", systemImage: "list.bullet") }

            SettingsView(onSwitchProfile: { profile in
                appModel.connect(to: profile)
            })
            .tabItem { Label("Settings", systemImage: "gear") }
        }
    }
}