import SwiftUI

/// Main control screen — the default app tab.
///
/// Adapts its content based on the current `connectionState`:
/// - `.unconfigured`: Shows `ConnectionView` to pair a daemon.
/// - `.connecting` / `.offline`: Shows loading or offline state with retry.
/// - `.connected`: Shows pending approvals, pending questions, and active tasks.
struct ControlView: View {
    @Environment(AppSession.self) private var appSession
    @State private var viewModel = ControlViewModel()

    var body: some View {
        Group {
            switch appSession.connectionState {
            case .unconfigured:
                ConnectionView(onConnected: handleConnected)
            case .connecting:
                connectingView
            case .offline:
                offlineView
            case .unauthorized:
                unauthorizedView
            case .incompatible:
                incompatibleView
            case .reconnecting(let delay):
                reconnectingView(delay: delay)
            case .connected:
                connectedContent
            }
        }
        .task(id: appSession.activeProfileID) {
            await loadCurrentRemoteState()
        }
        .refreshable {
            await loadCurrentRemoteState()
        }
    }

    // MARK: - Connection handling

    private func handleConnected(client: APIClient, profile: ServerProfile) {
        viewModel.configure(apiClient: client)
        appSession.refreshProfiles()
        appSession.activate(profile: profile)
        Task {
            await viewModel.load()
        }
    }

    private func loadCurrentRemoteState() async {
        guard let client = appSession.apiClient else {
            viewModel.reset()
            return
        }
        viewModel.configure(apiClient: client)
        await viewModel.load()
    }

    private func activate(profile: ServerProfile) {
        appSession.activate(profile: profile)
        if let client = appSession.apiClient {
            viewModel.configure(apiClient: client)
        } else {
            viewModel.reset()
        }
    }

    // MARK: - Connecting state

    private var connectingView: some View {
        VStack(spacing: 16) {
            ProgressView()
                .scaleEffect(1.2)
            Text(String(localized: "control.connecting"))
                .font(.headline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemGroupedBackground))
    }

    // MARK: - Reconnecting state

    private func reconnectingView(delay: TimeInterval) -> some View {
        VStack(spacing: 16) {
            ProgressView()
                .scaleEffect(1.2)
            Text(String(localized: "connection.state.reconnecting"))
                .font(.headline)
                .foregroundStyle(.secondary)
            if delay > 0 {
                Text(
                    String(
                        format: String(localized: "control.reconnect.next_attempt_format"),
                        Int(delay)
                    )
                )
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemGroupedBackground))
    }

    // MARK: - Offline state

    private var offlineView: some View {
        VStack(spacing: 16) {
            Image(systemName: "wifi.slash")
                .font(.system(size: 48))
                .foregroundStyle(.secondary)
            Text(String(localized: "control.offline.title"))
                .font(.headline)
            if let message = viewModel.error {
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            Button(String(localized: "state.retry")) {
                Task { await viewModel.load() }
            }
            .buttonStyle(.bordered)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemGroupedBackground))
    }

    // MARK: - Unauthorized state

    private var unauthorizedView: some View {
        VStack(spacing: 16) {
            Image(systemName: "lock.shield")
                .font(.system(size: 48))
                .foregroundStyle(.red)
            Text(String(localized: "connection.state.unauthorized"))
                .font(.headline)
            Text(String(localized: "control.unauthorized.message"))
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button(String(localized: "settings.reconnect")) {
                viewModel.reset()
            }
            .buttonStyle(.borderedProminent)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemGroupedBackground))
    }

    // MARK: - Incompatible state

    private var incompatibleView: some View {
        VStack(spacing: 16) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 48))
                .foregroundStyle(.orange)
            Text(String(localized: "connection.state.incompatible"))
                .font(.headline)
            Text(String(localized: "control.incompatible.message"))
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button(String(localized: "settings.reconnect")) {
                viewModel.reset()
            }
            .buttonStyle(.bordered)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemGroupedBackground))
    }

    // MARK: - Connected content

    private var connectedContent: some View {
        let activeTasks = appSession.tasks.filter { !$0.isTerminal }
        let needsActionCount = appSession.approvals.count + appSession.questions.count

        return NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    ActiveDesktopScopeCard(
                        profile: appSession.activeProfile,
                        profiles: appSession.profiles,
                        connectionState: appSession.connectionState,
                        onSelect: activate
                    )

                    if viewModel.isLoading && needsActionCount == 0 && activeTasks.isEmpty {
                        LoadingCard()
                    }

                    if let error = viewModel.error, !error.isEmpty {
                        InlineErrorCard(message: error)
                    }

                    TodaySummaryGrid(
                        approvals: appSession.approvals.count,
                        questions: appSession.questions.count,
                        activeTasks: activeTasks.count
                    )

                    if needsActionCount > 0 {
                        TodaySectionHeader(
                            title: String(localized: "control.needs_you"),
                            subtitle: String(localized: "control.needs_you.subtitle"),
                            systemImage: "hand.tap"
                        )

                        VStack(spacing: 12) {
                            ForEach(appSession.approvals) { approval in
                                ApprovalCard(
                                    approval: approval,
                                    onDecision: { id, approved in
                                        if approved {
                                            try await appSession.approve(id: id)
                                        } else {
                                            try await appSession.deny(id: id)
                                        }
                                    }
                                )
                            }

                            ForEach(appSession.questions) { question in
                                QuestionCard(
                                    question: question,
                                    onAnswer: { id, selected, text in
                                        try await appSession.answerQuestion(id: id, selected: selected, otherText: text)
                                    }
                                )
                            }
                        }
                    }

                    if !activeTasks.isEmpty {
                        TodaySectionHeader(
                            title: String(localized: "control.running_work"),
                            subtitle: String(localized: "control.running_work.subtitle"),
                            systemImage: "dot.radiowaves.left.and.right"
                        )

                        VStack(spacing: 10) {
                            ForEach(activeTasks) { task in
                                NavigationLink(value: AppRoute.taskDetail(id: task.id)) {
                                    TaskRow(task: task)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }

                    if needsActionCount == 0 && activeTasks.isEmpty && !viewModel.isLoading {
                        EmptyTodayCard(profile: appSession.activeProfile)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 18)
                .padding(.bottom, 32)
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle(String(localized: "control.today"))
            .navigationBarTitleDisplayMode(.large)
            .navigationDestination(for: AppRoute.self) { route in
                switch route {
                case .taskDetail(let id):
                    TaskDetailView(taskId: id)
                case .newTask:
                    NewTaskView()
                case .settings:
                    SettingsView()
                case .connection:
                    ConnectionView { _, _ in }
                }
            }
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    NavigationLink(value: AppRoute.newTask) {
                        Label(String(localized: "task.create"), systemImage: "plus")
                    }
                }
            }
        }
    }

}

// MARK: - Task Row

private struct TaskRow: View {
    let task: KinTask

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(task.prompt)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(2)
                HStack(spacing: 8) {
                    statusBadge
                    Text(task.agent)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if let model = task.model {
                        Text(model)
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                }
            }

            Spacer()

            Image(systemName: "chevron.right")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .padding(14)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Color(.separator).opacity(0.22), lineWidth: 0.5)
        )
    }

    @ViewBuilder
    private var statusBadge: some View {
        switch task.status {
        case .running:
            Label(String(localized: "task.status.running"), systemImage: "play.fill")
                .font(.caption)
                .foregroundStyle(.blue)
        case .queued:
            Label(String(localized: "task.status.queued"), systemImage: "clock")
                .font(.caption)
                .foregroundStyle(.orange)
        case .waitingApproval:
            Label(String(localized: "task.status.approval"), systemImage: "hand.raised")
                .font(.caption)
                .foregroundStyle(.orange)
        case .waitingInput:
            Label(String(localized: "task.status.input"), systemImage: "text.bubble")
                .font(.caption)
                .foregroundStyle(.teal)
        case .paused:
            Label(String(localized: "task.status.paused"), systemImage: "pause.fill")
                .font(.caption)
                .foregroundStyle(.secondary)
        default:
            EmptyView()
        }
    }
}

private struct ActiveDesktopScopeCard: View {
    let profile: ServerProfile?
    let profiles: [ServerProfile]
    let connectionState: ConnectionState
    let onSelect: (ServerProfile) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(Color.accentColor.opacity(0.12))
                        .frame(width: 44, height: 44)
                    Image(systemName: "desktopcomputer")
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(Color.accentColor)
                }

                VStack(alignment: .leading, spacing: 5) {
                    Text(String(localized: "control.active_desktop"))
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .textCase(.uppercase)
                    Text(profile?.activeDesktopName ?? String(localized: "control.no_desktop"))
                        .font(.title3.weight(.semibold))
                        .lineLimit(1)
                    Text(scopeMessage)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .combine)

                Spacer(minLength: 8)

                ProfileSwitcherButton(
                    profile: profile,
                    profiles: profiles,
                    onSelect: onSelect
                )
            }

            HStack(spacing: 8) {
                StatusPill(label: statusText, color: statusColor, systemImage: statusIcon)
                if let profile {
                    StatusPill(
                        label: String(localized: String.LocalizationValue(profile.transport.localizationKey)),
                        color: .secondary,
                        systemImage: transportIcon(for: profile.transport)
                    )
                }
            }
        }
        .padding(16)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(Color(.separator).opacity(0.24), lineWidth: 0.5)
        )
    }

    private var scopeMessage: String {
        guard let profile else {
            return String(localized: "control.scope.unconfigured")
        }
        return String(
            format: String(localized: "control.scope.message_format"),
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

    private var statusIcon: String {
        switch connectionState {
        case .connected:
            return "checkmark.circle.fill"
        case .connecting, .reconnecting:
            return "arrow.triangle.2.circlepath"
        case .unconfigured:
            return "circle"
        case .offline:
            return "wifi.slash"
        case .unauthorized:
            return "lock.shield"
        case .incompatible:
            return "exclamationmark.triangle"
        }
    }

    private func transportIcon(for transport: ServerProfileTransport) -> String {
        switch transport {
        case .lanHTTP:
            return "network"
        case .httpsTunnel:
            return "lock"
        case .relay:
            return "point.3.connected.trianglepath.dotted"
        }
    }
}

private struct ProfileSwitcherButton: View {
    let profile: ServerProfile?
    let profiles: [ServerProfile]
    let onSelect: (ServerProfile) -> Void

    var body: some View {
        if profiles.count > 1 {
            Menu {
                ForEach(profiles) { candidate in
                    Button {
                        onSelect(candidate)
                    } label: {
                        Label(
                            candidate.activeDesktopName,
                            systemImage: candidate.id == profile?.id ? "checkmark.circle.fill" : "desktopcomputer"
                        )
                    }
                }
            } label: {
                Label(String(localized: "desktop.switch"), systemImage: "chevron.up.chevron.down")
                    .labelStyle(.iconOnly)
                    .font(.headline)
                    .frame(width: 36, height: 36)
                    .background(Color(.tertiarySystemGroupedBackground))
                    .clipShape(Circle())
            }
            .accessibilityLabel(String(localized: "desktop.switch"))
        }
    }
}

private struct TodaySummaryGrid: View {
    let approvals: Int
    let questions: Int
    let activeTasks: Int

    private let columns = [
        GridItem(.adaptive(minimum: 104), spacing: 10)
    ]

    var body: some View {
        LazyVGrid(columns: columns, spacing: 10) {
            SummaryTile(
                value: approvals,
                label: String(localized: "control.summary.approvals"),
                systemImage: "lock.shield",
                color: .orange
            )
            SummaryTile(
                value: questions,
                label: String(localized: "control.summary.questions"),
                systemImage: "questionmark.bubble",
                color: .blue
            )
            SummaryTile(
                value: activeTasks,
                label: String(localized: "control.summary.active"),
                systemImage: "play.circle",
                color: .teal
            )
        }
    }
}

private struct SummaryTile: View {
    let value: Int
    let label: String
    let systemImage: String
    let color: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: systemImage)
                    .foregroundStyle(color)
                Spacer()
                Text(value, format: .number)
                    .font(.title2.weight(.semibold))
                    .monospacedDigit()
            }
            Text(label)
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .minimumScaleFactor(0.85)
        }
        .padding(12)
        .frame(maxWidth: .infinity, minHeight: 86, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Color(.separator).opacity(0.2), lineWidth: 0.5)
        )
        .accessibilityElement(children: .combine)
    }
}

private struct TodaySectionHeader: View {
    let title: String
    let subtitle: String
    let systemImage: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: systemImage)
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.headline)
                Text(subtitle)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(.top, 2)
    }
}

private struct LoadingCard: View {
    var body: some View {
        HStack(spacing: 12) {
            ProgressView()
            Text(String(localized: "state.loading"))
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(16)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

private struct InlineErrorCard: View {
    let message: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.red)
            Text(message)
                .font(.callout)
                .foregroundStyle(.red)
                .fixedSize(horizontal: false, vertical: true)
            Spacer()
        }
        .padding(14)
        .background(Color.red.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

private struct EmptyTodayCard: View {
    let profile: ServerProfile?

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "checkmark.seal")
                .font(.system(size: 38, weight: .semibold))
                .foregroundStyle(.green)
            Text(String(localized: "control.empty.title"))
                .font(.headline)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 28)
        .padding(.horizontal, 18)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(Color(.separator).opacity(0.2), lineWidth: 0.5)
        )
    }

    private var message: String {
        guard let profile else {
            return String(localized: "control.empty.unconfigured")
        }
        return String(
            format: String(localized: "control.empty.message_format"),
            profile.activeDesktopName
        )
    }
}

private struct StatusPill: View {
    let label: String
    let color: Color
    let systemImage: String

    var body: some View {
        Label(label, systemImage: systemImage)
            .font(.caption.weight(.medium))
            .lineLimit(1)
            .padding(.horizontal, 9)
            .padding(.vertical, 6)
            .background(color.opacity(0.12))
            .foregroundStyle(color)
            .clipShape(Capsule())
    }
}

// MARK: - Previews

#if DEBUG
#Preview("Connected") {
    ControlView()
}

#Preview("Unconfigured") {
    ControlView()
}
#endif
