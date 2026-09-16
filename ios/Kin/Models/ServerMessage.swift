import Foundation

/// Canonical daemon WebSocket envelope: `{ "kind": String, "data": Object }`.
enum ServerMessage: Codable, Hashable {
    case taskUpdate(KinTask)
    case taskDeleted(id: String)
    case event(TaskEvent)
    case approvalUpdate(Approval)
    case userQuestionUpdate(UserQuestion)
    case unknown(kind: String, raw: Data)

    private enum CodingKeys: String, CodingKey {
        case kind
        case data
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        switch kind {
        case "task_update":
            self = .taskUpdate(try container.decode(KinTask.self, forKey: .data))
        case "task_deleted":
            self = .taskDeleted(id: try container.decode(TaskDeletedPayload.self, forKey: .data).id)
        case "event":
            self = .event(try container.decode(TaskEvent.self, forKey: .data))
        case "approval_update":
            self = .approvalUpdate(try container.decode(Approval.self, forKey: .data))
        case "user_question_update":
            self = .userQuestionUpdate(try container.decode(UserQuestion.self, forKey: .data))
        default:
            let raw = try container.decode(AnyCodable.self, forKey: .data)
            self = .unknown(kind: kind, raw: try JSONSerialization.data(withJSONObject: raw.jsonObject, options: [.fragmentsAllowed]))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .taskUpdate(let value):
            try container.encode("task_update", forKey: .kind)
            try container.encode(value, forKey: .data)
        case .taskDeleted(let id):
            try container.encode("task_deleted", forKey: .kind)
            try container.encode(TaskDeletedPayload(id: id), forKey: .data)
        case .event(let value):
            try container.encode("event", forKey: .kind)
            try container.encode(value, forKey: .data)
        case .approvalUpdate(let value):
            try container.encode("approval_update", forKey: .kind)
            try container.encode(value, forKey: .data)
        case .userQuestionUpdate(let value):
            try container.encode("user_question_update", forKey: .kind)
            try container.encode(value, forKey: .data)
        case .unknown(let kind, let raw):
            try container.encode(kind, forKey: .kind)
            try container.encode(JSONValue(data: raw), forKey: .data)
        }
    }
}

private struct TaskDeletedPayload: Codable, Hashable {
    let id: String
}

private struct AnyCodable: Decodable {
    let jsonObject: Any

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { jsonObject = NSNull() }
        else if let value = try? container.decode(Bool.self) { jsonObject = value }
        else if let value = try? container.decode(Int.self) { jsonObject = value }
        else if let value = try? container.decode(Double.self) { jsonObject = value }
        else if let value = try? container.decode(String.self) { jsonObject = value }
        else if let value = try? container.decode([AnyCodable].self) { jsonObject = value.map(\.jsonObject) }
        else if let value = try? container.decode([String: AnyCodable].self) { jsonObject = value.mapValues(\.jsonObject) }
        else { throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON") }
    }
}

private struct JSONValue: Encodable {
    let data: Data

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        let value = try JSONSerialization.jsonObject(with: data)
        if let value = value as? String { try container.encode(value) }
        else if let value = value as? Bool { try container.encode(value) }
        else if let value = value as? Int { try container.encode(value) }
        else if let value = value as? Double { try container.encode(value) }
        else if let value = value as? [Any] { try container.encode(value.map { String(describing: $0) }) }
        else { try container.encode(String(data: data, encoding: .utf8) ?? "") }
    }
}
