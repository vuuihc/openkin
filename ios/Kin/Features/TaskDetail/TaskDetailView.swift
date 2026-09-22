import SwiftUI

/// Task detail screen with a live-updating event timeline and input controls.
struct TaskDetailView: View {
    @Environment(AppSession.self) private var appSession
    @Environment(\.dismiss) private var dismiss
    let taskId: String
    var apiClient: APIClient?

    @State private var viewModel = TaskDetailViewModel()
    @State private var guidanceText = ""
    @State private var showWorkspaceChanges = false
    @State private var showForkTask = false
    @State private var showDeleteConfirmation = false
    @State private var boundProfileID: UUID?

    /// Timer-driven polling interval for non-terminal tasks (seconds).
    private let pollInterval: TimeInterval = 3

    private var activeClient: APIClient? {
        apiClient ?? appSession.apiClient
    }

    private var isCurrentProfileContext: Bool {
        TaskPresentation.isCurrentProfileContext(
            boundProfileID: boundProfileID,
            activeProfileID: appSession.activeProfileID
        )
    }

    private var scopedClient: APIClient? {
        isCurrentProfileContext ? activeClient : nil
    }

    private var canUseRemoteActions: Bool {
        scopedClient != nil
    }

    var body: some View {
        VStack(spacing: 0) {
            // Header
            if let task = viewModel.task {
                header(task)
            }

            if !isCurrentProfileContext {
                StaleTaskContextNotice(activeProfile: appSession.activeProfile) {
                    dismiss()
                }
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
        .navigationTitle(String(localized: "task.detail.title"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let task = viewModel.task, task.isTerminal {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button {
                            showForkTask = true
                        } label: {
                            Label(String(localized: "task.action.fork_task"), systemImage: "arrow.triangle.branch")
                        }
                        if appSession.canManageDaemon {
                            Button(role: .destructive) {
                                showDeleteConfirmation = true
                            } label: {
                                Label(String(localized: "task.action.delete_task"), systemImage: "trash")
                            }
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                    .disabled(!canUseRemoteActions)
                    .accessibilityLabel(String(localized: "task.actions"))
                }
            }
        }
        .task(id: appSession.activeProfileID) {
            bindProfileIfNeeded()
            guard let client = scopedClient else { return }
            await viewModel.load(taskId: taskId, with: client)
        }
        .task(id: appSession.activeProfileID) {
            // Poll for new events while the task is not terminal
            guard let client = scopedClient else { return }
            await pollLoop(client: client)
        }
        .onChange(of: appSession.tasks) { _, tasks in
            if let updated = tasks.first(where: { $0.id == taskId }) {
                viewModel.task = updated
            }
        }
        .onChange(of: appSession.activeProfileID) { _, _ in
            guidanceText = ""
            showWorkspaceChanges = false
            showForkTask = false
            showDeleteConfirmation = false
        }
        .sheet(isPresented: $showWorkspaceChanges) {
            WorkspaceChangesView(taskId: taskId, apiClient: scopedClient)
        }
        .sheet(isPresented: $showForkTask) {
            if let client = scopedClient {
                ForkTaskView(taskId: taskId, apiClient: client) { _ in
                    Task { await appSession.reconcileForeground() }
                }
            }
        }
        .confirmationDialog(
            String(localized: "task.delete.confirmation_title"),
            isPresented: $showDeleteConfirmation,
            titleVisibility: .visible
        ) {
            Button(String(localized: "task.action.delete"), role: .destructive) {
                Task {
                    guard let client = scopedClient else { return }
                    if await viewModel.delete(taskId: taskId, with: client) {
                        dismiss()
                    }
                }
            }
        }
    }

    // MARK: - Header

    @ViewBuilder
    private func header(_ task: KinTask) -> some View {
        let summary = TaskPresentation.summary(for: task)

        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                StatusBadge(status: task.status)

                Text(summary.agentAndModel)
                    .font(.subheadline)
                    .fontWeight(.medium)

                Spacer()
            }

            Text(summary.title)
                .font(.headline)
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 4) {
                Image(systemName: "folder")
                    .foregroundStyle(.secondary)
                Text(summary.location)
                    .lineLimit(1)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            HStack(spacing: 16) {
                Label(summary.elapsed,
                      systemImage: "clock")
                    .font(.caption)
                    .foregroundStyle(.tertiary)

                Label(summary.cost,
                      systemImage: "dollarsign")
                    .font(.caption)
                    .foregroundStyle(.tertiary)

                Spacer()
            }

            Divider()

            Label(scopeText, systemImage: "desktopcomputer")
                .font(.caption.weight(.medium))
                .foregroundStyle(isCurrentProfileContext ? Color.secondary : Color.orange)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)

            if let wait = viewModel.limitWait,
               wait.state == "waiting" || wait.state == "probing"
            {
                let retryText = String(localized: "task.automatic_retry")
                let attemptsText = String.localizedStringWithFormat(
                    String(
                        localized: "task.attempts_format",
                        defaultValue: "%lld attempt(s)",
                        comment: "Task detail: quota retry count"
                    ),
                    wait.attempts
                )
                Label(
                    "\(retryText) · \(attemptsText)",
                    systemImage: "arrow.clockwise.circle"
                )
                .font(.caption)
                .foregroundStyle(.orange)
            }
        }
        .padding()
        .background(.background)
    }

    private var scopeText: String {
        if !isCurrentProfileContext {
            return String(
                format: String(localized: "task.detail.stale_scope_format"),
                boundProfileName
            )
        }

        guard let profile = appSession.activeProfile else {
            return String(localized: "tasks.scope.unconfigured")
        }
        return String(
            format: String(localized: "task.detail.scope_format"),
            profile.activeDesktopName
        )
    }

    private var boundProfileName: String {
        guard let boundProfileID,
              let profile = appSession.profiles.first(where: { $0.id == boundProfileID })
        else {
            return String(localized: "control.no_desktop")
        }
        return profile.activeDesktopName
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
                        LabeledContent(String(localized: "event.tool.input")) {
                            Text(input)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .labeledContentStyle(.compact)
                    }

                    if let output {
                        LabeledContent(String(localized: "event.tool.output")) {
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
                TextField(String(localized: "task.guidance.placeholder"), text: $guidanceText)
                    .textFieldStyle(.roundedBorder)
                    .disabled(viewModel.isSending || !canUseRemoteActions)

                Button {
                    let message = guidanceText
                    guidanceText = ""
                    Task {
                        guard let client = scopedClient else { return }
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
                    || !canUseRemoteActions
                )

                Button(String(localized: "task.cancel")) {
                    Task {
                        guard let client = scopedClient else { return }
                        await viewModel.cancel(taskId: taskId, with: client)
                    }
                }
                .buttonStyle(.bordered)
                .tint(.red)
                .controlSize(.small)
                .disabled(!canUseRemoteActions)
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

                if task.status == .failed {
                    Button {
                        Task {
                            guard let client = scopedClient else { return }
                            await viewModel.continueAfterLimit(taskId: taskId, with: client)
                        }
                    } label: {
                        Label(String(localized: "task.action.continue"), systemImage: "play.fill")
                    }
                    .buttonStyle(.bordered)
                    .tint(.orange)
                    .disabled(!canUseRemoteActions)
                }

                Button {
                    Task {
                        guard let client = scopedClient else { return }
                        _ = await viewModel.retry(taskId: taskId, with: client)
                    }
                } label: {
                    Label(String(localized: "state.retry"), systemImage: "arrow.clockwise")
                }
                .buttonStyle(.bordered)
                .tint(.blue)
                .disabled(!canUseRemoteActions)

                Button {
                    showForkTask = true
                } label: {
                    Label(String(localized: "task.action.fork"), systemImage: "arrow.triangle.branch")
                }
                .buttonStyle(.borderedProminent)
                .disabled(!canUseRemoteActions)

                Button {
                    showWorkspaceChanges = true
                } label: {
                    Label(String(localized: "task.action.changes"), systemImage: "doc.text")
                }
                .buttonStyle(.bordered)
                .disabled(!canUseRemoteActions)

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
            Text(String(localized: "task.loading"))
                .foregroundStyle(.secondary)
        }
    }

    private func errorView(_ message: String) -> some View {
        ContentUnavailableView(
            label: {
                Label(String(localized: "state.error"), systemImage: "exclamationmark.triangle")
            },
            description: {
                Text(message)
            },
            actions: {
                Button(String(localized: "state.retry")) {
                    Task {
                        guard let client = scopedClient else { return }
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
                Label(String(localized: "task.events.empty.title"), systemImage: "text.alignleft")
            },
            description: {
                Text(String(localized: "task.events.empty.message"))
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
            guard isCurrentProfileContext else { return }
            guard viewModel.task != nil else {
                do {
                    try await Task.sleep(nanoseconds: 100_000_000)
                } catch {
                    return
                }
                continue
            }
            if let task = viewModel.task, task.isTerminal {
                do {
                    try await Task.sleep(nanoseconds: 5_000_000_000)
                } catch {
                    return
                }
                continue
            }

            do {
                try await Task.sleep(nanoseconds: UInt64(pollInterval * 1_000_000_000))
            } catch {
                return
            }

            guard isCurrentProfileContext, !Task.isCancelled else { return }
            await viewModel.pollEvents(taskId: taskId, with: client)
        }
    }

    private func bindProfileIfNeeded() {
        if boundProfileID == nil {
            boundProfileID = appSession.activeProfileID
        }
    }
}

private struct StaleTaskContextNotice: View {
    let activeProfile: ServerProfile?
    let onReturn: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(String(localized: "task.detail.stale.title"), systemImage: "exclamationmark.triangle.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.orange)

            Text(message)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            Button {
                onReturn()
            } label: {
                Label(String(localized: "task.detail.return_to_work"), systemImage: "arrow.backward")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color.orange.opacity(0.1))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Color.orange.opacity(0.28), lineWidth: 0.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
    }

    private var message: String {
        let name = activeProfile?.activeDesktopName ?? String(localized: "control.no_desktop")
        return String(
            format: String(localized: "task.detail.stale.message_format"),
            name
        )
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
