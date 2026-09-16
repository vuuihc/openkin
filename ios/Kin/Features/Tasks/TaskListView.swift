import SwiftUI

/// Searchable task history list grouped by "Active" and "Completed".
struct TaskListView: View {
    @Environment(AppSession.self) private var appSession
    @State private var viewModel = TaskListViewModel()
    @State private var searchQuery = ""

    var body: some View {
        NavigationStack {
            ZStack {
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
            .navigationTitle("Tasks")
            .searchable(text: $searchQuery, prompt: "Search tasks")
            .refreshable {
                await refresh()
            }
            .navigationDestination(for: AppRoute.self) { route in
                destination(for: route)
            }
        }
        .task {
            await loadClientAndRefresh()
        }
    }

    // MARK: - Content

    @ViewBuilder
    private var loadingView: some View {
        VStack(spacing: 16) {
            ProgressView()
                .scaleEffect(1.2)
            Text("Loading tasks…")
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private func errorView(_ message: String) -> some View {
        ContentUnavailableView(
            label: {
                Label("Connection Issue", systemImage: "wifi.exclamationmark")
            },
            description: {
                Text(message)
            },
            actions: {
                Button("Retry") {
                    Task { await refresh() }
                }
                .buttonStyle(.borderedProminent)
            }
        )
    }

    private var emptyView: some View {
        ContentUnavailableView(
            label: {
                Label("No tasks yet", systemImage: "tray")
            },
            description: {
                Text("Tasks created by the Kin agent will appear here.")
            }
        )
    }

    private var taskList: some View {
        let display = filteredTasks
        let active = display.filter { !$0.isTerminal }
        let completed = display.filter { $0.isTerminal }

        return List {
            if !active.isEmpty {
                Section("Active") {
                    ForEach(active) { task in
                        taskRow(task)
                    }
                }
            }

            if !completed.isEmpty {
                Section("Completed") {
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
            VStack(alignment: .leading, spacing: 6) {
                // Prompt (first line)
                Text(task.prompt)
                    .lineLimit(2)
                    .font(.body)
                    .foregroundStyle(.primary)

                // Cwd subtitle
                Text(task.cwd)
                    .lineLimit(1)
                    .font(.caption)
                    .foregroundStyle(.secondary)

                // Meta row: badge + agent + elapsed
                HStack(spacing: 8) {
                    StatusBadge(status: task.status)

                    Text(task.agent)
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    if let elapsed = task.elapsedSeconds {
                        Text(EventProjection.formatElapsed(elapsed))
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }

                    Spacer()
                }
            }
            .padding(.vertical, 4)
        }
    }

    // MARK: - Helpers

    private var filteredTasks: [KinTask] {
        let tasks = appSession.tasks
        guard !searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return tasks
        }
        let query = searchQuery.lowercased()
        return tasks.filter {
            $0.prompt.lowercased().contains(query)
                || $0.cwd.lowercased().contains(query)
                || $0.agent.lowercased().contains(query)
        }
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
        default:
            EmptyView()
        }
    }
}

// MARK: - Previews

#Preview("Populated") {
    TaskListView()
}

#Preview("Empty") {
    TaskListView()
}
