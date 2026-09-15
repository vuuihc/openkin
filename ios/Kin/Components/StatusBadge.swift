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
        case .queued: return "Queued"
        case .running: return "Running"
        case .waitingApproval: return "Needs Approval"
        case .waitingInput: return "Needs Input"
        case .succeeded: return "Succeeded"
        case .completed: return "Completed"
        case .failed: return "Failed"
        case .cancelled: return "Cancelled"
        case .paused: return "Paused"
        case .unknown: return "Unknown"
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