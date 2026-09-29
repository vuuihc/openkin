import SwiftUI

/// The conversation list: every task is one chat, filed under the project it
/// belongs to. A project row opens to its sessions; a session opens the
/// conversation.
struct TaskListView: View {
    @Environment(AppSession.self) private var appSession
    @State private var viewModel = TaskListViewModel()
    @State private var searchQuery = ""
    @State private var listMode: ChatListMode = .recent
    @State private var expansionOverrides: [String: Bool] = [:]
    @State private var showConnection = false

    var body: some View {
        NavigationStack {
            Group {
                if appSession.apiClient == nil {
                    unpairedView
                } else if isInitialLoading {
                    loadingView
                } else if let error = blockingErrorMessage {
                    errorView(error)
                } else if sessions.isEmpty && appSession.lastSyncedAt != nil {
                    emptyView
                } else {
                    chatList
                }
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle(String(localized: "tasks.work"))
            .searchable(text: $searchQuery, prompt: String(localized: "tasks.search"))
            .refreshable {
                await refresh()
            }
            .navigationDestination(for: AppRoute.self) { route in
                destination(for: route)
            }
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    NavigationLink(value: AppRoute.newTask) {
                        Label(String(localized: "task.create"), systemImage: "plus")
                    }
                }
            }
        }
        .task(id: appSession.activeProfileID) {
            await refresh()
        }
        .sheet(isPresented: $showConnection) {
            // The Chats tab is where the app opens, so it is also where an app
            // with no desktop yet has to be able to pair one.
            ConnectionView { _, profile in
                showConnection = false
                appSession.refreshProfiles()
                appSession.activate(profile: profile)
                Task { await refresh() }
            }
        }
    }

    // MARK: - Content

    @ViewBuilder
    private var loadingView: some View {
        VStack(spacing: 16) {
            ProgressView()
                .scaleEffect(1.2)
            Text(String(localized: "tasks.loading"))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemGroupedBackground))
    }

    @ViewBuilder
    private func errorView(_ message: String) -> some View {
        ContentUnavailableView(
            label: {
                Label(String(localized: "tasks.error.title"), systemImage: "wifi.exclamationmark")
            },
            description: {
                Text(message)
            },
            actions: {
                Button(String(localized: "state.retry")) {
                    Task { await refresh() }
                }
                .buttonStyle(.borderedProminent)
            }
        )
    }

    private var emptyView: some View {
        ContentUnavailableView(
            label: {
                Label(String(localized: "state.empty_tasks"), systemImage: "tray")
            },
            description: {
                Text(emptyMessage)
            }
        )
        .background(Color(.systemGroupedBackground))
    }

    /// No daemon credential, so there is nothing to list and no point looking for
    /// chats. Chats is the tab the app opens on, which makes this the first thing
    /// a new install shows: it has to offer the pairing, not just report the
    /// absence of one.
    private var unpairedView: some View {
        ContentUnavailableView {
            Label(String(localized: "state.empty_tasks"), systemImage: "desktopcomputer")
        } description: {
            Text(String(localized: "tasks.empty.unconfigured"))
        } actions: {
            Button(String(localized: "chats.pair_desktop")) {
                showConnection = true
            }
            .buttonStyle(.borderedProminent)
        }
        .background(Color(.systemGroupedBackground))
    }

    private var chatList: some View {
        let projectTitles = projectTitlesByTaskID

        return List {
            Section {
                ChatsScopeHeader(
                    profile: appSession.activeProfile,
                    profiles: appSession.profiles,
                    connectionState: appSession.connectionState,
                    isSyncing: appSession.isSyncing,
                    lastSyncedAt: appSession.lastSyncedAt,
                    sessionCount: appSession.tasks.count,
                    onSelectProfile: activate,
                    onPair: { showConnection = true }
                )
                .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                .listRowBackground(Color.clear)
            }

            if isSearching {
                // A query is about finding one conversation, and a group holding
                // one of forty matches reads worse than the flat list it came from.
                Section {
                    ForEach(sessions) { session in
                        sessionRow(session, projectTitle: projectTitles[session.id])
                    }
                }
            } else {
                Section {
                    Picker(String(localized: "chats.view_mode"), selection: $listMode) {
                        ForEach(ChatListMode.allCases, id: \.self) { mode in
                            Text(mode.title).tag(mode)
                        }
                    }
                    .pickerStyle(.segmented)
                    .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 8, trailing: 16))
                    .listRowBackground(Color.clear)
                }

                switch listMode {
                case .recent:
                    Section(String(localized: "chats.section.recent")) {
                        ForEach(sessions) { session in
                            sessionRow(session, projectTitle: projectTitles[session.id])
                        }
                    }
                case .projects:
                    ForEach(groups) { group in
                        Section {
                            DisclosureGroup(isExpanded: expansionBinding(for: group)) {
                                ForEach(group.sessions) { session in
                                    sessionRow(session, projectTitle: group.isUnfiled ? nil : group.title)
                                }
                            } label: {
                                ProjectGroupRow(
                                    group: group,
                                    isExpanded: isExpanded(group),
                                    pendingAction: pendingAction(in: group)
                                )
                            }
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    // MARK: - Rows

    private func sessionRow(_ task: KinTask, projectTitle: String?) -> some View {
        NavigationLink(value: AppRoute.taskDetail(id: task.id)) {
            ChatRow(
                task: task,
                projectTitle: projectTitle,
                pendingAction: pendingAction(for: task.id)
            )
        }
    }

    // MARK: - Grouping

    private var groups: [ChatGroup] {
        TaskPresentation.chatGroups(tasks: appSession.tasks, projects: viewModel.projects)
    }

    private var projectTitlesByTaskID: [String: String] {
        var titles: [String: String] = [:]
        for group in groups where !group.isUnfiled {
            for session in group.sessions {
                titles[session.id] = group.title
            }
        }
        return titles
    }

    private func isExpanded(_ group: ChatGroup) -> Bool {
        if let chosen = expansionOverrides[group.id] { return chosen }
        // A collapsed group hides its sessions, and an approval waiting in there
        // is a run that is going nowhere until someone looks. Open those.
        return pendingAction(in: group) != nil
    }

    private func expansionBinding(for group: ChatGroup) -> Binding<Bool> {
        Binding(
            get: { isExpanded(group) },
            set: { expansionOverrides[group.id] = $0 }
        )
    }

    // MARK: - Pending work

    /// A conversation waiting on you, as the list marks it. Approvals and
    /// questions have no destination of their own any more, so this marker and
    /// the tab badge are how they stay findable.
    enum PendingAction: Equatable {
        case approval
        case question

        var icon: String {
            switch self {
            case .approval: return "hand.raised.fill"
            case .question: return "questionmark.bubble.fill"
            }
        }

        var color: Color {
            switch self {
            case .approval: return .orange
            case .question: return .blue
            }
        }

        var label: String {
            switch self {
            case .approval: return String(localized: "chats.row.pending_approval")
            case .question: return String(localized: "chats.row.pending_question")
            }
        }
    }

    private func pendingAction(for taskId: String) -> PendingAction? {
        if appSession.approvals.contains(where: { $0.taskId == taskId }) { return .approval }
        if appSession.questions.contains(where: { $0.taskId == taskId }) { return .question }
        return nil
    }

    private func pendingAction(in group: ChatGroup) -> PendingAction? {
        let pending = group.sessions.compactMap { pendingAction(for: $0.id) }
        if pending.contains(.approval) { return .approval }
        return pending.first
    }

    // MARK: - Helpers

    private var sessions: [KinTask] {
        TaskPresentation.filter(appSession.tasks, query: searchQuery)
    }

    private var isSearching: Bool {
        !searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var isInitialLoading: Bool {
        appSession.apiClient != nil
            && appSession.tasks.isEmpty
            && appSession.lastSyncedAt == nil
            && blockingErrorMessage == nil
    }

    private var blockingErrorMessage: String? {
        guard appSession.lastSyncedAt == nil, appSession.tasks.isEmpty else { return nil }
        switch appSession.connectionState {
        case .offline(let message):
            return message.isEmpty ? String(localized: "connection.state.offline") : message
        case .unauthorized:
            return String(localized: "connection.state.unauthorized")
        case .incompatible:
            return String(localized: "connection.state.incompatible")
        case .unconfigured, .connecting, .connected, .reconnecting:
            return nil
        }
    }

    private var emptyMessage: String {
        guard let profile = appSession.activeProfile else {
            return String(localized: "tasks.empty.unconfigured")
        }
        return String(
            format: String(localized: "tasks.empty.message_format"),
            profile.activeDesktopName
        )
    }

    private func activate(profile: ServerProfile) {
        appSession.activate(profile: profile)
        Task { await refresh() }
    }

    @MainActor
    private func refresh() async {
        let profileID = appSession.activeProfileID
        guard let client = appSession.apiClient else { return }
        await viewModel.loadProjects(with: client, profileID: profileID) {
            appSession.activeProfileID == profileID
        }
        await appSession.reconcileForeground()
    }

    @ViewBuilder
    private func destination(for route: AppRoute) -> some View {
        switch route {
        case .taskDetail(let id):
            TaskDetailView(taskId: id)
        case .newTask:
            NewTaskView()
        }
    }
}

private enum ChatListMode: CaseIterable {
    case recent
    case projects

    var title: String {
        switch self {
        case .recent:
            return String(localized: "chats.view.recent")
        case .projects:
            return String(localized: "chats.view.projects")
        }
    }
}

/// One row of context above the list: which desktop these conversations are on,
/// how that connection is doing, and how many there are.
private struct ChatsScopeHeader: View {
    let profile: ServerProfile?
    let profiles: [ServerProfile]
    let connectionState: ConnectionState
    let isSyncing: Bool
    let lastSyncedAt: Date?
    let sessionCount: Int
    let onSelectProfile: (ServerProfile) -> Void
    let onPair: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "desktopcomputer")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(Color.accentColor)
                    .frame(width: 36, height: 36)
                    .background(Color.accentColor.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))

                VStack(alignment: .leading, spacing: 3) {
                    Text(String(localized: "tasks.scope.title"))
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .textCase(.uppercase)
                    Text(profile?.activeDesktopName ?? String(localized: "control.no_desktop"))
                        .font(.headline)
                        .lineLimit(1)

                    if connectionState == .unconfigured {
                        Button(String(localized: "chats.pair_desktop")) {
                            onPair()
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                        .padding(.top, 2)
                    }
                }

                Spacer(minLength: 8)

                DesktopSwitcherButton(
                    profile: profile,
                    profiles: profiles,
                    onSelect: onSelectProfile
                )
            }

            HStack(spacing: 8) {
                Label(statusText, systemImage: statusIcon)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(statusColor)

                if let profile {
                    Text("·")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                    Label(
                        String(localized: String.LocalizationValue(profile.transport.localizationKey)),
                        systemImage: transportIcon(for: profile.transport)
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                }

                if isSyncing {
                    Text("·")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                    Label(String(localized: "tasks.scope.syncing"), systemImage: "arrow.triangle.2.circlepath")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                } else if let lastSyncedAt {
                    Text("·")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                    Label(
                        String(
                            format: String(localized: "tasks.scope.synced_format"),
                            lastSyncedAt.formatted(date: .omitted, time: .shortened)
                        ),
                        systemImage: "clock"
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                }

                Spacer()

                Text(
                    String(
                        format: String(localized: "tasks.count_format"),
                        sessionCount
                    )
                )
                .font(.caption)
                .foregroundStyle(.secondary)
                .monospacedDigit()
            }
        }
        .padding(14)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(Color(.separator).opacity(0.2), lineWidth: 0.5)
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

/// Switches which desktop the app talks to. Only worth offering when there is
/// more than one to switch between.
private struct DesktopSwitcherButton: View {
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

/// A project in the list: what it is, how much of it is running, and whether any
/// of it is waiting on you.
private struct ProjectGroupRow: View {
    let group: ChatGroup
    let isExpanded: Bool
    let pendingAction: TaskListView.PendingAction?

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)

                HStack(spacing: 6) {
                    Text(
                        String(
                            format: String(localized: "tasks.count_format"),
                            group.sessions.count
                        )
                    )
                    if group.runningCount > 0 {
                        Text("·")
                        Label("\(group.runningCount)", systemImage: "play.circle")
                            .labelStyle(.titleAndIcon)
                            .foregroundStyle(.blue)
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .monospacedDigit()
            }

            Spacer(minLength: 8)

            if let pendingAction {
                Image(systemName: pendingAction.icon)
                    .font(.caption)
                    .foregroundStyle(pendingAction.color)
                    .accessibilityLabel(pendingAction.label)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var title: String {
        group.isUnfiled ? String(localized: "chats.section.no_project") : group.title
    }
}

/// One conversation in the list: what it is about, who it runs with and where,
/// and how long it took. The status pill is reserved for conversations that are
/// still going or ended badly — a finished chat needs no badge saying it is
/// finished.
private struct ChatRow: View {
    let task: KinTask
    let projectTitle: String?
    let pendingAction: TaskListView.PendingAction?

    private var summary: TaskPresentation.Summary {
        TaskPresentation.summary(for: task)
    }

    private var showsStatusBadge: Bool {
        !task.isTerminal || task.status == .failed
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            statusGlyph
                .padding(.top, 2)

            VStack(alignment: .leading, spacing: 7) {
                Text(summary.title)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(2)

                HStack(spacing: 8) {
                    if let projectTitle {
                        Label(projectTitle, systemImage: "folder")
                            .lineLimit(1)
                    } else {
                        Label(TaskPresentation.lastPathSegment(summary.location), systemImage: "folder")
                            .lineLimit(1)
                    }
                    Text("·")
                    Text(summary.agentAndModel)
                        .lineLimit(1)
                }
                .font(.caption)
                .foregroundStyle(.secondary)

                if showsStatusBadge {
                    StatusBadge(status: task.status)
                }
            }

            Spacer(minLength: 8)

            VStack(alignment: .trailing, spacing: 5) {
                if let pendingAction {
                    Label(pendingAction.label, systemImage: pendingAction.icon)
                        .labelStyle(.iconOnly)
                        .font(.subheadline)
                        .foregroundStyle(pendingAction.color)
                }
                Text(TaskPresentation.lastActivityDate(for: task).formatted(date: .abbreviated, time: .shortened))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                Text(summary.elapsed)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .monospacedDigit()
                Text(summary.cost)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .monospacedDigit()
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }

    private var statusGlyph: some View {
        Image(systemName: glyphIcon)
            .font(.caption.weight(.bold))
            .foregroundStyle(glyphColor)
            .frame(width: 28, height: 28)
            .background(glyphColor.opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private var glyphIcon: String {
        if pendingAction != nil { return pendingAction?.icon ?? "hand.raised.fill" }
        switch task.status {
        case .running, .queued:
            return "play.fill"
        case .waitingApproval, .waitingInput:
            return "hand.tap.fill"
        case .failed:
            return "exclamationmark"
        case .cancelled:
            return "xmark"
        default:
            return "checkmark"
        }
    }

    private var glyphColor: Color {
        if let pendingAction { return pendingAction.color }
        switch task.status {
        case .running, .queued:
            return .blue
        case .waitingApproval, .waitingInput:
            return .orange
        case .failed, .cancelled:
            return .red
        default:
            return .green
        }
    }
}

// MARK: - Previews

#Preview("Chats") {
    TaskListView()
        .environment(AppSession())
}

#Preview("Empty") {
    TaskListView()
        .environment(AppSession())
}
