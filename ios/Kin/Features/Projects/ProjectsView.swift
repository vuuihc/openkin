import SwiftUI

struct ProjectsView: View {
    @Environment(AppSession.self) private var appSession
    @State private var projects: [Project] = []
    @State private var isLoading = false
    @State private var error: String?
    @State private var showingNewProject = false

    var body: some View {
        NavigationStack {
            Group {
                if isLoading && projects.isEmpty {
                    ProgressView()
                } else if let error, projects.isEmpty {
                    ContentUnavailableView(
                        "Projects unavailable",
                        systemImage: "folder.badge.questionmark",
                        description: Text(error)
                    )
                } else if projects.isEmpty {
                    ContentUnavailableView(
                        "No projects",
                        systemImage: "folder",
                        description: Text("Projects created on Desktop will appear here.")
                    )
                } else {
                    List(projects) { project in
                        NavigationLink {
                            ProjectDetailView(project: project)
                        } label: {
                            projectRow(project)
                        }
                    }
                    .listStyle(.insetGrouped)
                }
            }
            .navigationTitle("Projects")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    HStack {
                        if appSession.canManageDaemon {
                            Button {
                                showingNewProject = true
                            } label: {
                                Image(systemName: "plus")
                            }
                            .accessibilityLabel("New project")
                        }
                        Button {
                            Task { await load() }
                        } label: {
                            Image(systemName: "arrow.clockwise")
                        }
                        .accessibilityLabel("Refresh projects")
                    }
                }
            }
            .refreshable { await load() }
        }
        .task { await load() }
        .sheet(isPresented: $showingNewProject) {
            NewProjectView { await load() }
        }
    }

    private func projectRow(_ project: Project) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(project.name)
                    .font(.headline)
                Spacer()
                Text(project.mode.capitalized)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let progress = project.softProgress, !progress.isEmpty {
                Text(progress)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            HStack {
                Text(project.status.capitalized)
                Spacer()
                Text(dateText(project.lastActiveAt))
            }
            .font(.caption)
            .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 4)
    }

    private func load() async {
        guard let client = appSession.apiClient else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            projects = try await client.projects()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func dateText(_ milliseconds: Int64) -> String {
        Date(timeIntervalSince1970: Double(milliseconds) / 1000)
            .formatted(date: .abbreviated, time: .omitted)
    }
}

private struct NewProjectView: View {
    @Environment(AppSession.self) private var appSession
    @Environment(\.dismiss) private var dismiss
    let onSaved: () async -> Void
    @State private var name = ""
    @State private var mode = "ship"
    @State private var root = ""
    @State private var error: String?
    @State private var isSaving = false

    var body: some View {
        NavigationStack {
            Form {
                TextField("Name", text: $name)
                TextField("Repository path", text: $root)
                    .textInputAutocapitalization(.never)
                Picker("Mode", selection: $mode) {
                    Text("Ship").tag("ship")
                    Text("Learn").tag("learn")
                    Text("Explore").tag("explore")
                    Text("Maintain").tag("maintain")
                }
                if let error {
                    Text(error).foregroundStyle(.red)
                }
                Button {
                    Task { await save() }
                } label: {
                    HStack {
                        Spacer()
                        if isSaving { ProgressView() } else { Text("Create Project") }
                        Spacer()
                    }
                }
                .disabled(isSaving || name.isEmpty || root.isEmpty)
            }
            .navigationTitle("New Project")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }

    private func save() async {
        guard let client = appSession.apiClient else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            _ = try await client.createProject(name: name, mode: mode, roots: [root])
            await onSaved()
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct ProjectDetailView: View {
    @Environment(AppSession.self) private var appSession
    let project: Project

    @State private var onePager: OnePager?
    @State private var projectTasks: [KinTask] = []
    @State private var pulse: ProjectPulse?
    @State private var isEditing = false
    @State private var draft = ""
    @State private var isSaving = false
    @State private var error: String?

    var body: some View {
        List {
            if let error {
                Text(error).foregroundStyle(.red)
            }

            Section("Overview") {
                LabeledContent("Mode", value: project.mode.capitalized)
                LabeledContent("Status", value: project.status.capitalized)
                if let pulse {
                    LabeledContent("Sessions", value: "\(pulse.sessionWindow)")
                    LabeledContent("Running", value: "\(pulse.sessionsRunning)")
                    LabeledContent("Waiting", value: "\(pulse.sessionsWaiting)")
                }
            }

            Section("One-Pager") {
                if isEditing {
                    TextEditor(text: $draft)
                        .frame(minHeight: 260)
                    Button {
                        Task { await save() }
                    } label: {
                        HStack {
                            Spacer()
                            if isSaving { ProgressView() } else { Text("Save One-Pager") }
                            Spacer()
                        }
                    }
                    .disabled(isSaving)
                } else {
                    Text(onePager?.markdown ?? "No one-pager yet.")
                        .font(.body)
                        .textSelection(.enabled)
                    if appSession.canManageDaemon {
                        Button("Edit One-Pager") {
                            draft = onePager?.markdown ?? ""
                            isEditing = true
                        }
                    } else {
                        Text("Read-only pairing. Use a master token to edit.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            if !projectTasks.isEmpty {
                Section("Recent Tasks") {
                    ForEach(projectTasks) { task in
                        NavigationLink {
                            TaskDetailView(taskId: task.id)
                        } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(task.prompt).lineLimit(2)
                                HStack {
                                    StatusBadge(status: task.status)
                                    Text(task.agent)
                                }
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle(project.name)
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func load() async {
        guard let client = appSession.apiClient else { return }
        do {
            async let pager = client.onePager(projectId: project.id)
            async let tasks = client.projectTasks(projectId: project.id)
            async let projectPulse = client.projectPulse(projectId: project.id)
            onePager = try await pager
            projectTasks = (try? await tasks) ?? []
            pulse = try? await projectPulse
            draft = onePager?.markdown ?? ""
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func save() async {
        guard let client = appSession.apiClient else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            onePager = try await client.saveOnePager(projectId: project.id, markdown: draft)
            isEditing = false
        } catch {
            self.error = error.localizedDescription
        }
    }
}
