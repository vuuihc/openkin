import SwiftUI

/// Shows a unified diff for a single changed file within a workspace.
struct FileDiffView: View {
    let taskId: String
    let workspaceId: String
    let filePath: String
    var apiClient: APIClient?

    @State private var diffContent: String?
    @State private var isLoading = true
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Group {
                if isLoading {
                    ProgressView("Loading diff…")
                } else if let error {
                    ContentUnavailableView(
                        label: {
                            Label("Cannot Load Diff", systemImage: "doc.text.magnifyingglass")
                        },
                        description: {
                            Text(error)
                        }
                    )
                } else if let content = diffContent {
                    diffScrollView(content)
                }
            }
            .navigationTitle(filePath)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .task { await loadDiff() }
    }

    @Environment(\.dismiss) private var dismiss

    // MARK: - Diff Content

    private func diffScrollView(_ content: String) -> some View {
        let lines = content.components(separatedBy: .newlines)

        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                    HStack(spacing: 0) {
                        if line.hasPrefix("+") && !line.hasPrefix("+++") {
                            Rectangle()
                                .fill(.green.opacity(0.12))
                                .frame(width: 3)
                        } else if line.hasPrefix("-") && !line.hasPrefix("---") {
                            Rectangle()
                                .fill(.red.opacity(0.12))
                                .frame(width: 3)
                        } else if line.hasPrefix("@") {
                            Rectangle()
                                .fill(.blue.opacity(0.12))
                                .frame(width: 3)
                        } else {
                            Rectangle()
                                .fill(.clear)
                                .frame(width: 3)
                        }

                        Text(line)
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(foregroundColor(for: line))
                            .padding(.vertical, 1)
                            .padding(.horizontal, 6)
                    }
                    .background(backgroundColor(for: line))
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(.vertical, 8)
        }
        .background(Color(.systemGray6))
    }

    // MARK: - Line Coloring

    private func foregroundColor(for line: String) -> Color {
        if line.hasPrefix("+") {
            return .green
        } else if line.hasPrefix("-") {
            return .red
        } else if line.hasPrefix("@") {
            return .blue
        }
        return .primary
    }

    private func backgroundColor(for line: String) -> Color {
        if line.hasPrefix("+") {
            return .green.opacity(0.06)
        } else if line.hasPrefix("-") {
            return .red.opacity(0.06)
        } else if line.hasPrefix("@") {
            return .blue.opacity(0.06)
        }
        return .clear
    }

    // MARK: - Data Loading

    private func loadDiff() async {
        isLoading = true
        error = nil
        do {
            guard let client = apiClient else {
                error = "No API client configured"
                isLoading = false
                return
            }
            let content = try await client.workspaceFile(
                taskId: taskId,
                workspaceId: workspaceId,
                path: filePath
            )
            diffContent = content
            isLoading = false
        } catch {
            self.error = error.localizedDescription
            isLoading = false
        }
    }
}

// MARK: - Previews

#Preview {
    FileDiffView(taskId: "preview-task", workspaceId: "preview-ws", filePath: "src/main.go")
}