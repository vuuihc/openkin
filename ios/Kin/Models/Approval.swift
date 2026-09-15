import Foundation

/// The status of an approval request.
/// The daemon sends this as the `decision` field with values "pending", "approved", "denied".
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
///
/// The daemon sends approvals with a nested payload structure:
/// ```json
/// {
///   "id": "...",
///   "task_id": "...",
///   "kind": "tool_use",
///   "payload": { "tool_name": "Bash", "input": { "command": "...", "description": "..." } },
///   "decision": "pending",
///   "created_at": 1784974465506  // millisecond epoch
/// }
/// ```
struct Approval: Identifiable, Codable, Hashable {
    let id: String
    let taskId: String
    let kind: String?
    /// Extracted from payload.tool_name
    let toolName: String?
    /// Extracted from payload.input.command
    let command: String?
    /// Extracted from payload.input.description
    let inputDetail: String?
    /// The daemon's `decision` field
    let status: ApprovalStatus
    /// Unix millisecond timestamp
    let createdAt: Int
    /// Unix millisecond timestamp
    let decidedAt: Int?
    let decidedVia: String?

    init(id: String, taskId: String, kind: String? = nil, toolName: String? = nil, command: String? = nil, inputDetail: String? = nil, status: ApprovalStatus, createdAt: Int, decidedAt: Int? = nil, decidedVia: String? = nil) {
        self.id = id
        self.taskId = taskId
        self.kind = kind
        self.toolName = toolName
        self.command = command
        self.inputDetail = inputDetail
        self.status = status
        self.createdAt = createdAt
        self.decidedAt = decidedAt
        self.decidedVia = decidedVia
    }

    enum CodingKeys: String, CodingKey {
        case id
        case taskId = "task_id"
        case kind
        case payload
        case status = "decision"
        case createdAt = "created_at"
        case decidedAt = "decided_at"
        case decidedVia = "decided_via"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        taskId = try container.decode(String.self, forKey: .taskId)
        kind = try container.decodeIfPresent(String.self, forKey: .kind)
        status = try container.decode(ApprovalStatus.self, forKey: .status)
        createdAt = try container.decode(Int.self, forKey: .createdAt)
        decidedAt = try container.decodeIfPresent(Int.self, forKey: .decidedAt)
        decidedVia = try container.decodeIfPresent(String.self, forKey: .decidedVia)

        // Extract tool info from nested payload
        if let payload = try container.decodeIfPresent([String: Any].self, forKey: .payload) {
            toolName = payload["tool_name"] as? String
            if let input = payload["input"] as? [String: Any] {
                command = input["command"] as? String
                inputDetail = input["description"] as? String
            } else {
                command = nil
                inputDetail = nil
            }
        } else {
            toolName = nil
            command = nil
            inputDetail = nil
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(taskId, forKey: .taskId)
        try container.encodeIfPresent(kind, forKey: .kind)
        try container.encode(status, forKey: .status)
        try container.encode(createdAt, forKey: .createdAt)
        try container.encodeIfPresent(decidedAt, forKey: .decidedAt)
        try container.encodeIfPresent(decidedVia, forKey: .decidedVia)
    }
}

// MARK: - Helper for decoding arbitrary JSON dicts

extension KeyedDecodingContainer {
    func decodeIfPresent(_ type: [String: Any].Type, forKey key: KeyedDecodingContainer.Key) throws -> [String: Any]? {
        guard contains(key) else { return nil }
        let data = try encodeToData(forKey: key)
        guard let dict = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw DecodingError.typeMismatch(
                [String: Any].self,
                DecodingError.Context(codingPath: [key], debugDescription: "Expected dictionary")
            )
        }
        return dict
    }

    private func encodeToData(forKey key: KeyedDecodingContainer.Key) throws -> Data {
        // Encode the nested value back to data for JSONSerialization
        let container = try self.decode(JSONValue.self, forKey: key)
        return try JSONEncoder().encode(container)
    }
}

/// Minimal JSON value wrapper for re-serialization.
private enum JSONValue: Codable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null; return }
        if let v = try? container.decode(Bool.self) { self = .bool(v); return }
        if let v = try? container.decode(Double.self) { self = .number(v); return }
        if let v = try? container.decode(String.self) { self = .string(v); return }
        if let v = try? container.decode([String: JSONValue].self) { self = .object(v); return }
        if let v = try? container.decode([JSONValue].self) { self = .array(v); return }
        throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON value")
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let v): try container.encode(v)
        case .number(let v): try container.encode(v)
        case .string(let v): try container.encode(v)
        case .array(let v): try container.encode(v)
        case .object(let v): try container.encode(v)
        }
    }
}