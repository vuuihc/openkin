import SwiftUI

struct ArtifactsView: View {
    @Environment(AppSession.self) private var appSession
    @State private var artifacts: [Artifact] = []
    @State private var isLoading = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Group {
                if isLoading && artifacts.isEmpty {
                    ProgressView()
                } else if let error, artifacts.isEmpty {
                    ContentUnavailableView(
                        "Artifacts unavailable",
                        systemImage: "doc.badge.ellipsis",
                        description: Text(error)
                    )
                } else if artifacts.isEmpty {
                    ContentUnavailableView(
                        "No artifacts",
                        systemImage: "doc.text",
                        description: Text("Save readable work from Desktop tasks to see it here.")
                    )
                } else {
                    List {
                        ForEach(artifacts) { artifact in
                            NavigationLink {
                                ArtifactDetailView(artifact: artifact)
                            } label: {
                                artifactRow(artifact)
                            }
                        }
                    }
                    .listStyle(.insetGrouped)
                }
            }
            .navigationTitle("Artifacts")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await load() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .accessibilityLabel("Refresh artifacts")
                }
            }
            .refreshable { await load() }
        }
        .task { await load() }
    }

    private func artifactRow(_ artifact: Artifact) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(artifact.title)
                    .font(.headline)
                Spacer()
                Text(artifact.kind.uppercased())
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            HStack {
                Text(byteText(artifact.size))
                Spacer()
                Text(Date(timeIntervalSince1970: Double(artifact.updatedAt) / 1000)
                    .formatted(date: .abbreviated, time: .omitted))
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
            artifacts = try await client.artifacts()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func byteText(_ size: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: size, countStyle: .file)
    }
}

struct ArtifactDetailView: View {
    @Environment(AppSession.self) private var appSession
    let artifact: Artifact

    @State private var content = ""
    @State private var isLoading = true
    @State private var error: String?
    @State private var isArchived = false

    var body: some View {
        Group {
            if isLoading {
                ProgressView()
            } else if let error {
                ContentUnavailableView("Unable to read artifact", systemImage: "exclamationmark.triangle", description: Text(error))
            } else {
                ScrollView {
                    Text(content)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                        .padding()
                }
            }
        }
        .navigationTitle(artifact.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if appSession.canManageDaemon {
                    Button {
                        Task { await archive() }
                    } label: {
                        Image(systemName: isArchived ? "archivebox.fill" : "archivebox")
                    }
                    .accessibilityLabel(isArchived ? "Archived" : "Archive artifact")
                    .disabled(isArchived)
                }
            }
        }
        .task { await load() }
    }

    private func load() async {
        guard let client = appSession.apiClient else { return }
        do {
            content = try await client.artifactContent(id: artifact.id)
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }

    private func archive() async {
        guard let client = appSession.apiClient else { return }
        do {
            _ = try await client.setArtifactStatus(id: artifact.id, status: "archived")
            isArchived = true
        } catch {
            self.error = error.localizedDescription
        }
    }
}
