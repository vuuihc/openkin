import SwiftUI

/// A thin banner that shows the current connection state.
/// Tapping navigates to connection settings when applicable.
struct ConnectionBanner: View {
    @Environment(AppModel.self) private var appModel
    @Environment(AppSession.self) private var appSession

    var body: some View {
        let info = bannerInfo(for: appSession.connectionState)

        Group {
            if let info {
                Button {
                    appModel.navigationPath.append(.connection)
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
    }

    /// Returns banner content for the given state, or `nil` when no banner should be shown.
    private func bannerInfo(for state: ConnectionState) -> (label: String, color: Color, showSpinner: Bool)? {
        switch state {
        case .connected, .unconfigured:
            return nil

        case .connecting:
            return (
                String(localized: "Connecting…", comment: "Connection banner: connecting state"),
                .orange,
                true
            )

        case let .reconnecting(delay):
            return (
                String(localized: "Reconnecting…", comment: "Connection banner: reconnecting state"),
                .orange,
                true
            )

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
}

#Preview("Connected — hidden") {
    let model = AppModel()
    model.connectionState = .connected
    return ConnectionBanner()
        .environment(model)
        .environment(AppSession())
}

#Preview("Reconnecting") {
    let model = AppModel()
    model.connectionState = .reconnecting(delay: 2)
    return ConnectionBanner()
        .environment(model)
        .environment(AppSession())
}

#Preview("Unauthorized") {
    let model = AppModel()
    model.connectionState = .unauthorized
    return ConnectionBanner()
        .environment(model)
        .environment(AppSession())
}

#Preview("Offline") {
    let model = AppModel()
    model.connectionState = .offline("Connection lost")
    return ConnectionBanner()
        .environment(model)
        .environment(AppSession())
}
