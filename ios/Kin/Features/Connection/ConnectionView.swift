import SwiftUI

struct ConnectionView: View {
    /// Called when a connection is successfully established.
    var onConnected: ((ServerProfile) -> Void)?

    @State private var serverURLString: String = ""
    @State private var token: String = ""
    @State private var isConnecting: Bool = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Server") {
                    TextField("https://kin-relay.xxx.workers.dev", text: $serverURLString)
                        .textContentType(.URL)
                        .autocapitalization(.none)
                        .disableAutocorrection(true)
                        .keyboardType(.URL)
                }

                Section("Token") {
                    SecureField("Bearer token", text: $token)
                        .autocapitalization(.none)
                        .disableAutocorrection(true)
                }

                if let errorMessage {
                    Section {
                        Text(errorMessage)
                            .foregroundStyle(.red)
                    }
                }

                Section {
                    Button(action: connect) {
                        if isConnecting {
                            ProgressView()
                                .progressViewStyle(.circular)
                        } else {
                            Text("Connect")
                        }
                    }
                    .disabled(isConnecting || serverURLString.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .frame(maxWidth: .infinity)
                }
            }
            .navigationTitle("Add Device")
        }
    }

    private func connect() {
        guard let url = URL(string: serverURLString.trimmingCharacters(in: .whitespacesAndNewlines)),
              var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            errorMessage = "Invalid URL"
            return
        }
        components.query = nil
        components.fragment = nil
        guard let baseURL = components.url else {
            errorMessage = "Invalid URL"
            return
        }

        isConnecting = true
        errorMessage = nil

        let displayName = baseURL.host ?? "Server \(Date().formatted())"
        var profile = ServerProfile(displayName: displayName, baseURL: baseURL)
        // In a real implementation, probe the daemon health endpoint here.
        // For now, simulate async probe.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [self] in
            isConnecting = false
            profile.lastConnected = Date()
            // Save to multi-device list
            UserDefaults.upsertServerProfile(profile)
            onConnected?(profile)
        }
    }
}

#Preview {
    ConnectionView()
}