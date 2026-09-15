import SwiftUI

/// A card that displays an approval request from the agent.
///
/// Shows agent/model info, the requested tool command or path, an input detail
/// summary, and Approve / Deny buttons. Commands that look destructive trigger
/// a confirmation sheet before denying.
struct ApprovalCard: View {
    let approval: Approval
    let onDecision: (_ approvalId: String, _ approved: Bool) async throws -> Void

    @State private var isInFlight = false
    @State private var showDenyConfirmation = false
    @State private var decisionError: String?

    /// Commands that are considered destructive and require confirmation before denying.
    private static let destructiveCommands: Set<String> = [
        "rm", "rmdir", "del", "deltree", "rm -rf", "rm -r",
        "dd", "mkfs", "format", "fdisk",
        "shutdown", "reboot", "poweroff",
        "kill", "killall", "pkill",
        "chmod", "chown", "mv", "cp",  // renaming/moving large trees
    ]

    private var isDestructive: Bool {
        guard let command = approval.command?.trimmingCharacters(in: .whitespaces) else {
            return false
        }
        let firstWord = command
            .split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)
            .first
            .map(String.init) ?? command
        return Self.destructiveCommands.contains(firstWord)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Header
            HStack(spacing: 6) {
                Image(systemName: "lock.shield")
                    .foregroundStyle(.orange)
                    .font(.caption)

                Text(
                    String(localized: "Approval Required", comment: "Approval card title")
                )
                .font(.subheadline)
                .fontWeight(.semibold)

                Spacer()

                if isInFlight {
                    ProgressView()
                        .scaleEffect(0.7)
                }
            }

            // Agent & model info
            if let agent = approval.agentName {
                HStack(spacing: 4) {
                    Text(
                        String(localized: "Agent", comment: "Approval card: agent label")
                    )
                    .foregroundStyle(.secondary)
                    Text(agent)
                        .fontWeight(.medium)

                    if let model = approval.modelName {
                        Text("·")
                            .foregroundStyle(.tertiary)
                        Text(model)
                            .foregroundStyle(.secondary)
                    }
                }
                .font(.caption)
            }

            // Tool name
            if let toolName = approval.toolName {
                LabeledRow(
                    label: String(localized: "Tool", comment: "Approval card: tool label"),
                    value: toolName
                )
            }

            // Command or path
            Group {
                if let command = approval.command, !command.isEmpty {
                    LabeledRow(
                        label: String(localized: "Command", comment: "Approval card: command label"),
                        value: command
                    )
                } else if let path = approval.path, !path.isEmpty {
                    LabeledRow(
                        label: String(localized: "Path", comment: "Approval card: path label"),
                        value: path
                    )
                }
            }

            // Input detail
            if let detail = approval.inputDetail, !detail.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text(
                        String(localized: "Details", comment: "Approval card: input details label")
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)

                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.primary)
                        .lineLimit(6)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                        .background(Color(.systemGray6))
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                }
            }

            // Error message
            if let error = decisionError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
            }

            // Action buttons
            HStack(spacing: 12) {
                Button(role: .destructive) {
                    if isDestructive {
                        showDenyConfirmation = true
                    } else {
                        makeDecision(approved: false)
                    }
                } label: {
                    Text(
                        String(localized: "Deny", comment: "Approval card: deny button")
                    )
                    .fontWeight(.medium)
                }
                .buttonStyle(.bordered)
                .disabled(isInFlight)

                Button {
                    makeDecision(approved: true)
                } label: {
                    Text(
                        String(localized: "Approve", comment: "Approval card: approve button")
                    )
                    .fontWeight(.medium)
                }
                .buttonStyle(.borderedProminent)
                .tint(.green)
                .disabled(isInFlight)
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
        }
        .padding(14)
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .shadow(color: .black.opacity(0.06), radius: 4, x: 0, y: 2)
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(Color(.separator).opacity(0.3), lineWidth: 0.5)
        )
        .confirmationDialog(
            String(
                localized: "Are you sure you want to deny this request?",
                comment: "Deny confirmation dialog title"
            ),
            isPresented: $showDenyConfirmation,
            titleVisibility: .visible
        ) {
            Button(
                String(localized: "Deny Anyway", comment: "Deny confirmation: confirm button"),
                role: .destructive
            ) {
                makeDecision(approved: false)
            }
            Button(
                String(localized: "Cancel", comment: "Deny confirmation: cancel button"),
                role: .cancel
            ) {}
        } message: {
            Text(
                String(
                    localized: "This command may be destructive:",
                    comment: "Deny confirmation message prefix"
                ) + " \(approval.command ?? "")"
            )
        }
    }

    private func makeDecision(approved: Bool) {
        isInFlight = true
        decisionError = nil

        Task {
            do {
                try await onDecision(approval.id, approved)
            } catch {
                decisionError = error.localizedDescription
            }
            isInFlight = false
        }
    }
}

// MARK: - Helper row

private struct LabeledRow: View {
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.caption)
                .fontWeight(.medium)
                .fontDesign(.monospaced)
                .lineLimit(3)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

// MARK: - Preview

#Preview("Basic approval") {
    ApprovalCard(
        approval: Approval(
            id: "approval-1",
            taskId: "task-1",
            agentName: "Kin",
            modelName: "claude-sonnet-4",
            toolName: "write_file",
            command: nil,
            path: "/Users/me/project/main.go",
            inputDetail: "Write a new HTTP handler for the /api/users endpoint with proper error handling and request validation.",
            status: .pending,
            createdAt: Date(),
            decidedAt: nil,
            decidedVia: nil
        ),
        onDecision: { _, _ in }
    )
    .padding()
}

#Preview("Destructive command") {
    ApprovalCard(
        approval: Approval(
            id: "approval-2",
            taskId: "task-1",
            agentName: "Kin",
            modelName: "deepseek-v4",
            toolName: "execute_command",
            command: "rm -rf /tmp/cache",
            path: nil,
            inputDetail: "Clean up the build cache directory.",
            status: .pending,
            createdAt: Date(),
            decidedAt: nil,
            decidedVia: nil
        ),
        onDecision: { _, _ in }
    )
    .padding()
}

#Preview("Minimal") {
    ApprovalCard(
        approval: Approval(
            id: "approval-3",
            taskId: "task-2",
            agentName: nil,
            modelName: nil,
            toolName: nil,
            command: nil,
            path: nil,
            inputDetail: nil,
            status: .pending,
            createdAt: Date(),
            decidedAt: nil,
            decidedVia: nil
        ),
        onDecision: { _, _ in }
    )
    .padding()
}