import Foundation

/// Represents the current status of a task on the daemon.
enum TaskStatus: String, Codable, CaseIterable, Hashable {
    case queued
    case running
    case waitingApproval = "waiting_approval"
    case waitingInput = "waiting_input"
    case succeeded
    case completed
    case failed
    case cancelled
    case paused
    case unknown

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let rawValue = try container.decode(String.self)
        self = TaskStatus(rawValue: rawValue) ?? .unknown
    }
}

/// A task executed by the Kin agent daemon.
///
/// Named `KinTask` to avoid shadowing Swift's `Task` type.
struct KinTask: Identifiable, Codable, Hashable {
    let id: String
    let status: TaskStatus
    let agent: String
    let model: String?
    let cwd: String
    let prompt: String
    let permissionMode: String?
    let workspaceMode: String?
    let approvalIds: [String]?
    let questionIds: [String]?
    let createdAt: Date
    let updatedAt: Date?
    let elapsedSeconds: Double?
    let costCents: Double?
    let sessionId: String?
    let error: String?

    enum CodingKeys: String, CodingKey {
        case id, status, agent, model, cwd, prompt, error
        case permissionMode = "permission_mode"
        case workspaceMode = "workspace_mode"
        case approvalIds = "approval_ids"
        case questionIds = "question_ids"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case elapsedSeconds = "elapsed_seconds"
        case costCents = "cost_cents"
        case sessionId = "session_id"
    }

    /// Whether the task has reached a terminal state.
    var isTerminal: Bool {
        switch status {
        case .succeeded, .completed, .failed, .cancelled: return true
        default: return false
        }
    }
}