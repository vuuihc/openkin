import Foundation

/// The status of an approval request.
enum ApprovalStatus: String, Codable, CaseIterable, Hashable {
    case pending
    case approved
    case denied
    case expired
    case unknown

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let rawValue = try container.decode(String.self)
        self = ApprovalStatus(rawValue: rawValue) ?? .unknown
    }
}

/// An approval request from the Kin agent daemon, typically for tool execution.
struct Approval: Identifiable, Codable, Hashable {
    let id: String
    let taskId: String
    let agentName: String?
    let modelName: String?
    let toolName: String?
    let command: String?
    let path: String?
    let inputDetail: String?
    let status: ApprovalStatus
    let createdAt: Date
    let decidedAt: Date?
    let decidedVia: String?

    enum CodingKeys: String, CodingKey {
        case id
        case taskId = "task_id"
        case agentName = "agent_name"
        case modelName = "model_name"
        case toolName = "tool_name"
        case command, path
        case inputDetail = "input_detail"
        case status
        case createdAt = "created_at"
        case decidedAt = "decided_at"
        case decidedVia = "decided_via"
    }
}