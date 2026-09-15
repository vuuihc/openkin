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

        switch event.content {
        case .message(let role, let text):
            let isUser = role == "user"
            return DisplayRow(
                id: "\(seq)-message",
                seq: seq,
                timestamp: event.timestamp,
                icon: isUser ? "person.fill" : "brain",
                iconColor: isUser ? .accentColor : .purple,
                primaryText: text,
                secondaryText: nil,
                isUserMessage: isUser,
                level: event.level,
                isCollapsible: false,
                rawContent: event.content
            )

        case .reasoning(let text):
            return DisplayRow(
                id: "\(seq)-reasoning",
                seq: seq,
                timestamp: event.timestamp,
                icon: "brain.head.profile",
                iconColor: .orange,
                primaryText: text,
                secondaryText: nil,
                isUserMessage: false,
                level: event.level,
                isCollapsible: true,
                rawContent: event.content
            )

        case .toolCall(let name, let summary, _, _):
            return DisplayRow(
                id: "\(seq)-toolcall",
                seq: seq,
                timestamp: event.timestamp,
                icon: "wrench.and.screwdriver.fill",
                iconColor: .blue,
                primaryText: name,
                secondaryText: summary,
                isUserMessage: false,
                level: event.level,
                isCollapsible: true,
                rawContent: event.content
            )

        case .error(let message):
            return DisplayRow(
                id: "\(seq)-error",
                seq: seq,
                timestamp: event.timestamp,
                icon: "exclamationmark.triangle.fill",
                iconColor: .red,
                primaryText: message,
                secondaryText: nil,
                isUserMessage: false,
                level: event.level,
                isCollapsible: false,
                rawContent: event.content
            )

        case .approval(_, let summary):
            return DisplayRow(
                id: "\(seq)-approval",
                seq: seq,
                timestamp: event.timestamp,
                icon: "checkmark.shield.fill",
                iconColor: .green,
                primaryText: "Approval Request",
                secondaryText: summary,
                isUserMessage: false,
                level: event.level,
                isCollapsible: false,
                rawContent: event.content
            )

        case .question(_, let summary):
            return DisplayRow(
                id: "\(seq)-question",
                seq: seq,
                timestamp: event.timestamp,
                icon: "questionmark.bubble.fill",
                iconColor: .teal,
                primaryText: "Question",
                secondaryText: summary,
                isUserMessage: false,
                level: event.level,
                isCollapsible: false,
                rawContent: event.content
            )

        case .statusChange(let from, let to):
            return DisplayRow(
                id: "\(seq)-statuschange",
                seq: seq,
                timestamp: event.timestamp,
                icon: "arrow.triangle.swap",
                iconColor: .gray,
                primaryText: "Status: \(from) → \(to)",
                secondaryText: nil,
                isUserMessage: false,
                level: event.level,
                isCollapsible: false,
                rawContent: event.content
            )

        case .unknown:
            return DisplayRow(
                id: "\(seq)-unknown",
                seq: seq,
                timestamp: event.timestamp,
                icon: "questionmark",
                iconColor: .secondary,
                primaryText: "Unknown event",
                secondaryText: nil,
                isUserMessage: false,
                level: event.level,
                isCollapsible: false,
                rawContent: event.content
            )

        case nil:
            return DisplayRow(
                id: "\(seq)-nil",
                seq: seq,
                timestamp: event.timestamp,
                icon: "questionmark",
                iconColor: .secondary,
                primaryText: "Empty event",
                secondaryText: nil,
                isUserMessage: false,
                level: event.level,
                isCollapsible: false,
                rawContent: nil
            )
        }
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
        guard let seconds, seconds >= 0 else { return "—" }

        if seconds < 60 {
            return "\(Int(seconds))s"
        }
        let minutes = Int(seconds) / 60
        let secs = Int(seconds) % 60
        if minutes < 60 {
            return "\(minutes)m \(secs)s"
        }
        let hours = minutes / 60
        let mins = minutes % 60
        return "\(hours)h \(mins)m"
    }

    /// Format `costCents` (in hundredths of a cent) as a display string.
    static func formatCost(_ cents: Double?) -> String {
        guard let cents else { return "—" }
        let dollars = cents / 100.0
        if dollars < 0.01 {
            return "< $0.01"
        }
        return String(format: "$%.2f", dollars)
    }
}