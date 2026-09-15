import SwiftUI

/// View for establishing connection to the Kin daemon.
///
/// Presents two paths:
/// 1. Scan QR code (camera-based via `QRScannerView`)
/// 2. Manual URL + token entry
///
/// On success, calls `onConnected` with a configured `APIClient` for the caller
/// to wire into the rest of the app (Reconciler, view models, etc.).
struct ConnectionView: View {
    let onConnected: (APIClient) -> Void

    @State private var showScanner = false
    @State private var scannedCode: String?

    @State private var manualURL = ""
    @State private var manualToken = ""
    @State private var isManualExpanded = false

    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                header
                scanButton
                manualDisclosure
                errorView
                Spacer()
            }
            .padding(.horizontal, 24)
            .padding(.top, 48)
        }
        .background(Color(.systemGroupedBackground))
        .sheet(isPresented: $showScanner) {
            QRScannerView { code in
                showScanner = false
                scannedCode = code
                processScannedCode(code)
            } onCancel: {
                showScanner = false
            }
        }
    }

    // MARK: - Header

    private var header: some View {
        VStack(spacing: 8) {
            Image(systemName: "dot.radiowaves.left.and.right")
                .font(.system(size: 48))
                .foregroundStyle(.tint)
            Text("Connect to Kin Daemon")
                .font(.title)
                .fontWeight(.bold)
            Text("Pair with your Kin daemon to get started")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
    }

    // MARK: - Scan QR Code

    private var scanButton: some View {
        Button {
            showScanner = true
        } label: {
            Label("Scan QR Code", systemImage: "qrcode.viewfinder")
                .font(.headline)
                .frame(maxWidth: .infinity, minHeight: 50)
        }
        .buttonStyle(.borderedProminent)
        .disabled(isLoading)
    }

    // MARK: - Manual entry

    private var manualDisclosure: some View {
        DisclosureGroup(
            isExpanded: $isManualExpanded,
            content: {
                VStack(spacing: 16) {
                    TextField("Daemon URL (e.g. http://192.168.1.42:7777)", text: $manualURL)
                        .textContentType(.URL)
                        .keyboardType(.URL)
                        .autocapitalization(.none)
                        .disableAutocorrection(true)
                        .textFieldStyle(.roundedBorder)
                        .disabled(isLoading)

                    SecureField("Auth Token", text: $manualToken)
                        .textContentType(.password)
                        .textFieldStyle(.roundedBorder)
                        .disabled(isLoading)

                    connectButton
                }
                .padding(.top, 12)
            },
            label: {
                Label("Enter URL Manually", systemImage: "keyboard")
                    .font(.body)
            }
        )
    }

    private var connectButton: some View {
        Button {
            attemptManualConnection()
        } label: {
            if isLoading {
                ProgressView()
                    .frame(maxWidth: .infinity, minHeight: 44)
            } else {
                Text("Connect")
                    .font(.headline)
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
        }
        .buttonStyle(.borderedProminent)
        .disabled(isLoading || manualURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || manualToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    // MARK: - Error

    @ViewBuilder
    private var errorView: some View {
        if let errorMessage {
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.red)
                Text(errorMessage)
                    .font(.callout)
                    .foregroundStyle(.red)
                Spacer()
                Button("Retry") {
                    self.errorMessage = nil
                }
                .font(.callout)
            }
            .padding(12)
            .background(Color.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
        }
    }

    // MARK: - Actions

    private func attemptManualConnection() {
        let urlString = manualURL.trimmingCharacters(in: .whitespacesAndNewlines)
        let token = manualToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !urlString.isEmpty, !token.isEmpty else { return }

        isLoading = true
        errorMessage = nil

        Task {
            do {
                // Build a pairing URL in the format the validator expects
                let separator = urlString.contains("?") ? "&" : "?"
                let pairingURL = "\(urlString)\(separator)token=\(token)"
                let payload = try PairingPayload.parse(pairingURL)
                try await validateAndConnect(payload: payload)
            } catch {
                await MainActor.run {
                    errorMessage = error.localizedDescription
                    isLoading = false
                }
            }
        }
    }

    private func processScannedCode(_ code: String) {
        isLoading = true
        errorMessage = nil

        Task {
            do {
                let payload = try PairingPayload.parse(code)
                try await validateAndConnect(payload: payload)
            } catch {
                await MainActor.run {
                    errorMessage = error.localizedDescription
                    isLoading = false
                }
            }
        }
    }

    private func validateAndConnect(payload: PairingPayload) async throws {
        do {
            let (_, _) = try await ServerProfileValidator.validate(
                baseURL: payload.baseURL,
                token: payload.token
            )

            // Store token in Keychain
            do {
                if try KeychainStore.readToken() != nil {
                    try KeychainStore.updateToken(payload.token)
                } else {
                    try KeychainStore.store(token: payload.token)
                }
            } catch {
                // Non-fatal: connection can proceed even if Keychain fails
            }

            // Persist server profile
            let profile = ServerProfile(
                id: UUID(),
                displayName: payload.baseURL.host ?? "Kin Daemon",
                baseURL: payload.baseURL,
                dateAdded: Date(),
                lastAccessed: Date()
            )
            if let encoded = try? JSONEncoder().encode(profile) {
                UserDefaults.standard.set(encoded, forKey: "kin_server_profile")
            }
            // Also save to multi-device list
            UserDefaults.upsertServerProfile(profile)

            let client = APIClient(baseURL: payload.baseURL, token: payload.token)

            await MainActor.run {
                isLoading = false
                errorMessage = nil
                onConnected(client)
            }
        } catch {
            await MainActor.run {
                errorMessage = error.localizedDescription
                isLoading = false
            }
        }
    }
}

// MARK: - Previews

#if DEBUG
#Preview("Unconnected") {
    ConnectionView(onConnected: { _ in })
}
#endif