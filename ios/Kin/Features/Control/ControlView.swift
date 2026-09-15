import SwiftUI

/// Main control screen — the default app tab.
///
/// Adapts its content based on the current `connectionState`:
/// - `.unconfigured`: Shows `ConnectionView` to pair a daemon.
/// - `.connecting` / `.offline`: Shows loading or offline state with retry.
/// - `.connected`: Shows pending approvals, pending questions, and active tasks.
struct ControlView: View {
    @State private var viewModel = ControlViewModel()

    var body: some View {
        Group {
            switch viewModel.connectionState {
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
        .task {
            await viewModel.load()
        }
        .refreshable {
            await viewModel.load()
        }
    }

    // MARK: - Connection handling

    private func handleConnected(client: APIClient) {
        viewModel.configure(apiClient: client)
        Task {
            await viewModel.load()
        }
    }

    // MARK: - Connecting state

    private var connectingView: some View {
        VStack(spacing: 16) {
            ProgressView()
                .scaleEffect(1.2)
            Text("Connecting to Kin daemon...")
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
            Text("Reconnecting...")
                .font(.headline)
                .foregroundStyle(.secondary)
            if delay > 0 {
                Text("Next attempt in \(Int(delay))s")
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
            Text("Cannot Reach Daemon")
                .font(.headline)
            if let message = viewModel.error {
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            Button("Retry") {
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
            Text("Unauthorized")
                .font(.headline)
            Text("Your session has expired or the token is invalid.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button("Reconnect") {
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
            Text("Incompatible Version")
                .font(.headline)
            Text("The daemon version is not compatible with this app. Please update Kin.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button("Reconnect") {
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
        NavigationStack {
            List {
                if viewModel.isLoading && viewModel.approvals.isEmpty && viewModel.questions.isEmpty && viewModel.activeTasks.isEmpty {
                    Section {
                        HStack {
                            Spacer()
                            ProgressView()
                                .padding()
                            Spacer()
                        }
                    }
                }

                if let error = viewModel.error, !error.isEmpty {
                    Section {
                        HStack(spacing: 8) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .foregroundStyle(.red)
                            Text(error)
                                .font(.callout)
                                .foregroundStyle(.red)
                        }
                        .padding(.vertical, 4)
                    }
                }

                // Pending approvals
                if !viewModel.approvals.isEmpty {
                    Section("Pending Approvals") {
                        ForEach(viewModel.approvals) { approval in
                            ApprovalCard(
                                approval: approval,
                                onDecision: { id, approved in
                                    if approved {
                                        try await viewModel.approve(id: id)
                                    } else {
                                        try await viewModel.deny(id: id)
                                    }
                                }
                            )
                        }
                    }
                }

                // Pending questions
                if !viewModel.questions.isEmpty {
                    Section("Pending Questions") {
                        ForEach(viewModel.questions) { question in
                            QuestionCard(
                                question: question,
                                onAnswer: { id, selected, text in
                                    try await viewModel.answer(id: id, selected: selected, otherText: text)
                                }
                            )
                        }
                    }
                }

                // Active tasks
                if !viewModel.activeTasks.isEmpty {
                    Section("Active Tasks") {
                        ForEach(viewModel.activeTasks) { task in
                            NavigationLink(value: AppRoute.taskDetail(id: task.id)) {
                                TaskRow(task: task)
                            }
                        }
                    }
                }

                // Empty state
                if viewModel.approvals.isEmpty && viewModel.questions.isEmpty && viewModel.activeTasks.isEmpty && !viewModel.isLoading {
                    Section {
                        VStack(spacing: 12) {
                            Image(systemName: "checkmark.circle")
                                .font(.system(size: 40))
                                .foregroundStyle(.green)
                            Text("No Pending Actions")
                                .font(.headline)
                                .foregroundStyle(.secondary)
                            Text("All clear — the agent is idle or working quietly.")
                                .font(.subheadline)
                                .foregroundStyle(.tertiary)
                                .multilineTextAlignment(.center)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 24)
                    }
                }
            }
            .navigationTitle("Kin")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    NavigationLink(value: AppRoute.newTask) {
                        Image(systemName: "plus")
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
                    .font(.subheadline)
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
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private var statusBadge: some View {
        switch task.status {
        case .running:
            Label("Running", systemImage: "play.fill")
                .font(.caption)
                .foregroundStyle(.blue)
        case .queued:
            Label("Queued", systemImage: "clock")
                .font(.caption)
                .foregroundStyle(.orange)
        case .waitingApproval:
            Label("Approval", systemImage: "hand.raised")
                .font(.caption)
                .foregroundStyle(.purple)
        case .waitingInput:
            Label("Input", systemImage: "text.bubble")
                .font(.caption)
                .foregroundStyle(.teal)
        case .paused:
            Label("Paused", systemImage: "pause.fill")
                .font(.caption)
                .foregroundStyle(.secondary)
        default:
            EmptyView()
        }
    }
}

// MARK: - Previews

#if DEBUG
#Preview("Connected") {
    let vm = ControlViewModel()
    // Simulate connected state with sample data for preview
    ControlView()
}

#Preview("Unconfigured") {
    ControlView()
}
#endif