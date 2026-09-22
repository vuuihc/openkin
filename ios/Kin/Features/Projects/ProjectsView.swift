import SwiftUI

struct ProjectsView: View {
    @Environment(AppSession.self) private var appSession
    @State private var projects: [Project] = []
    @State private var pulsesByProjectID: [String: ProjectPulse] = [:]
    @State private var loadedProfileID: UUID?
    @State private var isLoading = false
    @State private var error: String?
    @State private var showingNewProject = false

    var body: some View {
        NavigationStack {
            Group {
                if isLoading && projects.isEmpty {
                    loadingView
                } else if let error, projects.isEmpty {
                    errorView(error)
                } else if projects.isEmpty {
                    emptyView
                } else {
                    projectList
                }
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle(String(localized: "projects.tab"))
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    HStack {
                        if appSession.canManageDaemon {
                            Button {
                                showingNewProject = true
                            } label: {
                                Image(systemName: "plus")
                            }
                            .accessibilityLabel(String(localized: "projects.new.accessibility"))
                        }
                        Button {
                            Task { await load() }
                        } label: {
                            Image(systemName: "arrow.clockwise")
                        }
                        .accessibilityLabel(String(localized: "projects.refresh"))
                    }
                }
            }
            .refreshable { await load() }
        }
        .task(id: appSession.activeProfileID) {
            await load()
        }
        .sheet(isPresented: $showingNewProject) {
            NewProjectView(boundProfileID: appSession.activeProfileID) {
                await load()
            }
        }
    }

    // MARK: - Content

    private var loadingView: some View {
        VStack(spacing: 16) {
            ProgressView()
                .scaleEffect(1.2)
            Text(String(localized: "projects.loading"))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemGroupedBackground))
    }

    private func errorView(_ message: String) -> some View {
        ContentUnavailableView(
            label: {
                Label(String(localized: "projects.error.title"), systemImage: "folder.badge.questionmark")
            },
            description: {
                Text(message)
            },
            actions: {
                Button(String(localized: "state.retry")) {
                    Task { await load() }
                }
                .buttonStyle(.borderedProminent)
            }
        )
    }

    private var emptyView: some View {
        ContentUnavailableView(
            label: {
                Label(String(localized: "projects.empty.title"), systemImage: "folder")
            },
            description: {
                Text(emptyMessage)
            }
        )
        .background(Color(.systemGroupedBackground))
    }

    private var projectList: some View {
        List {
            Section {
                ProjectsScopeHeader(
                    profile: appSession.activeProfile,
                    connectionState: appSession.connectionState,
                    count: projects.count
                )
                .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                .listRowBackground(Color.clear)
            }

            Section(String(localized: "projects.section.active")) {
                ForEach(projects) { project in
                    NavigationLink {
                        ProjectDetailView(project: project, boundProfileID: appSession.activeProfileID)
                    } label: {
                        ProjectRow(project: project, pulse: pulsesByProjectID[project.id])
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    // MARK: - Loading

    private func load() async {
        let requestedProfileID = appSession.activeProfileID
        guard let requestedProfileID, let client = appSession.apiClient else {
            loadedProfileID = requestedProfileID
            projects = []
            pulsesByProjectID = [:]
            error = nil
            return
        }

        if loadedProfileID != requestedProfileID {
            projects = []
            pulsesByProjectID = [:]
        }

        isLoading = true
        defer { isLoading = false }

        do {
            let nextProjects = try await client.projects()
            guard appSession.activeProfileID == requestedProfileID else { return }
            projects = nextProjects
            pulsesByProjectID = [:]
            loadedProfileID = requestedProfileID
            error = nil

            for project in nextProjects {
                guard appSession.activeProfileID == requestedProfileID else { return }
                if let pulse = try? await client.projectPulse(projectId: project.id) {
                    guard appSession.activeProfileID == requestedProfileID else { return }
                    pulsesByProjectID[project.id] = pulse
                }
            }
        } catch {
            guard appSession.activeProfileID == requestedProfileID else { return }
            self.error = error.localizedDescription
        }
    }

    private var emptyMessage: String {
        guard let profile = appSession.activeProfile else {
            return String(localized: "projects.empty.unconfigured")
        }
        return String(
            format: String(localized: "projects.empty.message_format"),
            profile.activeDesktopName
        )
    }
}

private struct NewProjectView: View {
    @Environment(AppSession.self) private var appSession
    @Environment(\.dismiss) private var dismiss
    let boundProfileID: UUID?
    let onSaved: () async -> Void
    @State private var name = ""
    @State private var mode = "ship"
    @State private var root = ""
    @State private var error: String?
    @State private var isSaving = false

    private var isCurrentProfileContext: Bool {
        TaskPresentation.isCurrentProfileContext(
            boundProfileID: boundProfileID,
            activeProfileID: appSession.activeProfileID
        )
    }

    private var targetName: String {
        appSession.activeProfile?.activeDesktopName ?? String(localized: "control.no_desktop")
    }

    private var canSave: Bool {
        !isSaving
            && isCurrentProfileContext
            && appSession.canManageDaemon
            && !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !root.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Label(targetMessage, systemImage: isCurrentProfileContext ? "desktopcomputer" : "exclamationmark.triangle")
                        .foregroundStyle(isCurrentProfileContext ? Color.secondary : Color.orange)
                        .font(.footnote)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Section(String(localized: "projects.new.section.details")) {
                    TextField(String(localized: "projects.new.name"), text: $name)
                    TextField(String(localized: "projects.new.root"), text: $root)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Picker(String(localized: "projects.new.mode"), selection: $mode) {
                        Text(String(localized: "projects.mode.ship")).tag("ship")
                        Text(String(localized: "projects.mode.learn")).tag("learn")
                        Text(String(localized: "projects.mode.explore")).tag("explore")
                        Text(String(localized: "projects.mode.maintain")).tag("maintain")
                    }
                }

                if let error {
                    Section {
                        Text(error)
                            .foregroundStyle(.red)
                    }
                }

                Section {
                    Button {
                        Task { await save() }
                    } label: {
                        HStack {
                            Spacer()
                            if isSaving {
                                ProgressView()
                            } else {
                                Text(saveTitle)
                            }
                            Spacer()
                        }
                    }
                    .disabled(!canSave)
                }
            }
            .navigationTitle(String(localized: "projects.new.title"))
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(String(localized: "action.cancel")) { dismiss() }
                }
            }
        }
    }

    private var targetMessage: String {
        if !isCurrentProfileContext {
            return String(localized: "projects.new.stale")
        }
        return String(
            format: String(localized: "projects.new.target_format"),
            targetName
        )
    }

    private var saveTitle: String {
        String(
            format: String(localized: "projects.new.create_format"),
            targetName
        )
    }

    private func save() async {
        guard isCurrentProfileContext else {
            error = String(localized: "projects.new.stale")
            return
        }
        guard let client = appSession.apiClient, appSession.canManageDaemon else {
            error = String(localized: "projects.read_only")
            return
        }

        isSaving = true
        defer { isSaving = false }
        do {
            _ = try await client.createProject(
                name: name.trimmingCharacters(in: .whitespacesAndNewlines),
                mode: mode,
                roots: [root.trimmingCharacters(in: .whitespacesAndNewlines)]
            )
            await onSaved()
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct ProjectDetailView: View {
    @Environment(AppSession.self) private var appSession
    @Environment(\.dismiss) private var dismiss
    let project: Project
    let boundProfileID: UUID?

    @State private var onePager: OnePager?
    @State private var projectTasks: [KinTask] = []
    @State private var pulse: ProjectPulse?
    @State private var isLoading = true
    @State private var isEditing = false
    @State private var draft = ""
    @State private var isSaving = false
    @State private var error: String?

    private var isCurrentProfileContext: Bool {
        TaskPresentation.isCurrentProfileContext(
            boundProfileID: boundProfileID,
            activeProfileID: appSession.activeProfileID
        )
    }

    private var summary: ProjectPresentation.Summary {
        ProjectPresentation.summary(for: project, pulse: pulse)
    }

    private var focus: ProjectPresentation.OnePagerFocus {
        ProjectPresentation.onePagerFocus(for: onePager)
    }

    var body: some View {
        List {
            if !isCurrentProfileContext {
                ProjectStaleScopeCard(
                    activeProfile: appSession.activeProfile,
                    onReturn: { dismiss() }
                )
                .listRowBackground(Color.clear)
            }

            if let error {
                Text(error)
                    .foregroundStyle(.red)
            }

            Section {
                ProjectDetailSummaryCard(project: project, summary: summary)
                    .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                    .listRowBackground(Color.clear)
            }

            if let pulse {
                Section(String(localized: "projects.detail.pulse")) {
                    ProjectPulseGrid(pulse: pulse)
                }
            }

            Section(String(localized: "projects.one_pager")) {
                if isLoading && onePager == nil {
                    HStack(spacing: 12) {
                        ProgressView()
                        Text(String(localized: "projects.one_pager.loading"))
                            .foregroundStyle(.secondary)
                    }
                } else if isEditing {
                    TextEditor(text: $draft)
                        .font(.body)
                        .frame(minHeight: 280)
                    Button {
                        Task { await save() }
                    } label: {
                        HStack {
                            Spacer()
                            if isSaving {
                                ProgressView()
                            } else {
                                Text(saveOnePagerTitle)
                            }
                            Spacer()
                        }
                    }
                    .disabled(isSaving || !isCurrentProfileContext)
                } else {
                    OnePagerReadView(onePager: onePager, focus: focus)

                    if appSession.canManageDaemon && isCurrentProfileContext {
                        Button(String(localized: "projects.one_pager.edit")) {
                            draft = onePager?.markdown ?? ""
                            isEditing = true
                        }
                    } else {
                        Text(readOnlyMessage)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            if !projectTasks.isEmpty && isCurrentProfileContext {
                Section(String(localized: "projects.continue_focus")) {
                    ForEach(projectTasks) { task in
                        NavigationLink {
                            TaskDetailView(taskId: task.id)
                        } label: {
                            ProjectTaskRow(task: task)
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(summary.title ?? String(localized: "projects.untitled"))
        .navigationBarTitleDisplayMode(.inline)
        .task(id: appSession.activeProfileID) {
            await load()
        }
        .onChange(of: appSession.activeProfileID) { _, _ in
            if !isCurrentProfileContext {
                isEditing = false
            }
        }
    }

    private var readOnlyMessage: String {
        if !isCurrentProfileContext {
            return String(localized: "projects.stale.read_only")
        }
        return String(localized: "projects.read_only")
    }

    private var saveOnePagerTitle: String {
        let desktop = appSession.activeProfile?.activeDesktopName ?? String(localized: "control.no_desktop")
        return String(
            format: String(localized: "projects.one_pager.save_format"),
            desktop
        )
    }

    private func load() async {
        guard isCurrentProfileContext, let client = appSession.apiClient else {
            isLoading = false
            return
        }

        isLoading = true
        defer { isLoading = false }
        do {
            async let pager = client.onePager(projectId: project.id)
            async let tasks = client.projectTasks(projectId: project.id)
            async let projectPulse = client.projectPulse(projectId: project.id)
            let loadedPager = try await pager
            guard isCurrentProfileContext else { return }
            onePager = loadedPager
            projectTasks = (try? await tasks) ?? []
            pulse = try? await projectPulse
            draft = loadedPager.markdown
            error = nil
        } catch {
            guard isCurrentProfileContext else { return }
            self.error = error.localizedDescription
        }
    }

    private func save() async {
        guard isCurrentProfileContext else {
            error = String(localized: "projects.stale.read_only")
            return
        }
        guard let client = appSession.apiClient else { return }

        isSaving = true
        defer { isSaving = false }
        do {
            onePager = try await client.saveOnePager(projectId: project.id, markdown: draft)
            isEditing = false
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

private struct ProjectsScopeHeader: View {
    let profile: ServerProfile?
    let connectionState: ConnectionState
    let count: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "folder")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(Color.accentColor)
                    .frame(width: 36, height: 36)
                    .background(Color.accentColor.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))

                VStack(alignment: .leading, spacing: 3) {
                    Text(String(localized: "projects.scope.title"))
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
                Text(String(format: String(localized: "projects.count_format"), count))
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
            return String(localized: "projects.scope.unconfigured")
        }
        return String(
            format: String(localized: "projects.scope.message_format"),
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
}

private enum ProjectDisplayText {
    static func mode(_ rawValue: String) -> String {
        switch normalized(rawValue) {
        case "ship":
            return String(localized: "projects.mode.ship")
        case "learn":
            return String(localized: "projects.mode.learn")
        case "explore":
            return String(localized: "projects.mode.explore")
        case "maintain":
            return String(localized: "projects.mode.maintain")
        case "":
            return String(localized: "common.unknown")
        default:
            return ProjectPresentation.displayLabel(rawValue)
        }
    }

    static func status(_ rawValue: String) -> String {
        switch normalized(rawValue) {
        case "active":
            return String(localized: "projects.status.active")
        case "archived":
            return String(localized: "projects.status.archived")
        case "":
            return String(localized: "common.unknown")
        default:
            return ProjectPresentation.displayLabel(rawValue)
        }
    }

    private static func normalized(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
}

private struct ProjectRow: View {
    let project: Project
    let pulse: ProjectPulse?

    private var summary: ProjectPresentation.Summary {
        ProjectPresentation.summary(for: project, pulse: pulse)
    }

    private var modeLabel: String {
        ProjectDisplayText.mode(project.mode)
    }

    private var statusLabel: String {
        ProjectDisplayText.status(project.status)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(summary.title ?? String(localized: "projects.untitled"))
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text(modeLabel)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Color(.tertiarySystemGroupedBackground))
                    .clipShape(Capsule())
            }

            Text(summary.progress ?? String(localized: "projects.progress.empty"))
                .font(.callout)
                .foregroundStyle(summary.progress == nil ? .tertiary : .secondary)
                .lineLimit(2)

            HStack(spacing: 10) {
                Label(statusLabel, systemImage: "circle.fill")
                    .foregroundStyle(summary.hasLiveWork ? .blue : .secondary)
                Label(summary.lastActiveDate.formatted(date: .abbreviated, time: .omitted), systemImage: "clock")
                if let root = summary.root {
                    Label(root, systemImage: "folder")
                        .lineLimit(1)
                }
            }
            .font(.caption)
            .foregroundStyle(.tertiary)

            if pulse != nil {
                HStack(spacing: 8) {
                    ProjectCountPill(
                        label: String(format: String(localized: "projects.row.sessions_format"), summary.sessionWindow),
                        systemImage: "rectangle.stack"
                    )
                    ProjectCountPill(
                        label: String(format: String(localized: "projects.row.running_format"), summary.runningCount),
                        systemImage: "play.fill"
                    )
                    ProjectCountPill(
                        label: String(format: String(localized: "projects.row.waiting_format"), summary.waitingCount),
                        systemImage: "hand.raised"
                    )
                }
            }
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
    }
}

private struct ProjectCountPill: View {
    let label: String
    let systemImage: String

    var body: some View {
        Label(label, systemImage: systemImage)
            .font(.caption2.weight(.medium))
            .lineLimit(1)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(Color(.tertiarySystemGroupedBackground))
            .clipShape(Capsule())
    }
}

private struct ProjectDetailSummaryCard: View {
    let project: Project
    let summary: ProjectPresentation.Summary

    private var modeLabel: String {
        ProjectDisplayText.mode(project.mode)
    }

    private var statusLabel: String {
        ProjectDisplayText.status(project.status)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: summary.hasLiveWork ? "dot.radiowaves.left.and.right" : "folder")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(summary.hasLiveWork ? .blue : Color.accentColor)
                    .frame(width: 42, height: 42)
                    .background((summary.hasLiveWork ? Color.blue : Color.accentColor).opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

                VStack(alignment: .leading, spacing: 5) {
                    Text(summary.title ?? String(localized: "projects.untitled"))
                        .font(.title3.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                    Text(summary.progress ?? String(localized: "projects.progress.empty"))
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            HStack(spacing: 8) {
                ProjectCountPill(label: modeLabel, systemImage: "tag")
                ProjectCountPill(label: statusLabel, systemImage: "circle.fill")
            }

            if let root = summary.root {
                Label(root, systemImage: "folder")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .padding(16)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(Color(.separator).opacity(0.2), lineWidth: 0.5)
        )
        .accessibilityElement(children: .combine)
    }
}

private struct ProjectPulseGrid: View {
    let pulse: ProjectPulse

    private let columns = [
        GridItem(.adaptive(minimum: 96), spacing: 10)
    ]

    var body: some View {
        LazyVGrid(columns: columns, spacing: 10) {
            ProjectMetric(value: pulse.sessionWindow, label: String(localized: "projects.metric.sessions"), systemImage: "rectangle.stack")
            ProjectMetric(value: pulse.sessionsRunning, label: String(localized: "projects.metric.running"), systemImage: "play.circle")
            ProjectMetric(value: pulse.sessionsWaiting, label: String(localized: "projects.metric.waiting"), systemImage: "hand.raised")
            ProjectMetric(value: pulse.commitWindow, label: String(localized: "projects.metric.commits"), systemImage: "arrow.triangle.branch")
        }
        .padding(.vertical, 4)
    }
}

private struct ProjectMetric: View {
    let value: Int
    let label: String
    let systemImage: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: systemImage)
                    .foregroundStyle(.secondary)
                Spacer()
                Text(value, format: .number)
                    .font(.title3.weight(.semibold))
                    .monospacedDigit()
            }
            Text(label)
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
        .padding(12)
        .frame(maxWidth: .infinity, minHeight: 82, alignment: .leading)
        .background(Color(.tertiarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

private struct OnePagerReadView: View {
    let onePager: OnePager?
    let focus: ProjectPresentation.OnePagerFocus

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if !focus.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    if let northStar = focus.northStar {
                        ProjectFocusLine(
                            title: String(localized: "projects.one_pager.north_star"),
                            value: northStar,
                            systemImage: "scope"
                        )
                    }
                    if let focusText = focus.focus {
                        ProjectFocusLine(
                            title: String(localized: "projects.one_pager.focus"),
                            value: focusText,
                            systemImage: "target"
                        )
                    }
                    if !focus.next.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            Label(String(localized: "projects.one_pager.next"), systemImage: "checklist")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                            ForEach(focus.next, id: \.self) { item in
                                Label(item, systemImage: "circle")
                                    .font(.callout)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                }
                .padding(14)
                .background(Color(.tertiarySystemGroupedBackground))
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            }

            if let markdown = focus.displayMarkdown {
                Text(renderedMarkdown(markdown))
                    .font(.body)
                    .lineSpacing(3)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            } else if focus.isEmpty {
                ContentUnavailableView(
                    String(localized: "projects.one_pager.empty.title"),
                    systemImage: "doc.text",
                    description: Text(String(localized: "projects.one_pager.empty.message"))
                )
            }
        }
    }

    private func renderedMarkdown(_ markdown: String) -> AttributedString {
        (try? AttributedString(markdown: markdown)) ?? AttributedString(markdown)
    }
}

private struct ProjectFocusLine: View {
    let title: String
    let value: String
    let systemImage: String

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Label(title, systemImage: systemImage)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

private struct ProjectTaskRow: View {
    let task: KinTask

    private var summary: TaskPresentation.Summary {
        TaskPresentation.summary(for: task)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline) {
                StatusBadge(status: task.status)
                Spacer(minLength: 8)
                Text(summary.elapsed)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .monospacedDigit()
            }
            Text(summary.title)
                .font(.subheadline.weight(.medium))
                .lineLimit(2)
            Label(summary.agentAndModel, systemImage: "person.crop.circle")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
    }
}

private struct ProjectStaleScopeCard: View {
    let activeProfile: ServerProfile?
    let onReturn: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(String(localized: "projects.stale.title"), systemImage: "exclamationmark.triangle.fill")
                .font(.headline)
                .foregroundStyle(.orange)
            Text(message)
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button {
                onReturn()
            } label: {
                Label(String(localized: "projects.stale.return"), systemImage: "arrow.backward")
            }
            .buttonStyle(.bordered)
        }
        .padding(14)
        .background(Color.orange.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private var message: String {
        let name = activeProfile?.activeDesktopName ?? String(localized: "control.no_desktop")
        return String(
            format: String(localized: "projects.stale.message_format"),
            name
        )
    }
}
