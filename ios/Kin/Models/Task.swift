import Foundation

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
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = TaskStatus(rawValue: raw) ?? .unknown
    }
}

/// Daemon task model. Timestamps are Unix milliseconds, matching the Go API.
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
    let createdAt: Int64
    let startedAt: Int64?
    let finishedAt: Int64?
    let elapsedSeconds: Double?
    let costUSD: Double?
    let sessionRef: String?
    let error: String?

    enum CodingKeys: String, CodingKey {
        case id, status, agent, model, cwd, prompt, error
        case permissionMode = "permission_mode"
        case workspaceMode = "workspace_mode"
        case approvalIds = "approval_ids"
        case questionIds = "question_ids"
        case createdAt = "created_at"
        case startedAt = "started_at"
        case finishedAt = "finished_at"
        case elapsedSeconds = "elapsed_seconds"
        case costUSD = "cost_usd"
        case sessionRef = "session_ref"
    }

    var createdDate: Date { Date(timeIntervalSince1970: Double(createdAt) / 1000) }
    var isTerminal: Bool {
        switch status {
        case .succeeded, .completed, .failed, .cancelled: return true
        default: return false
        }
    }
}
