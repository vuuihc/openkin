import SwiftUI

/// Searchable task history list grouped by "Active" and "Completed".
struct TaskListView: View {
    @Environment(AppSession.self) private var appSession
    @State private var viewModel = TaskListViewModel()
    @State private var searchQuery = ""

    var body: some View {
        NavigationStack {
            Group {
                if viewModel.isLoading && !viewModel.hasLoadedOnce {
                    loadingView
                } else if let error = viewModel.error, !viewModel.hasLoadedOnce {
                    errorView(error)
                } else if filteredTasks.isEmpty && viewModel.hasLoadedOnce {
                    emptyView
                } else {
                    taskList
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
            await loadClientAndRefresh()
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

    private var taskList: some View {
        let display = filteredTasks
        let active = display.filter { !$0.isTerminal }
        let completed = display.filter { $0.isTerminal }

        return List {
            Section {
                WorkScopeHeader(
                    profile: appSession.activeProfile,
                    connectionState: appSession.connectionState,
                    visibleCount: display.count,
                    totalCount: appSession.tasks.count
                )
                .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                .listRowBackground(Color.clear)
            }

            if !active.isEmpty {
                Section(String(localized: "tasks.section.active")) {
                    ForEach(active) { task in
                        taskRow(task)
                    }
                }
            }

            if !completed.isEmpty {
                Section(String(localized: "tasks.section.completed")) {
                    ForEach(completed) { task in
                        taskRow(task)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    // MARK: - Row

    private func taskRow(_ task: KinTask) -> some View {
        NavigationLink(value: AppRoute.taskDetail(id: task.id)) {
            WorkTaskRow(task: task)
        }
    }

    // MARK: - Helpers

    private var filteredTasks: [KinTask] {
        TaskPresentation.filter(appSession.tasks, query: searchQuery)
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

    @MainActor
    private func loadClientAndRefresh() async {
        await refresh()
    }

    @MainActor
    private func refresh() async {
        guard let client = appSession.apiClient else { return }
        await viewModel.load(with: client)
    }

    @ViewBuilder
    private func destination(for route: AppRoute) -> some View {
        switch route {
        case .taskDetail(let id):
            TaskDetailView(taskId: id)
        case .newTask:
            NewTaskView()
        default:
            EmptyView()
        }
    }
}

private struct WorkScopeHeader: View {
    let profile: ServerProfile?
    let connectionState: ConnectionState
    let visibleCount: Int
    let totalCount: Int

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
                    Text(scopeMessage)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 8)
            }

            HStack(spacing: 8) {
                Label(statusText, systemImage: statusIcon)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(statusColor)
                Spacer()
                Text(countText)
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
        .accessibilityElement(children: .combine)
    }

    private var scopeMessage: String {
        guard let profile else {
            return String(localized: "tasks.scope.unconfigured")
        }
        return String(
            format: String(localized: "tasks.scope.message_format"),
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

    private var countText: String {
        if visibleCount == totalCount {
            return String(
                format: String(localized: "tasks.count_format"),
                totalCount
            )
        }
        return String(
            format: String(localized: "tasks.filtered_count_format"),
            visibleCount,
            totalCount
        )
    }
}

private struct WorkTaskRow: View {
    let task: KinTask

    private var summary: TaskPresentation.Summary {
        TaskPresentation.summary(for: task)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                StatusBadge(status: task.status)
                if summary.needsUserAction {
                    Image(systemName: "hand.tap.fill")
                        .font(.caption)
                        .foregroundStyle(.orange)
                        .accessibilityLabel(String(localized: "tasks.needs_action"))
                }
                Spacer(minLength: 8)
                Text(summary.elapsed)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .monospacedDigit()
            }

            Text(summary.title)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.primary)
                .lineLimit(2)

            Label(summary.location, systemImage: "folder")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)

            HStack(spacing: 8) {
                Label(summary.agentAndModel, systemImage: "person.crop.circle")
                    .lineLimit(1)
                Spacer(minLength: 8)
                Label(summary.cost, systemImage: "dollarsign")
                    .monospacedDigit()
            }
            .font(.caption)
            .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Previews

#Preview("Populated") {
    TaskListView()
}

#Preview("Empty") {
    TaskListView()
}
