import SwiftUI

/// A thin banner that shows the current connection state.
/// Tapping opens the Settings tab, where the connection can be fixed.
struct ConnectionBanner: View {
    @Environment(AppModel.self) private var appModel
    @Environment(AppSession.self) private var appSession
    @State private var showDelayedBanner = false

    var body: some View {
        let state = appSession.connectionState
        let info = bannerInfo(for: state, isDelayedVisible: showDelayedBanner)

        Group {
            if let info {
                Button {
                    appModel.selectedTab = .settings
                } label: {
                    HStack(spacing: 6) {
                        if info.showSpinner {
                            ProgressView()
                                .tint(.white)
                                .scaleEffect(0.7)
                        }

                        Text(info.label)
                            .font(.caption2)
                            .fontWeight(.semibold)

                        Spacer()
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 3)
                    .frame(height: 24)
                    .frame(maxWidth: .infinity)
                    .background(info.color)
                }
                .buttonStyle(.plain)
                .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.easeInOut(duration: 0.25), value: appSession.connectionState)
        .task(id: ConnectionBannerPresentation.identity(for: state)) {
            await updateDelayedBanner(for: state)
        }
    }

    /// Returns banner content for the given state, or `nil` when no banner should be shown.
    private func bannerInfo(
        for state: ConnectionState,
        isDelayedVisible: Bool
    ) -> (label: String, color: Color, showSpinner: Bool)? {
        guard ConnectionBannerPresentation.shouldRender(state, isDelayedVisible: isDelayedVisible) else {
            return nil
        }

        switch state {
        case .connected, .unconfigured, .connecting, .reconnecting:
            return nil

        case .unauthorized:
            return (
                String(localized: "Unauthorized", comment: "Connection banner: unauthorized state"),
                .red,
                false
            )

        case .incompatible:
            return (
                String(localized: "Incompatible Version", comment: "Connection banner: incompatible version"),
                .red,
                false
            )

        case let .offline(message):
            return (
                message.isEmpty
                    ? String(localized: "Offline", comment: "Connection banner: offline state")
                    : message,
                .red,
                false
            )
        }
    }

    @MainActor
    private func updateDelayedBanner(for state: ConnectionState) async {
        showDelayedBanner = ConnectionBannerPresentation.shouldShowImmediately(state)
        guard let delay = ConnectionBannerPresentation.displayDelay(for: state) else { return }
        let identity = ConnectionBannerPresentation.identity(for: state)
        try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
        guard !Task.isCancelled else { return }
        guard ConnectionBannerPresentation.identity(for: appSession.connectionState) == identity else { return }
        showDelayedBanner = true
    }
}

enum ConnectionBannerPresentation {
    static let offlineDisplayDelay: TimeInterval = 30

    static func shouldRender(_ state: ConnectionState, isDelayedVisible: Bool) -> Bool {
        if shouldShowImmediately(state) { return true }
        return displayDelay(for: state) != nil && isDelayedVisible
    }

    static func shouldShowImmediately(_ state: ConnectionState) -> Bool {
        switch state {
        case .unauthorized, .incompatible:
            return true
        case .unconfigured, .connecting, .connected, .reconnecting, .offline:
            return false
        }
    }

    static func displayDelay(for state: ConnectionState) -> TimeInterval? {
        switch state {
        case .offline:
            return offlineDisplayDelay
        case .unconfigured, .connecting, .connected, .reconnecting, .unauthorized, .incompatible:
            return nil
        }
    }

    static func identity(for state: ConnectionState) -> String {
        switch state {
        case .unconfigured:
            return "unconfigured"
        case .connecting:
            return "connecting"
        case .connected:
            return "connected"
        case .reconnecting:
            return "reconnecting"
        case .unauthorized:
            return "unauthorized"
        case .incompatible:
            return "incompatible"
        case .offline:
            return "offline"
        }
    }
}

#Preview("Reconnecting") {
    let session = AppSession()
    session.installConnectionStateForTesting(.reconnecting(delay: 2))
    return ConnectionBanner()
        .environment(AppModel())
        .environment(session)
}

#Preview("Offline") {
    let session = AppSession()
    session.installConnectionStateForTesting(.offline("Connection lost"))
    return ConnectionBanner()
        .environment(AppModel())
        .environment(session)
}
