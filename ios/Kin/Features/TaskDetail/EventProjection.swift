import Foundation
import SwiftUI

/// Projection helpers for rendering task events in the timeline UI.
enum EventProjection {
    /// Display-ready row model for a single task event.
    struct DisplayRow: Identifiable {
        let id: String
        let seq: Int
        let timestamp: Date
        let icon: String
        let iconColor: Color
        let primaryText: String
        let secondaryText: String?
        let isUserMessage: Bool
        let level: String?
        let isCollapsible: Bool
        let rawContent: TaskEventContent?
    }

    /// Convert a `TaskEvent` into a `DisplayRow` with all fields populated
    /// for rendering in the timeline.
    static func project(_ event: TaskEvent) -> DisplayRow {
        let seq = event.seq
        let date = Date(timeIntervalSince1970: Double(event.ts) / 1000.0)

        switch event.content {
        case .message(_, let text, let speaker, _):
            return messageRow(
                seq: seq,
                date: date,
                speaker: speaker,
                text: text,
                content: event.content
            )

        case .reasoning(let text):
            return DisplayRow(
                id: "\(seq)-reasoning",
                seq: seq,
                timestamp: date,
                icon: "brain.head.profile",
                iconColor: .orange,
                primaryText: text,
                secondaryText: nil,
                isUserMessage: false,
                level: nil,
                isCollapsible: true,
                rawContent: event.content
            )

        case .toolCall(let name, let summary, _, _):
            return DisplayRow(
                id: "\(seq)-toolcall",
                seq: seq,
                timestamp: date,
                icon: "wrench.and.screwdriver.fill",
                iconColor: .blue,
                primaryText: name,
                secondaryText: summary,
                isUserMessage: false,
                level: nil,
                isCollapsible: true,
                rawContent: event.content
            )

        case .error(let message):
            return DisplayRow(
                id: "\(seq)-error",
                seq: seq,
                timestamp: date,
                icon: "exclamationmark.triangle.fill",
                iconColor: .red,
                primaryText: message,
                secondaryText: nil,
                isUserMessage: false,
                level: nil,
                isCollapsible: false,
                rawContent: event.content
            )

        case .approval(_, let summary):
            return DisplayRow(
                id: "\(seq)-approval",
                seq: seq,
                timestamp: date,
                icon: "checkmark.shield.fill",
                iconColor: .green,
                primaryText: String(localized: "event.approval_request"),
                secondaryText: summary,
                isUserMessage: false,
                level: nil,
                isCollapsible: false,
                rawContent: event.content
            )

        case .question(_, let summary):
            return DisplayRow(
                id: "\(seq)-question",
                seq: seq,
                timestamp: date,
                icon: "questionmark.bubble.fill",
                iconColor: .teal,
                primaryText: String(localized: "event.question"),
                secondaryText: summary,
                isUserMessage: false,
                level: nil,
                isCollapsible: false,
                rawContent: event.content
            )

        case .statusChange(let from, let to):
            return DisplayRow(
                id: "\(seq)-statuschange",
                seq: seq,
                timestamp: date,
                icon: "arrow.triangle.swap",
                iconColor: .gray,
                primaryText: String(
                    format: String(localized: "event.status_change_format"),
                    from,
                    to
                ),
                secondaryText: nil,
                isUserMessage: false,
                level: nil,
                isCollapsible: false,
                rawContent: event.content
            )

        case .unknown:
            return DisplayRow(
                id: "\(seq)-unknown",
                seq: seq,
                timestamp: date,
                icon: "questionmark",
                iconColor: .secondary,
                primaryText: String(localized: "event.unknown"),
                secondaryText: nil,
                isUserMessage: false,
                level: nil,
                isCollapsible: false,
                rawContent: event.content
            )

        case nil:
            return DisplayRow(
                id: "\(seq)-nil",
                seq: seq,
                timestamp: date,
                icon: "questionmark",
                iconColor: .secondary,
                primaryText: String(localized: "event.empty"),
                secondaryText: nil,
                isUserMessage: false,
                level: nil,
                isCollapsible: false,
                rawContent: nil
            )
        }
    }

    /// Event types the transcript never shows. They carry accounting, cost, or
    /// lifecycle detail that the console keeps out of the chat log, and they land
    /// in the middle of a streaming run — `usage` and `raw_output` arrive between
    /// a turn's last chunk and its summary — so rendering them would both add
    /// placeholder rows and split the answer apart.
    private static let unrenderedEventTypes: Set<String> = [
        "usage",
        "raw_output",
        "task_started",
        "result",
        "approval_decided",
        "checkpoint_skipped",
        "orchestration_fallback",
        "limit_hit",
        "meta",
    ]

    /// Project a whole event list into the rows the timeline shows.
    ///
    /// The daemon stores a turn's live output as a run of `partial` message
    /// events followed by one non-partial message holding the complete text, so a
    /// row per event shows every chunk as its own bubble and then the whole answer
    /// again. Chunks are accumulated here and dropped when the message that
    /// supersedes them arrives, matching the console's transcript projection.
    static func rows(from events: [TaskEvent]) -> [DisplayRow] {
        var rows: [DisplayRow] = []
        /// The message being accumulated, keyed by the seq and timestamp that
        /// opened it so the live row keeps a stable identity while it grows.
        var stream: (seq: Int, ts: Int, role: String, speaker: String, text: String)?
        /// Chunks already shown for the current turn. A preview only stands until
        /// the message that supersedes it arrives, which then removes it: a turn
        /// that streams, does tool work, streams again, and ends with one complete
        /// message streams the same answer twice over.
        var previews: [(id: String, speaker: String)] = []

        func flushStream() {
            guard let pending = stream else { return }
            stream = nil
            guard !isBlank(pending.text) else { return }
            // A run with no final message yet is the live answer: show what has
            // arrived so far rather than holding it back until the turn ends.
            let row = messageRow(
                seq: pending.seq,
                date: Date(timeIntervalSince1970: Double(pending.ts) / 1000.0),
                speaker: pending.speaker,
                text: pending.text
            )
            rows.append(row)
            previews.append((row.id, pending.speaker))
        }

        for event in events {
            guard !unrenderedEventTypes.contains(event.eventType) else { continue }
            switch event.content {
            case let .message(role, text, speaker, partial) where partial:
                if let openedBy = stream, openedBy.speaker != speaker || openedBy.role != role {
                    flushStream()
                }
                let openedBy = stream
                stream = (
                    seq: openedBy?.seq ?? event.seq,
                    ts: openedBy?.ts ?? event.ts,
                    role: role,
                    speaker: speaker,
                    text: (openedBy?.text ?? "") + text
                )

            case let .message(role, text, speaker, _):
                // The non-partial message is the authoritative copy of the run it
                // closes. Drop the accumulated preview instead of flushing it, and
                // take back what this speaker already streamed in this turn, which
                // would otherwise repeat the same text.
                if let openedBy = stream, openedBy.speaker == speaker, openedBy.role == role {
                    stream = nil
                } else {
                    flushStream()
                }
                if speaker == "user" {
                    // A new user turn ends the run; older previews stand.
                    previews.removeAll()
                } else {
                    // The console also takes back previews across tool work, but
                    // stops at notices such as approvals, which it shows in a
                    // progress card that keeps the earlier text. The timeline has
                    // no such card, so here a notice does not end the run: text
                    // streamed before it belongs to the same answer.
                    let superseded = Set(
                        previews.lazy.filter { $0.speaker == speaker }.map(\.id)
                    )
                    if !superseded.isEmpty {
                        rows.removeAll { superseded.contains($0.id) }
                        previews.removeAll { superseded.contains($0.id) }
                    }
                }
                // Empty messages are echoes of tool output the daemon stamps with
                // a role but no text; they are not transcript lines.
                guard !isBlank(text) else { continue }
                rows.append(project(event))

            default:
                flushStream()
                let row = project(event)
                rows.append(row)
                // Failures end the run, so nothing later supersedes its previews.
                if event.eventType == "error" { previews.removeAll() }
            }
        }
        flushStream()
        return rows
    }

    /// Whether a message carries nothing to show.
    private static func isBlank(_ text: String) -> Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Row for a message. A run of chunks that is still streaming renders under
    /// the seq that opened it; the message that completes the run replaces it.
    ///
    /// The speaker decides the column, not the role: a tool-result echo or a
    /// skill preamble carries `role: "user"` while naming the agent that
    /// produced it, and the console gives those to the agent column too.
    private static func messageRow(
        seq: Int,
        date: Date,
        speaker: String,
        text: String,
        content: TaskEventContent? = nil
    ) -> DisplayRow {
        let isUser = speaker == "user"
        return DisplayRow(
            id: "\(seq)-message",
            seq: seq,
            timestamp: date,
            icon: isUser ? "person.fill" : "brain",
            iconColor: isUser ? .accentColor : .purple,
            primaryText: text,
            secondaryText: nil,
            isUserMessage: isUser,
            level: nil,
            isCollapsible: false,
            rawContent: content
        )
    }

    /// Format a `Date` as a short time string for the timeline.
    static func formatTimestamp(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .medium
        return formatter.string(from: date)
    }

    /// Format `elapsedSeconds` as a human-readable duration string.
    static func formatElapsed(_ seconds: Double?) -> String {
        TaskPresentation.formatElapsed(seconds)
    }

    /// Format `costCents` (in hundredths of a cent) as a display string.
    static func formatCost(_ cents: Double?) -> String {
        guard let cents else { return "—" }
        return TaskPresentation.formatCostUSD(cents / 100.0)
    }
}
