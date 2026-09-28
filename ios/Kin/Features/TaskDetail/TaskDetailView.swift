import SwiftUI

/// Conversation screen: the task's transcript as a chat, with a composer that
/// keeps the same task going, and its details one tap away.
struct TaskDetailView: View {
    @Environment(AppSession.self) private var appSession
    @Environment(\.dismiss) private var dismiss
    let taskId: String
    var apiClient: APIClient?

    @State private var viewModel = TaskDetailViewModel()
    @State private var composerText = ""
    @State private var showInfo = false
    @State private var deletedConversation = false
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
            if let task = viewModel.task {
                statusStrip(task)
            }

            if !isCurrentProfileContext {
                StaleTaskContextNotice(activeProfile: appSession.activeProfile) {
                    dismiss()
                }
            }

            // Transcript
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
                emptyTranscript
                Spacer()
            } else {
                transcript
            }

            // Approvals and questions block the run they belong to. They sit
            // against the composer rather than at their seq inside the transcript
            // — the run can be hundreds of rows back, and the composer is where
            // the reader already is.
            attention

            // Composer. Both cases continue this same task: a running one is
            // guided (and interrupted), a finished one is followed up on.
            if let task = viewModel.task {
                composer(task)
            }

            // Error banner
            if let error = viewModel.error, viewModel.task != nil {
                errorBanner(error)
            }
        }
        .navigationTitle(chatTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showInfo = true
                } label: {
                    Image(systemName: "info.circle")
                }
                // Readable even when the profile went stale: the sheet says what
                // this conversation was and which desktop it belongs to. Its
                // actions are the part that needs a live connection.
                .accessibilityLabel(String(localized: "chat.info.title"))
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
        .onChange(of: appSession.tasks) { previous, tasks in
            if let updated = tasks.first(where: { $0.id == taskId }) {
                viewModel.task = updated
            } else if previous.contains(where: { $0.id == taskId }), !tasks.isEmpty {
                // Another client deleted this conversation. Its events are gone
                // with it, so staying would mean polling a 404 forever. The
                // non-empty guard is what keeps a profile switch — which empties
                // the snapshot before refilling it — from closing the screen.
                dismiss()
            }
        }
        .onChange(of: appSession.activeProfileID) { _, _ in
            composerText = ""
            showInfo = false
            deletedConversation = false
            showWorkspaceChanges = false
            showForkTask = false
            showDeleteConfirmation = false
        }
        .sheet(isPresented: $showInfo, onDismiss: {
            // Deleting is the one info-sheet action that has to close the
            // conversation as well, or the screen would sit there polling a task
            // that no longer exists. The dismissal waits for the sheet to finish
            // closing: SwiftUI drops a pop that happens underneath a presented
            // sheet.
            if deletedConversation { dismiss() }
        }) {
            if let task = viewModel.task {
                chatInfo(task)
            }
        }
    }

    // MARK: - Header

    /// The conversation's name: the task's prompt, as a chat list would show it.
    private var chatTitle: String {
        guard let task = viewModel.task else {
            return String(localized: "task.detail.title")
        }
        let title = TaskPresentation.summary(for: task).title
        return title.isEmpty ? String(localized: "task.detail.title") : title
    }

    /// One line of context above the transcript — what this conversation is doing
    /// right now. The rest of what used to sit here belongs to the info sheet:
    /// a chat keeps its metadata behind an (i), not above the messages.
    @ViewBuilder
    private func statusStrip(_ task: KinTask) -> some View {
        let summary = TaskPresentation.summary(for: task)

        VStack(spacing: 8) {
            HStack(spacing: 8) {
                StatusBadge(status: task.status)

                Text(summary.agentAndModel)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)

                Spacer(minLength: 8)

                if summary.needsUserAction {
                    Label(String(localized: "tasks.needs_action"), systemImage: "hand.tap.fill")
                        .font(.caption2)
                        .foregroundStyle(.orange)
                }

                Text(summary.elapsed)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .monospacedDigit()
            }

            Divider()
        }
        .padding(.horizontal)
        .padding(.top, 8)
        .background(.background)
    }

    // MARK: - Info sheet

    /// What the conversation is, where it runs, what it costs, and the actions on
    /// it — the part of a task that is not the transcript.
    @ViewBuilder
    private func chatInfo(_ task: KinTask) -> some View {
        let summary = TaskPresentation.summary(for: task)

        NavigationStack {
            List {
                Section {
                    // The whole opening prompt: the chat title carries only its
                    // first line. Attachment blocks keep their file names but lose
                    // the local paths, which are for the agent and not the reader.
                    Text(TaskPresentation.displayUserPrompt(task.prompt))
                        .font(.subheadline.weight(.medium))
                        .fixedSize(horizontal: false, vertical: true)

                    LabeledContent(String(localized: "settings.status")) {
                        StatusBadge(status: task.status)
                    }

                    LabeledContent {
                        Text(summary.agentAndModel)
                    } label: {
                        Text(String(localized: "task.new.config.agent"))
                    }

                    HStack(spacing: 4) {
                        Image(systemName: "folder")
                        Text(summary.location).lineLimit(1)
                    }
                    .font(.subheadline)
                    .foregroundStyle(.secondary)

                    HStack(spacing: 16) {
                        Label(summary.elapsed, systemImage: "clock")
                        Label(summary.cost, systemImage: "dollarsign")
                        Spacer()
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()

                    Label(scopeText, systemImage: "desktopcomputer")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(isCurrentProfileContext ? Color.secondary : Color.orange)
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

                Section {
                    Button {
                        showWorkspaceChanges = true
                    } label: {
                        Label(String(localized: "task.action.changes"), systemImage: "doc.text")
                    }

                    Button {
                        showForkTask = true
                    } label: {
                        Label(String(localized: "task.action.fork"), systemImage: "arrow.triangle.branch")
                    }

                    Button {
                        Task {
                            guard let client = scopedClient else { return }
                            _ = await viewModel.retry(taskId: taskId, with: client)
                        }
                    } label: {
                        Label(String(localized: "state.retry"), systemImage: "arrow.clockwise")
                    }

                    if task.status == .failed {
                        Button {
                            Task {
                                guard let client = scopedClient else { return }
                                await viewModel.continueAfterLimit(taskId: taskId, with: client)
                            }
                        } label: {
                            Label(String(localized: "task.action.continue"), systemImage: "play.fill")
                        }
                        .tint(.orange)
                    }

                    if task.isTerminal {
                        if appSession.canManageDaemon {
                            Button(role: .destructive) {
                                showDeleteConfirmation = true
                            } label: {
                                Label(String(localized: "task.action.delete_task"), systemImage: "trash")
                            }
                        }
                    } else {
                        Button(role: .destructive) {
                            Task {
                                guard let client = scopedClient else { return }
                                await viewModel.cancel(taskId: taskId, with: client)
                            }
                        } label: {
                            Label(String(localized: "task.cancel"), systemImage: "stop.circle")
                        }
                    }
                }
                .disabled(!canUseRemoteActions)
            }
            .navigationTitle(String(localized: "chat.info.title"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "action.cancel")) {
                        showInfo = false
                    }
                }
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
                            deletedConversation = true
                            showInfo = false
                        }
                    }
                }
            }
        }
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

    // MARK: - Transcript

    private var transcript: some View {
        let rows = EventProjection.rows(from: viewModel.events)
        return ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(rows) { row in
                        transcriptRow(row)
                            .id(row.id)
                    }
                }
                .padding(.vertical, 8)
            }
            .onChange(of: viewModel.events.count) { _, _ in
                // Auto-scroll to the latest row. Project again rather than reusing
                // the rows above: the event that just arrived may have been folded
                // into the open stream, leaving the row list unchanged.
                if let last = EventProjection.rows(from: viewModel.events).last {
                    withAnimation {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func transcriptRow(_ row: EventProjection.DisplayRow) -> some View {
        switch row.style {
        case .user:
            bubble(row, fromUser: true)
        case .agent:
            bubble(row, fromUser: false)
        case .notice:
            noticeRow(row)
        }
    }

    /// A turn in the conversation: yours on the trailing edge, an agent's on the
    /// leading edge with the speaker named above it.
    private func bubble(_ row: EventProjection.DisplayRow, fromUser: Bool) -> some View {
        HStack(spacing: 0) {
            if fromUser { Spacer(minLength: 48) }

            VStack(alignment: fromUser ? .trailing : .leading, spacing: 3) {
                if !fromUser {
                    Text(speakerName(row.speaker))
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .padding(.leading, 6)
                }

                Text(row.primaryText)
                    .textSelection(.enabled)
                    .font(.body)
                    .foregroundStyle(.primary)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(
                        fromUser ? Color.accentColor.opacity(0.16) : Color(.secondarySystemBackground),
                        in: RoundedRectangle(cornerRadius: 16, style: .continuous)
                    )

                Text(EventProjection.formatTimestamp(row.timestamp))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .padding(.horizontal, 6)
            }

            if !fromUser { Spacer(minLength: 48) }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
        // Speaker, text and time are one turn to a reader, so they read as one
        // stop rather than three.
        .accessibilityElement(children: .combine)
    }

    /// The name above an agent's bubble. Rows the daemon stamps only with a role
    /// arrive as "assistant"; the rest name the worker that produced the turn.
    private func speakerName(_ speaker: String?) -> String {
        guard let speaker, !speaker.isEmpty, speaker != "assistant" else {
            return String(localized: "chat.assistant")
        }
        return speaker
    }

    /// Tool work, errors, approvals and the like: part of the transcript without
    /// being a turn, so they keep the compact row they always had.
    @ViewBuilder
    private func noticeRow(_ row: EventProjection.DisplayRow) -> some View {
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
                            .font(.subheadline)
                            .foregroundStyle(.primary)

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

    // MARK: - Composer

    /// The conversation's pending approvals and questions, actioned from inside
    /// the chat. It is a projection of the app's live collections, so a decision
    /// made here — or on another device — clears the card without any local
    /// bookkeeping. A stale profile shows nothing: the actions would go to the
    /// wrong daemon.
    @ViewBuilder
    private var attention: some View {
        let approvals = appSession.approvals.filter { $0.taskId == taskId }
        let questions = appSession.questions.filter { $0.taskId == taskId }

        if isCurrentProfileContext && !(approvals.isEmpty && questions.isEmpty) {
            VStack(alignment: .leading, spacing: 10) {
                Label(String(localized: "chat.pending.title"), systemImage: "hand.tap.fill")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.orange)

                ScrollView {
                    VStack(spacing: 10) {
                        ForEach(approvals) { approval in
                            ApprovalCard(approval: approval) { id, approved in
                                if approved {
                                    try await appSession.approve(id: id)
                                } else {
                                    try await appSession.deny(id: id)
                                }
                            }
                        }

                        ForEach(questions) { question in
                            QuestionCard(question: question) { id, selected, text in
                                try await appSession.answerQuestion(id: id, selected: selected, otherText: text)
                            }
                        }
                    }
                }
                // Several at once must not push the conversation off the screen,
                // and the ones below the fold have to look reachable.
                .frame(maxHeight: 300)
                .scrollIndicators(.visible)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(Color.orange.opacity(0.08))
        }
    }

    /// The message box. Sending into a running task guides it — the daemon
    /// interrupts the current run and re-queues it with this message — and
    /// sending into a finished one continues it. Both go to the same endpoint and
    /// extend the same conversation, which is why there is no separate "new task"
    /// button beside a finished one.
    private func composer(_ task: KinTask) -> some View {
        let canSend = canUseRemoteActions
            && !viewModel.isSending
            && !composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty

        return VStack(spacing: 0) {
            Divider()

            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .bottom, spacing: 8) {
                    TextField(
                        task.isTerminal
                            ? String(localized: "chat.composer.placeholder")
                            : String(localized: "task.guidance.placeholder"),
                        text: $composerText,
                        axis: .vertical
                    )
                    .lineLimit(1...6)
                    .textFieldStyle(.plain)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(
                        Color(.secondarySystemBackground),
                        in: RoundedRectangle(cornerRadius: 18, style: .continuous)
                    )
                    .disabled(viewModel.isSending || !canUseRemoteActions)

                    Button {
                        send()
                    } label: {
                        if viewModel.isSending {
                            ProgressView()
                                .controlSize(.small)
                        } else {
                            Image(systemName: "arrow.up.circle.fill")
                                .font(.title2)
                        }
                    }
                    .disabled(!canSend)
                    .accessibilityLabel(String(localized: "chat.send"))
                }

                if !task.isTerminal {
                    Text(String(localized: "chat.composer.interrupt_hint"))
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .padding(.leading, 12)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
        .background(.regularMaterial)
    }

    private func send() {
        let message = composerText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty else { return }
        composerText = ""
        Task {
            guard let client = scopedClient else { return }
            let sent = await viewModel.sendMessage(taskId: taskId, message: message, with: client)
            if sent {
                await viewModel.pollEvents(taskId: taskId, with: client)
            } else if composerText.isEmpty {
                // Sending failed (the banner above says why). Give the text back
                // rather than losing what was typed — unless something new has
                // been typed in the meantime.
                composerText = message
            }
        }
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

    private var emptyTranscript: some View {
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
