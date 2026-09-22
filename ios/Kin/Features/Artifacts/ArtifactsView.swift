import SwiftUI

struct ArtifactsView: View {
    @Environment(AppSession.self) private var appSession
    @State private var artifacts: [Artifact] = []
    @State private var loadedProfileID: UUID?
    @State private var isLoading = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Group {
                if isLoading && artifacts.isEmpty {
                    loadingView
                } else if let error, artifacts.isEmpty {
                    errorView(error)
                } else if artifacts.isEmpty {
                    emptyView
                } else {
                    artifactList
                }
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle(String(localized: "artifacts.library"))
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await load() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .accessibilityLabel(String(localized: "artifacts.refresh"))
                }
            }
            .refreshable { await load() }
        }
        .task(id: appSession.activeProfileID) {
            await load()
        }
    }

    // MARK: - Content

    private var loadingView: some View {
        VStack(spacing: 16) {
            ProgressView()
                .scaleEffect(1.2)
            Text(String(localized: "artifacts.loading"))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemGroupedBackground))
    }

    private func errorView(_ message: String) -> some View {
        ContentUnavailableView(
            label: {
                Label(String(localized: "artifacts.error.title"), systemImage: "doc.badge.ellipsis")
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
                Label(String(localized: "artifacts.empty.title"), systemImage: "doc.text")
            },
            description: {
                Text(emptyMessage)
            }
        )
        .background(Color(.systemGroupedBackground))
    }

    private var artifactList: some View {
        List {
            Section {
                ArtifactsScopeHeader(
                    profile: appSession.activeProfile,
                    connectionState: appSession.connectionState,
                    count: artifacts.count
                )
                .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                .listRowBackground(Color.clear)
            }

            Section(String(localized: "artifacts.section.saved_outputs")) {
                ForEach(artifacts) { artifact in
                    NavigationLink {
                        ArtifactDetailView(artifact: artifact, boundProfileID: appSession.activeProfileID)
                    } label: {
                        ArtifactRow(artifact: artifact)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    private func load() async {
        let requestedProfileID = appSession.activeProfileID
        guard let requestedProfileID, let client = appSession.apiClient else {
            loadedProfileID = requestedProfileID
            artifacts = []
            error = nil
            return
        }

        if loadedProfileID != requestedProfileID {
            artifacts = []
        }

        isLoading = true
        defer { isLoading = false }
        do {
            let nextArtifacts = try await client.artifacts()
            guard appSession.activeProfileID == requestedProfileID else { return }
            artifacts = nextArtifacts
            loadedProfileID = requestedProfileID
            error = nil
        } catch {
            guard appSession.activeProfileID == requestedProfileID else { return }
            self.error = error.localizedDescription
        }
    }

    private var emptyMessage: String {
        guard let profile = appSession.activeProfile else {
            return String(localized: "artifacts.empty.unconfigured")
        }
        return String(
            format: String(localized: "artifacts.empty.message_format"),
            profile.activeDesktopName
        )
    }
}

struct ArtifactDetailView: View {
    @Environment(AppSession.self) private var appSession
    @Environment(\.dismiss) private var dismiss
    let artifact: Artifact
    let boundProfileID: UUID?

    @State private var content = ""
    @State private var isLoading = true
    @State private var error: String?
    @State private var isArchived: Bool

    init(artifact: Artifact, boundProfileID: UUID?) {
        self.artifact = artifact
        self.boundProfileID = boundProfileID
        _isArchived = State(initialValue: ArtifactPresentation.summary(for: artifact).isArchived)
    }

    private var isCurrentProfileContext: Bool {
        TaskPresentation.isCurrentProfileContext(
            boundProfileID: boundProfileID,
            activeProfileID: appSession.activeProfileID
        )
    }

    private var summary: ArtifactPresentation.Summary {
        ArtifactPresentation.summary(for: artifact)
    }

    var body: some View {
        List {
            if !isCurrentProfileContext {
                ArtifactStaleScopeCard(
                    activeProfile: appSession.activeProfile,
                    onReturn: { dismiss() }
                )
                .listRowBackground(Color.clear)
            }

            Section {
                ArtifactDetailHeader(artifact: artifact)
                    .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                    .listRowBackground(Color.clear)
            }

            if let error {
                Section {
                    Text(error)
                        .foregroundStyle(.red)
                }
            }

            Section(String(localized: "artifacts.detail.content")) {
                if isLoading {
                    HStack(spacing: 12) {
                        ProgressView()
                        Text(String(localized: "artifacts.detail.loading"))
                            .foregroundStyle(.secondary)
                    }
                } else if content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    ContentUnavailableView(
                        String(localized: "artifacts.detail.empty.title"),
                        systemImage: "doc.text",
                        description: Text(String(localized: "artifacts.detail.empty.message"))
                    )
                } else {
                    Text(renderedContent)
                        .font(.body)
                        .lineSpacing(3)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(summary.title ?? String(localized: "artifacts.untitled"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if appSession.canManageDaemon {
                    Button {
                        Task { await archive() }
                    } label: {
                        Image(systemName: isArchived ? "archivebox.fill" : "archivebox")
                    }
                    .accessibilityLabel(isArchived ? String(localized: "artifacts.archived") : String(localized: "artifacts.archive"))
                    .disabled(isArchived || !isCurrentProfileContext)
                }
            }
        }
        .task(id: appSession.activeProfileID) {
            await load()
        }
    }

    private func load() async {
        guard isCurrentProfileContext, let client = appSession.apiClient else {
            isLoading = false
            return
        }

        isLoading = true
        do {
            let loadedContent = try await client.artifactContent(id: artifact.id)
            guard isCurrentProfileContext else { return }
            content = loadedContent
            error = nil
        } catch {
            guard isCurrentProfileContext else { return }
            self.error = error.localizedDescription
        }
        isLoading = false
    }

    private func archive() async {
        guard isCurrentProfileContext else {
            error = String(localized: "artifacts.stale.read_only")
            return
        }
        guard let client = appSession.apiClient else { return }
        do {
            _ = try await client.setArtifactStatus(id: artifact.id, status: "archived")
            isArchived = true
        } catch {
            self.error = error.localizedDescription
        }
    }

    private var renderedContent: AttributedString {
        (try? AttributedString(markdown: content)) ?? AttributedString(content)
    }
}

private struct ArtifactsScopeHeader: View {
    let profile: ServerProfile?
    let connectionState: ConnectionState
    let count: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "books.vertical")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(Color.accentColor)
                    .frame(width: 36, height: 36)
                    .background(Color.accentColor.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))

                VStack(alignment: .leading, spacing: 3) {
                    Text(String(localized: "artifacts.scope.title"))
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
                Text(String(format: String(localized: "artifacts.count_format"), count))
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
            return String(localized: "artifacts.scope.unconfigured")
        }
        return String(
            format: String(localized: "artifacts.scope.message_format"),
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

private struct ArtifactRow: View {
    let artifact: Artifact

    private var summary: ArtifactPresentation.Summary {
        ArtifactPresentation.summary(for: artifact)
    }

    private var kindLabel: String {
        ArtifactDisplayText.kind(artifact.kind)
    }

    private var statusLabel: String {
        ArtifactDisplayText.status(artifact.status)
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: iconName)
                .font(.title3.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(width: 36, height: 36)
                .background(Color(.tertiarySystemGroupedBackground))
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))

            VStack(alignment: .leading, spacing: 7) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(summary.title ?? String(localized: "artifacts.untitled"))
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(2)
                    Spacer(minLength: 8)
                    Text(kindLabel)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 4)
                        .background(Color(.tertiarySystemGroupedBackground))
                        .clipShape(Capsule())
                }

                if let source = summary.sourceTitle {
                    Label(source, systemImage: "arrow.turn.down.right")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                HStack(spacing: 10) {
                    Label(summary.sizeText, systemImage: "externaldrive")
                    Label(summary.updatedDate.formatted(date: .abbreviated, time: .omitted), systemImage: "clock")
                    Spacer(minLength: 8)
                    Text(statusLabel)
                }
                .font(.caption)
                .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
    }

    private var iconName: String {
        switch artifact.kind.lowercased() {
        case "markdown", "markdown_note", "note":
            return "doc.richtext"
        case "diff", "patch":
            return "plus.forwardslash.minus"
        case "log":
            return "terminal"
        default:
            return "doc.text"
        }
    }
}

private struct ArtifactDetailHeader: View {
    let artifact: Artifact

    private var summary: ArtifactPresentation.Summary {
        ArtifactPresentation.summary(for: artifact)
    }

    private var kindLabel: String {
        ArtifactDisplayText.kind(artifact.kind)
    }

    private var statusLabel: String {
        ArtifactDisplayText.status(artifact.status)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "doc.richtext")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(Color.accentColor)
                    .frame(width: 42, height: 42)
                    .background(Color.accentColor.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

                VStack(alignment: .leading, spacing: 5) {
                    Text(summary.title ?? String(localized: "artifacts.untitled"))
                        .font(.title3.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                    if let source = summary.sourceTitle {
                        Text(source)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
            }

            HStack(spacing: 8) {
                ArtifactMetadataPill(label: kindLabel, systemImage: "doc")
                ArtifactMetadataPill(label: summary.sizeText, systemImage: "externaldrive")
                ArtifactMetadataPill(label: statusLabel, systemImage: "archivebox")
            }

            Label(summary.updatedDate.formatted(date: .abbreviated, time: .shortened), systemImage: "clock")
                .font(.caption)
                .foregroundStyle(.secondary)
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

private struct ArtifactMetadataPill: View {
    let label: String
    let systemImage: String

    var body: some View {
        Label(label, systemImage: systemImage)
            .font(.caption.weight(.medium))
            .lineLimit(1)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(Color(.tertiarySystemGroupedBackground))
            .clipShape(Capsule())
    }
}

private enum ArtifactDisplayText {
    static func kind(_ rawValue: String) -> String {
        switch normalized(rawValue) {
        case "markdown", "markdown_note":
            return String(localized: "artifacts.kind.markdown")
        case "html":
            return String(localized: "artifacts.kind.html")
        case "text", "note":
            return String(localized: "artifacts.kind.text")
        case "diff", "patch":
            return String(localized: "artifacts.kind.diff")
        case "log":
            return String(localized: "artifacts.kind.log")
        case "":
            return String(localized: "common.unknown")
        default:
            return ProjectPresentation.displayLabel(rawValue)
        }
    }

    static func status(_ rawValue: String) -> String {
        switch normalized(rawValue) {
        case "saved":
            return String(localized: "artifacts.status.saved")
        case "archived":
            return String(localized: "artifacts.status.archived")
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

private struct ArtifactStaleScopeCard: View {
    let activeProfile: ServerProfile?
    let onReturn: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(String(localized: "artifacts.stale.title"), systemImage: "exclamationmark.triangle.fill")
                .font(.headline)
                .foregroundStyle(.orange)
            Text(message)
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button {
                onReturn()
            } label: {
                Label(String(localized: "artifacts.stale.return"), systemImage: "arrow.backward")
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
            format: String(localized: "artifacts.stale.message_format"),
            name
        )
    }
}
