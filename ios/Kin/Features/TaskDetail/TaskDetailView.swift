import SwiftUI

/// Task detail screen with a live-updating event timeline and input controls.
struct TaskDetailView: View {
    let taskId: String
    var apiClient: APIClient?

    @State private var viewModel = TaskDetailViewModel()
    @State private var guidanceText = ""
    @State private var showWorkspaceChanges = false

    /// Timer-driven polling interval for non-terminal tasks (seconds).
    private let pollInterval: TimeInterval = 3

    var body: some View {
        VStack(spacing: 0) {
            // Header
            if let task = viewModel.task {
                header(task)
            }

            // Timeline
            if viewModel.isLoading && viewModel.events.isEmpty {
                Spacer()
                loadingIndicator
                Spacer()
            } else if let error = viewModel.error, viewModel.task == nil {
                Spacer()
                errorView(error)
                Spacer()
            } else if viewModel.events.isEmpty && viewModel.task != nil {
                Spacer()
                emptyTimeline
                Spacer()
            } else {
                timeline
            }

            // Bottom bar
            if let task = viewModel.task {
                if task.isTerminal {
                    terminalActions(task)
                } else {
                    inputBar(task)
                }
            }

            // Error banner
            if let error = viewModel.error, viewModel.task != nil {
                errorBanner(error)
            }
        }
        .navigationTitle("Task")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            guard let client = apiClient else { return }
            await viewModel.load(taskId: taskId, with: client)
        }
        .task {
            // Poll for new events while the task is not terminal
            guard let client = apiClient else { return }
            await pollLoop(client: client)
        }
        .sheet(isPresented: $showWorkspaceChanges) {
            WorkspaceChangesView(taskId: taskId, apiClient: apiClient)
        }
    }

    // MARK: - Header

    @ViewBuilder
    private func header(_ task: KinTask) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            // Status badge + agent
            HStack(spacing: 8) {
                StatusBadge(status: task.status)

                Text(task.agent)
                    .font(.subheadline)
                    .fontWeight(.medium)

                if let model = task.model {
                    Text(model)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Spacer()
            }

            // Cwd
            HStack(spacing: 4) {
                Image(systemName: "folder")
                    .foregroundStyle(.secondary)
                Text(task.cwd)
                    .lineLimit(1)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            // Meta row: elapsed + cost
            HStack(spacing: 16) {
                Label(EventProjection.formatElapsed(task.elapsedSeconds),
                      systemImage: "clock")
                    .font(.caption)
                    .foregroundStyle(.tertiary)

                Label(EventProjection.formatCost(task.costCents),
                      systemImage: "dollarsign")
                    .font(.caption)
                    .foregroundStyle(.tertiary)

                Spacer()
            }
        }
        .padding()
        .background(.background)
    }

    // MARK: - Timeline

    private var timeline: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(viewModel.events) { event in
                        let display = EventProjection.project(event)
                        eventRow(display)
                            .id(display.id)
                    }
                }
                .padding(.vertical, 8)
            }
            .onChange(of: viewModel.events.count) { _, _ in
                // Auto-scroll to the latest event
                if let last = viewModel.events.last {
                    let display = EventProjection.project(last)
                    withAnimation {
                        proxy.scrollTo(display.id, anchor: .bottom)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func eventRow(_ row: EventProjection.DisplayRow) -> some View {
        if row.isCollapsible {
            CollapsibleEventRow(row: row)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .top, spacing: 10) {
                    // Icon
                    Image(systemName: row.icon)
                        .foregroundStyle(row.iconColor)
                        .font(.body)
                        .frame(width: 22, height: 22)

                    // Content
                    VStack(alignment: .leading, spacing: 2) {
                        // Primary text
                        Text(row.primaryText)
                            .textSelection(.enabled)
                            .font(row.isUserMessage ? .body : .subheadline)
                            .foregroundStyle(row.isUserMessage ? .primary : .primary)

                        // Secondary text
                        if let secondary = row.secondaryText {
                            Text(secondary)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(3)
                        }

                        // Timestamp + level
                        HStack(spacing: 8) {
                            Text(EventProjection.formatTimestamp(row.timestamp))
                                .font(.caption2)
                                .foregroundStyle(.tertiary)

                            if let level = row.level {
                                Text(level)
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                                    .padding(.horizontal, 4)
                                    .padding(.vertical, 1)
                                    .background(.quaternary.opacity(0.5))
                                    .cornerRadius(3)
                            }
                        }
                        .padding(.top, 2)
                    }

                    Spacer()
                }
                .padding(.horizontal)
                .padding(.vertical, 6)

                Divider()
                    .padding(.leading, 42)
            }
            .background(row.isUserMessage ? Color(.systemGray6).opacity(0.5) : Color.clear)
        }
    }

    // MARK: - Collapsible event (reasoning, tool call)

    private struct CollapsibleEventRow: View {
        let row: EventProjection.DisplayRow
        @State private var isExpanded = false

        var body: some View {
            VStack(alignment: .leading, spacing: 0) {
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        isExpanded.toggle()
                    }
                } label: {
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: row.icon)
                            .foregroundStyle(row.iconColor)
                            .font(.body)
                            .frame(width: 22, height: 22)

                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 4) {
                                Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)

                                Text(row.primaryText)
                                    .font(.subheadline)
                                    .foregroundStyle(.primary)
                            }

                            if let secondary = row.secondaryText {
                                Text(secondary)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(isExpanded ? nil : 1)
                            }

                            Text(EventProjection.formatTimestamp(row.timestamp))
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                                .padding(.top, 2)
                        }

                        Spacer()
                    }
                    .padding(.horizontal)
                    .padding(.vertical, 6)
                }
                .buttonStyle(.plain)

                if isExpanded {
                    // Show full content when expanded
                    VStack(alignment: .leading, spacing: 4) {
                        if let content = row.rawContent {
                            expandedContent(content)
                        }
                    }
                    .padding(.horizontal)
                    .padding(.bottom, 8)
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }

                Divider()
                    .padding(.leading, 42)
            }
        }

        @ViewBuilder
        private func expandedContent(_ content: TaskEventContent) -> some View {
            switch content {
            case .reasoning(let text):
                Text(text)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .padding(.leading, 32)

            case .toolCall(_, _, let input, let output):
                VStack(alignment: .leading, spacing: 6) {
                    if let input {
                        LabeledContent("Input") {
                            Text(input)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .labeledContentStyle(.compact)
                    }

                    if let output {
                        LabeledContent("Output") {
                            Text(output)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .labeledContentStyle(.compact)
                    }
                }
                .padding(.leading, 32)

            default:
                EmptyView()
            }
        }
    }

    // MARK: - Input bar

    private func inputBar(_ task: KinTask) -> some View {
        VStack(spacing: 0) {
            Divider()

            HStack(spacing: 8) {
                TextField("Send guidance…", text: $guidanceText)
                    .textFieldStyle(.roundedBorder)
                    .disabled(viewModel.isSending)

                Button {
                    let message = guidanceText
                    guidanceText = ""
                    Task {
                        guard let client = apiClient else { return }
                        let success = await viewModel.sendGuidance(
                            taskId: taskId,
                            message: message,
                            with: client
                        )
                        if success {
                            // Poll for new events after sending
                            await viewModel.pollEvents(taskId: taskId, with: client)
                        }
                    }
                } label: {
                    if viewModel.isSending {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.title2)
                    }
                }
                .disabled(
                    guidanceText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    || viewModel.isSending
                )

                Button("Cancel") {
                    Task {
                        guard let client = apiClient else { return }
                        await viewModel.cancel(taskId: taskId, with: client)
                    }
                }
                .buttonStyle(.bordered)
                .tint(.red)
                .controlSize(.small)
            }
            .padding()
        }
        .background(.regularMaterial)
    }

    // MARK: - Terminal actions

    private func terminalActions(_ task: KinTask) -> some View {
        VStack(spacing: 0) {
            Divider()

            HStack(spacing: 16) {
                Spacer()

                Button {
                    Task {
                        guard let client = apiClient else { return }
                        _ = await viewModel.retry(taskId: taskId, with: client)
                    }
                } label: {
                    Label("Retry", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.bordered)
                .tint(.blue)

                Button {
                    // Follow-up: create a new task from this context
                    // Navigate to new task creation
                } label: {
                    Label("Follow up", systemImage: "arrowshape.turn.up.right")
                }
                .buttonStyle(.borderedProminent)

                Button {
                    showWorkspaceChanges = true
                } label: {
                    Label("Changes", systemImage: "doc.text")
                }
                .buttonStyle(.bordered)

                Spacer()
            }
            .padding()
        }
        .background(.regularMaterial)
    }

    // MARK: - Auxiliary views

    private var loadingIndicator: some View {
        VStack(spacing: 12) {
            ProgressView()
                .scaleEffect(1.2)
            Text("Loading task…")
                .foregroundStyle(.secondary)
        }
    }

    private func errorView(_ message: String) -> some View {
        ContentUnavailableView(
            label: {
                Label("Error", systemImage: "exclamationmark.triangle")
            },
            description: {
                Text(message)
            },
            actions: {
                Button("Retry") {
                    Task {
                        guard let client = apiClient else { return }
                        await viewModel.load(taskId: taskId, with: client)
                    }
                }
                .buttonStyle(.borderedProminent)
            }
        )
    }

    private var emptyTimeline: some View {
        ContentUnavailableView(
            label: {
                Label("No events", systemImage: "text.alignleft")
            },
            description: {
                Text("Events for this task haven't arrived yet.")
            }
        )
    }

    private func errorBanner(_ message: String) -> some View {
        HStack {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.white)
            Text(message)
                .font(.caption)
                .foregroundStyle(.white)
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Color.red)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }

    // MARK: - Polling

    /// Poll for new events every `pollInterval` seconds while the task is active.
    private func pollLoop(client: APIClient) async {
        while !Task.isCancelled {
            guard let task = viewModel.task, !task.isTerminal else { break }

            try? await Task.sleep(nanoseconds: UInt64(pollInterval * 1_000_000_000))

            await viewModel.pollEvents(taskId: taskId, with: client)
        }
    }
}

// MARK: - Compact LabeledContent style

private struct CompactLabeledContentStyle: LabeledContentStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(alignment: .top, spacing: 6) {
            configuration.label
                .font(.caption)
                .foregroundStyle(.tertiary)
                .frame(minWidth: 40, alignment: .leading)
            configuration.content
            Spacer()
        }
    }
}

extension LabeledContentStyle where Self == CompactLabeledContentStyle {
    fileprivate static var compact: CompactLabeledContentStyle { CompactLabeledContentStyle() }
}

// MARK: - Previews

#Preview {
    NavigationStack {
        TaskDetailView(taskId: "preview-task")
    }
}

#Preview("Loading") {
    TaskDetailView(taskId: "preview-task")
}