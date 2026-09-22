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

/// Display-oriented task projection shared by task list and detail surfaces.
enum TaskPresentation {
    struct Summary: Equatable {
        let title: String
        let location: String
        let agentAndModel: String
        let elapsed: String
        let cost: String
        let needsUserAction: Bool
    }

    static func summary(for task: KinTask) -> Summary {
        Summary(
            title: task.prompt,
            location: task.cwd,
            agentAndModel: agentAndModel(for: task),
            elapsed: formatElapsed(task.elapsedSeconds),
            cost: formatCostUSD(task.costUSD),
            needsUserAction: task.status == .waitingApproval || task.status == .waitingInput
        )
    }

    static func filter(_ tasks: [KinTask], query: String) -> [KinTask] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return tasks }

        let needle = trimmed.lowercased()
        return tasks.filter { task in
            let summary = summary(for: task)
            return summary.title.lowercased().contains(needle)
                || summary.location.lowercased().contains(needle)
                || summary.agentAndModel.lowercased().contains(needle)
                || task.status.rawValue.lowercased().contains(needle)
        }
    }

    static func isCurrentProfileContext(boundProfileID: UUID?, activeProfileID: UUID?) -> Bool {
        guard let boundProfileID, let activeProfileID else { return true }
        return boundProfileID == activeProfileID
    }

    static func agentAndModel(for task: KinTask) -> String {
        let model = task.model?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let model, !model.isEmpty else { return task.agent }
        return "\(task.agent) / \(model)"
    }

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

    static func formatCostUSD(_ dollars: Double?) -> String {
        guard let dollars else { return "—" }
        if dollars < 0.01 {
            return "< $0.01"
        }
        return String(format: "$%.2f", dollars)
    }
}
