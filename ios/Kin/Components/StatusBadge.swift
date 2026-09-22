import SwiftUI

/// A colored pill that displays the current task or agent status.
struct StatusBadge: View {
    let status: TaskStatus

    var body: some View {
        Text(status.displayName)
            .font(.caption2)
            .fontWeight(.medium)
            .foregroundStyle(.white)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(status.badgeColor)
            .clipShape(Capsule())
    }
}

extension TaskStatus {
    /// Human-readable label for the status.
    var displayName: String {
        switch self {
        case .queued: return String(localized: "task.status.queued")
        case .running: return String(localized: "task.status.running")
        case .waitingApproval: return String(localized: "task.status.waiting_approval")
        case .waitingInput: return String(localized: "task.status.waiting_input")
        case .succeeded: return String(localized: "task.status.succeeded")
        case .completed: return String(localized: "task.status.completed")
        case .failed: return String(localized: "task.status.failed")
        case .cancelled: return String(localized: "task.status.cancelled")
        case .paused: return String(localized: "task.status.paused")
        case .unknown: return String(localized: "task.status.unknown")
        }
    }

    /// Background color for the status badge.
    var badgeColor: Color {
        switch self {
        case .queued: return .orange
        case .running: return .blue
        case .waitingApproval: return .purple
        case .waitingInput: return .teal
        case .succeeded: return .green
        case .completed: return .green
        case .failed: return .red
        case .cancelled: return .gray
        case .paused: return .secondary
        case .unknown: return .secondary
        }
    }
}

#Preview(traits: .sizeThatFitsLayout) {
    VStack(spacing: 8) {
        StatusBadge(status: .queued)
        StatusBadge(status: .running)
        StatusBadge(status: .waitingApproval)
        StatusBadge(status: .waitingInput)
        StatusBadge(status: .completed)
        StatusBadge(status: .failed)
        StatusBadge(status: .cancelled)
        StatusBadge(status: .paused)
        StatusBadge(status: .unknown)
    }
    .padding()
}
