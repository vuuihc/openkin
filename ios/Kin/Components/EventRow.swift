import SwiftUI

/// A single row in a task's event timeline.
///
/// Renders different layouts depending on the event content type, with the
/// timestamp displayed on the trailing edge.
struct EventRow: View {
    let event: TaskEvent

    private static let timestampFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        return f
    }()

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            // Main content
            contentView
                .frame(maxWidth: .infinity, alignment: .leading)

            // Timestamp (millisecond epoch → display)
            Text(EventRow.timestampFormatter.string(from: Date(timeIntervalSince1970: Double(event.ts) / 1000.0)))
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .padding(.top, 1)
        }
        .padding(.vertical, 2)
    }

    // MARK: - Content

    @ViewBuilder
    private var contentView: some View {
        switch event.content {
        case let .message(role, text):
            messageView(role: role, text: text)

        case let .reasoning(text):
            reasoningView(text: text)

        case let .toolCall(name, summary, _, _):
            toolCallView(name: name, summary: summary)

        case let .error(message):
            errorView(message: message)

        case let .approval(_, summary):
            approvalView(summary: summary)

        case let .question(_, summary):
            questionView(summary: summary)

        case let .statusChange(from, to):
            statusChangeView(from: from, to: to)

        case .unknown:
            unknownView

        case nil:
            emptyView
        }
    }

    // MARK: - Message

    private func messageView(role: String, text: String) -> some View {
        let isUser = role.lowercased() == "user"
        let isAssistant = role.lowercased() == "assistant" || role.lowercased() == "kin"
        let isSystem = role.lowercased() == "system"

        return VStack(alignment: isUser ? .trailing : .leading, spacing: 2) {
            // Role label
            if isSystem {
                Text(
                    String(localized: "System", comment: "Event row: system message role")
                )
                .font(.caption2)
                .foregroundStyle(.tertiary)
            } else if isAssistant {
                Text(
                    String(localized: "Assistant", comment: "Event row: assistant message role")
                )
                .font(.caption2)
                .foregroundStyle(.tertiary)
            }

            Text(text)
                .font(.subheadline)
                .foregroundStyle(isSystem ? .secondary : .primary)
                .multilineTextAlignment(isUser ? .trailing : .leading)
                .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
        }
    }

    // MARK: - Reasoning

    private func reasoningView(text: String) -> some View {
        HStack(alignment: .top, spacing: 4) {
            Image(systemName: "brain")
                .font(.caption2)
                .foregroundStyle(.tertiary)

            Text(text)
                .font(.caption)
                .italic()
                .foregroundStyle(.secondary)
                .lineLimit(3)
        }
    }

    // MARK: - Tool call

    private func toolCallView(name: String, summary: String) -> some View {
        HStack(alignment: .top, spacing: 4) {
            Image(systemName: "wrench.and.screwdriver")
                .font(.caption2)
                .foregroundStyle(.secondary)

            VStack(alignment: .leading, spacing: 1) {
                Text(name)
                    .font(.caption)
                    .fontWeight(.medium)
                    .fontDesign(.monospaced)

                Text(summary)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
    }

    // MARK: - Error

    private func errorView(message: String) -> some View {
        HStack(alignment: .top, spacing: 4) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.caption2)
                .foregroundStyle(.red)

            Text(message)
                .font(.caption)
                .foregroundStyle(.red)
        }
    }

    // MARK: - Approval

    private func approvalView(summary: String) -> some View {
        HStack(alignment: .top, spacing: 4) {
            Image(systemName: "checkmark.shield")
                .font(.caption2)
                .foregroundStyle(.green)

            VStack(alignment: .leading, spacing: 1) {
                Text(
                    String(localized: "Approval", comment: "Event row: approval label")
                )
                .font(.caption)
                .fontWeight(.medium)

                Text(summary)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: - Question

    private func questionView(summary: String) -> some View {
        HStack(alignment: .top, spacing: 4) {
            Image(systemName: "questionmark.bubble")
                .font(.caption2)
                .foregroundStyle(.blue)

            VStack(alignment: .leading, spacing: 1) {
                Text(
                    String(localized: "Question", comment: "Event row: question label")
                )
                .font(.caption)
                .fontWeight(.medium)

                Text(summary)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: - Status change

    private func statusChangeView(from: String, to: String) -> some View {
        HStack(spacing: 4) {
            Image(systemName: "arrow.triangle.branch")
                .font(.caption2)
                .foregroundStyle(.secondary)

            Text(
                String(localized: "Status", comment: "Event row: status change label")
            )
            .font(.caption)
            .foregroundStyle(.secondary)

            Text(from)
                .font(.caption)
                .foregroundStyle(.secondary)

            Image(systemName: "arrow.right")
                .font(.caption2)
                .foregroundStyle(.tertiary)

            Text(to)
                .font(.caption)
                .fontWeight(.medium)
        }
    }

    // MARK: - Unknown / Empty

    private var unknownView: some View {
        HStack(spacing: 4) {
            Image(systemName: "questionmark.diamond")
                .font(.caption2)
                .foregroundStyle(.tertiary)

            Text(
                String(localized: "Unknown event", comment: "Event row: unknown event type")
            )
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }

    private var emptyView: some View {
        Text(event.eventType)
            .font(.caption)
            .foregroundStyle(.secondary)
    }
}

// MARK: - Preview

#Preview("Message (assistant)") {
    EventRow(
        event: TaskEvent(taskId: "t1", eventEpoch: 0, seq: 1, ts: Int(Date().timeIntervalSince1970 * 1000), eventType: "message", payloadData: encodePayload(["role": "assistant", "content": "I'll start by analyzing the project structure."]))
    )
    .padding(.horizontal)
}

#Preview("Message (user)") {
    EventRow(
        event: TaskEvent(taskId: "t1", eventEpoch: 0, seq: 2, ts: Int(Date().timeIntervalSince1970 * 1000), eventType: "message", payloadData: encodePayload(["role": "user", "content": "Add a new API endpoint for user registration."]))
    )
    .padding(.horizontal)
}

#Preview("Reasoning") {
    EventRow(
        event: TaskEvent(taskId: "t1", eventEpoch: 0, seq: 3, ts: Int(Date().timeIntervalSince1970 * 1000), eventType: "reasoning", payloadData: encodePayload(["content": "The user wants a registration endpoint."]))
    )
    .padding(.horizontal)
}

#Preview("Tool call") {
    EventRow(
        event: TaskEvent(taskId: "t1", eventEpoch: 0, seq: 4, ts: Int(Date().timeIntervalSince1970 * 1000), eventType: "tool_call", payloadData: encodePayload(["tool_name": "read_file", "description": "Read /Users/me/project/main.go"]))
    )
    .padding(.horizontal)
}

#Preview("Error") {
    EventRow(
        event: TaskEvent(taskId: "t1", eventEpoch: 0, seq: 5, ts: Int(Date().timeIntervalSince1970 * 1000), eventType: "error", payloadData: encodePayload(["message": "File not found"]))
    )
    .padding(.horizontal)
}

#Preview("Approval") {
    EventRow(
        event: TaskEvent(taskId: "t1", eventEpoch: 0, seq: 6, ts: Int(Date().timeIntervalSince1970 * 1000), eventType: "approval", payloadData: encodePayload(["id": "app-1", "description": "Write file /tmp/test.txt"]))
    )
    .padding(.horizontal)
}

#Preview("Question") {
    EventRow(
        event: TaskEvent(taskId: "t1", eventEpoch: 0, seq: 7, ts: Int(Date().timeIntervalSince1970 * 1000), eventType: "question", payloadData: encodePayload(["id": "q-1", "question": "Which port?"]))
    )
    .padding(.horizontal)
}

#Preview("Status change") {
    EventRow(
        event: TaskEvent(taskId: "t1", eventEpoch: 0, seq: 8, ts: Int(Date().timeIntervalSince1970 * 1000), eventType: "status_change", payloadData: encodePayload(["from": "running", "to": "waiting_approval"]))
    )
    .padding(.horizontal)
}

/// Helper to encode a dictionary as JSON Data for TaskEvent previews.
private func encodePayload(_ dict: [String: Any]) -> Data? {
    try? JSONSerialization.data(withJSONObject: dict)
}