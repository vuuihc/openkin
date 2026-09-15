import Foundation

/// Messages received from the Kin daemon WebSocket endpoint.
enum ServerMessage: Codable, Hashable {
    case taskUpdate(KinTask)
    case taskDeleted(id: String)
    case event(taskId: String, event: TaskEvent)
    case approvalUpdate(Approval)
    case userQuestionUpdate(UserQuestion)
    case unknown(type: String, raw: Data)

    /// Decode the unknown payload as a `[String: Any]` dictionary, if possible.
    var rawJSON: [String: Any]? {
        guard case let .unknown(_, data) = self else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    // MARK: - Codable

    private enum CodingKeys: String, CodingKey {
        case type
        case payload
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let messageType = try container.decode(String.self, forKey: .type)

        switch messageType {
        case "task_update":
            let task = try container.decode(KinTask.self, forKey: .payload)
            self = .taskUpdate(task)

        case "task_deleted":
            let deleted = try container.decode(TaskDeletedPayload.self, forKey: .payload)
            self = .taskDeleted(id: deleted.id)

        case "event":
            let eventPayload = try container.decode(EventPayload.self, forKey: .payload)
            self = .event(taskId: eventPayload.taskId, event: eventPayload.event)

        case "approval_update":
            let approval = try container.decode(Approval.self, forKey: .payload)
            self = .approvalUpdate(approval)

        case "user_question_update":
            let question = try container.decode(UserQuestion.self, forKey: .payload)
            self = .userQuestionUpdate(question)

        default:
            let rawData = try JSONSerialization.data(
                withJSONObject: try container.decode(AnyCodable.self, forKey: .payload).jsonObject,
                options: [.fragmentsAllowed]
            )
            self = .unknown(type: messageType, raw: rawData)
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)

        switch self {
        case let .taskUpdate(task):
            try container.encode("task_update", forKey: .type)
            try container.encode(task, forKey: .payload)

        case let .taskDeleted(id):
            try container.encode("task_deleted", forKey: .type)
            try container.encode(TaskDeletedPayload(id: id), forKey: .payload)

        case let .event(taskId, event):
            try container.encode("event", forKey: .type)
            try container.encode(EventPayload(taskId: taskId, event: event), forKey: .payload)

        case let .approvalUpdate(approval):
            try container.encode("approval_update", forKey: .type)
            try container.encode(approval, forKey: .payload)

        case let .userQuestionUpdate(question):
            try container.encode("user_question_update", forKey: .type)
            try container.encode(question, forKey: .payload)

        case let .unknown(type, raw):
            try container.encode(type, forKey: .type)
            try container.encode(raw, forKey: .payload)
        }
    }
}

// MARK: - Internal payload wrappers

private struct TaskDeletedPayload: Codable, Hashable {
    let id: String
}

private struct EventPayload: Codable, Hashable {
    let taskId: String
    let event: TaskEvent

    enum CodingKeys: String, CodingKey {
        case taskId = "task_id"
        case event
    }
}

/// Internal wrapper that bridges arbitrary JSON into a `[String: Any]` dictionary.
private struct AnyCodable: Decodable {
    let jsonObject: Any

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()

        if container.decodeNil() {
            jsonObject = NSNull()
        } else if let bool = try? container.decode(Bool.self) {
            jsonObject = bool
        } else if let int = try? container.decode(Int.self) {
            jsonObject = int
        } else if let double = try? container.decode(Double.self) {
            jsonObject = double
        } else if let string = try? container.decode(String.self) {
            jsonObject = string
        } else if let array = try? container.decode([AnyCodable].self) {
            jsonObject = array.map(\.jsonObject)
        } else if let dict = try? container.decode([String: AnyCodable].self) {
            jsonObject = dict.mapValues(\.jsonObject)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Unsupported JSON value for unknown server message"
            )
        }
    }
}