import SwiftUI

/// Shows a list of changed files for a completed task's workspaces,
/// grouped by generation.
struct WorkspaceChangesView: View {
    let taskId: String
    var apiClient: APIClient?
    @Environment(\.dismiss) private var dismiss

    @State private var workspaces: [Workspace] = []
    @State private var isLoading = true
    @State private var error: String?
    @State private var selectedFile: ChangedFile?
    @State private var selectedWorkspaceId: String?
    @State private var showDiff = false

    var body: some View {
        NavigationStack {
            Group {
                if isLoading {
                    ProgressView("Loading workspace…")
                } else if let error {
                    ContentUnavailableView(
                        label: {
                            Label("Error", systemImage: "exclamationmark.triangle")
                        },
                        description: {
                            Text(error)
                        },
                        actions: {
                            Button("Retry") {
                                Task { await load() }
                            }
                            .buttonStyle(.borderedProminent)
                        }
                    )
                } else if workspaces.isEmpty {
                    ContentUnavailableView(
                        label: {
                            Label("No Changes", systemImage: "doc.text")
                        },
                        description: {
                            Text("No workspace changes found for this task.")
                        }
                    )
                } else {
                    workspaceList
                }
            }
            .navigationTitle("Changes")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        dismiss()
                    }
                }
            }
            .sheet(isPresented: $showDiff) {
                if let file = selectedFile, let workspaceId = selectedWorkspaceId {
                    FileDiffView(
                        taskId: taskId,
                        workspaceId: workspaceId,
                        filePath: file.path,
                        apiClient: apiClient
                    )
                }
            }
        }
        .task { await load() }
    }

    // MARK: - Workspace List

    private var workspaceList: some View {
        List {
            ForEach(workspaces) { workspace in
                Section {
                    ForEach(workspace.changedFiles ?? []) { file in
                        Button {
                            selectedFile = file
                            selectedWorkspaceId = workspace.id
                            showDiff = true
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(file.path)
                                        .font(.subheadline)
                                        .lineLimit(1)
                                    if file.isBinary == true {
                                        Text("Binary file")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                Spacer()
                                HStack(spacing: 4) {
                                    if file.additions > 0 {
                                        Text("+\(file.additions)")
                                            .foregroundStyle(.green)
                                            .font(.caption.monospacedDigit())
                                    }
                                    if file.deletions > 0 {
                                        Text("-\(file.deletions)")
                                            .foregroundStyle(.red)
                                            .font(.caption.monospacedDigit())
                                    }
                                }
                            }
                        }
                        .disabled(file.isBinary == true)
                    }
                } header: {
                    Text("Generation \(workspace.generation)\(workspace.isCurrent == true ? " (current)" : "")")
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    // MARK: - Data Loading

    private func load() async {
        isLoading = true
        error = nil
        do {
            guard let client = apiClient else {
                error = "No API client configured"
                isLoading = false
                return
            }
            workspaces = try await client.workspaces(taskId: taskId)
            isLoading = false
        } catch {
            self.error = error.localizedDescription
            isLoading = false
        }
    }
}

// MARK: - Previews

#Preview {
    WorkspaceChangesView(taskId: "preview-task")
}