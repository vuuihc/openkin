import Foundation

/// A single event in a task's execution timeline.
struct TaskEvent: Identifiable, Codable, Hashable {
    let seq: Int
    let eventType: String
    let timestamp: Date
    let content: TaskEventContent?
    let level: String?

    var id: String { "\(seq)" }

    enum CodingKeys: String, CodingKey {
        case seq
        case eventType = "event_type"
        case timestamp
        case content
        case level
    }
}

/// The typed payload of a task event, discriminated by event type on the wire.
enum TaskEventContent: Hashable {
    case message(role: String, text: String)
    case reasoning(text: String)
    case toolCall(name: String, summary: String, input: String?, output: String?)
    case error(message: String)
    case approval(id: String, summary: String)
    case question(id: String, summary: String)
    case statusChange(from: String, to: String)
    /// Preserves the raw JSON bytes for unrecognised event types.
    case unknown(raw: Data)

    /// Attempt to decode the unknown payload as a `[String: Any]` dictionary.
    var rawJSON: [String: Any]? {
        guard case let .unknown(data) = self else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }
}

extension TaskEventContent: Codable {
    private enum CodingKeys: String, CodingKey {
        case type
        case role, text
        case name, summary, input, output
        case message
        case id
        case from, to
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)

        switch type {
        case "message":
            let role = try container.decode(String.self, forKey: .role)
            let text = try container.decode(String.self, forKey: .text)
            self = .message(role: role, text: text)

        case "reasoning":
            let text = try container.decode(String.self, forKey: .text)
            self = .reasoning(text: text)

        case "tool_call":
            let name = try container.decode(String.self, forKey: .name)
            let summary = try container.decode(String.self, forKey: .summary)
            let input = try container.decodeIfPresent(String.self, forKey: .input)
            let output = try container.decodeIfPresent(String.self, forKey: .output)
            self = .toolCall(name: name, summary: summary, input: input, output: output)

        case "error":
            let message = try container.decode(String.self, forKey: .message)
            self = .error(message: message)

        case "approval":
            let id = try container.decode(String.self, forKey: .id)
            let summary = try container.decode(String.self, forKey: .summary)
            self = .approval(id: id, summary: summary)

        case "question":
            let id = try container.decode(String.self, forKey: .id)
            let summary = try container.decode(String.self, forKey: .summary)
            self = .question(id: id, summary: summary)

        case "status_change":
            let from = try container.decode(String.self, forKey: .from)
            let to = try container.decode(String.self, forKey: .to)
            self = .statusChange(from: from, to: to)

        default:
            let rawData = try JSONSerialization.data(
                withJSONObject: try decoder.singleValueContainer().decode(AnyCodable.self).jsonObject,
                options: [.fragmentsAllowed]
            )
            self = .unknown(raw: rawData)
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)

        switch self {
        case let .message(role, text):
            try container.encode("message", forKey: .type)
            try container.encode(role, forKey: .role)
            try container.encode(text, forKey: .text)

        case let .reasoning(text):
            try container.encode("reasoning", forKey: .type)
            try container.encode(text, forKey: .text)

        case let .toolCall(name, summary, input, output):
            try container.encode("tool_call", forKey: .type)
            try container.encode(name, forKey: .name)
            try container.encode(summary, forKey: .summary)
            try container.encodeIfPresent(input, forKey: .input)
            try container.encodeIfPresent(output, forKey: .output)

        case let .error(message):
            try container.encode("error", forKey: .type)
            try container.encode(message, forKey: .message)

        case let .approval(id, summary):
            try container.encode("approval", forKey: .type)
            try container.encode(id, forKey: .id)
            try container.encode(summary, forKey: .summary)

        case let .question(id, summary):
            try container.encode("question", forKey: .type)
            try container.encode(id, forKey: .id)
            try container.encode(summary, forKey: .summary)

        case let .statusChange(from, to):
            try container.encode("status_change", forKey: .type)
            try container.encode(from, forKey: .from)
            try container.encode(to, forKey: .to)

        case let .unknown(raw):
            // Re-serialize the raw data into the single-value container.
            var single = encoder.singleValueContainer()
            try single.encode(raw)
        }
    }
}

// MARK: - Helper for decoding unknown JSON values

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
                debugDescription: "Unsupported JSON value for unknown event content"
            )
        }
    }
}