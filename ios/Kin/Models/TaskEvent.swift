import Foundation

/// A single event in a task's execution timeline.
/// The daemon sends events with millisecond timestamps and a type discriminator
/// at the event level, not embedded in the payload.
struct TaskEvent: Identifiable, Codable, Hashable {
    let taskId: String
    let eventEpoch: Int64
    let seq: Int
    /// Unix millisecond timestamp
    let ts: Int
    /// Event type discriminator (message, tool_call, reasoning, etc.)
    let eventType: String
    /// Raw payload data; decoded lazily via `content` for known types
    let payloadData: Data?

    var id: String { "\(taskId)-\(eventEpoch)-\(seq)" }

    /// Derived content for known event types.
    var content: TaskEventContent? {
        guard let payloadData else { return nil }
        switch eventType {
        case "message":
            return decodeMessage(from: payloadData)
        case "reasoning":
            return decodeReasoning(from: payloadData)
        case "tool_call":
            return decodeToolCall(from: payloadData)
        case "error":
            return decodeError(from: payloadData)
        case "approval":
            return decodeApproval(from: payloadData)
        case "question":
            return decodeQuestion(from: payloadData)
        case "status_change":
            return decodeStatusChange(from: payloadData)
        default:
            return .unknown(raw: payloadData)
        }
    }

    init(taskId: String, eventEpoch: Int64, seq: Int, ts: Int, eventType: String, payloadData: Data?) {
        self.taskId = taskId
        self.eventEpoch = eventEpoch
        self.seq = seq
        self.ts = ts
        self.eventType = eventType
        self.payloadData = payloadData
    }

    enum CodingKeys: String, CodingKey {
        case taskId = "task_id"
        case eventEpoch = "event_epoch"
        case seq, ts
        case eventType = "type"
        case payload
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        taskId = try c.decode(String.self, forKey: .taskId)
        eventEpoch = try c.decode(Int64.self, forKey: .eventEpoch)
        seq = try c.decode(Int.self, forKey: .seq)
        ts = try c.decode(Int.self, forKey: .ts)
        eventType = try c.decode(String.self, forKey: .eventType)
        let raw = try c.decode(RawEventJSON.self, forKey: .payload)
        payloadData = try JSONSerialization.data(withJSONObject: raw.value, options: [.fragmentsAllowed])
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(taskId, forKey: .taskId)
        try c.encode(eventEpoch, forKey: .eventEpoch)
        try c.encode(seq, forKey: .seq)
        try c.encode(ts, forKey: .ts)
        try c.encode(eventType, forKey: .eventType)
        if let payloadData {
            try c.encode(JSONValue(data: payloadData), forKey: .payload)
        }
    }

    // MARK: - Payload decoding helpers

    private func decodeMessage(from data: Data) -> TaskEventContent? {
        guard let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        let role = dict["role"] as? String ?? dict["speaker"] as? String ?? ""
        // Content may be a string or an array of content blocks
        let text: String
        if let direct = dict["content"] as? String {
            text = direct
        } else if let blocks = dict["content"] as? [[String: Any]] {
            text = blocks.compactMap { $0["text"] as? String }.joined(separator: "\n")
        } else {
            text = ""
        }
        return .message(role: role, text: text)
    }

    private func decodeReasoning(from data: Data) -> TaskEventContent? {
        guard let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        let text = dict["content"] as? String ?? dict["text"] as? String ?? ""
        return .reasoning(text: text)
    }

    private func decodeToolCall(from data: Data) -> TaskEventContent? {
        guard let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        let name = dict["tool_name"] as? String ?? dict["name"] as? String ?? ""
        let summary = dict["summary"] as? String ?? dict["description"] as? String ?? name
        return .toolCall(name: name, summary: summary, input: nil, output: nil)
    }

    private func decodeError(from data: Data) -> TaskEventContent? {
        guard let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        let message = dict["message"] as? String ?? dict["error"] as? String ?? "Unknown error"
        return .error(message: message)
    }

    private func decodeApproval(from data: Data) -> TaskEventContent? {
        guard let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        let id = dict["approval_id"] as? String ?? dict["id"] as? String ?? ""
        let summary = dict["summary"] as? String ?? dict["description"] as? String ?? ""
        return .approval(id: id, summary: summary)
    }

    private func decodeQuestion(from data: Data) -> TaskEventContent? {
        guard let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        let id = dict["question_id"] as? String ?? dict["id"] as? String ?? ""
        let summary = dict["summary"] as? String ?? dict["question"] as? String ?? ""
        return .question(id: id, summary: summary)
    }

    private func decodeStatusChange(from data: Data) -> TaskEventContent? {
        guard let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        let from = dict["from"] as? String ?? ""
        let to = dict["to"] as? String ?? ""
        return .statusChange(from: from, to: to)
    }
}

private struct RawEventJSON: Decodable {
    let value: Any

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { value = NSNull() }
        else if let v = try? c.decode(String.self) { value = v }
        else if let v = try? c.decode(Bool.self) { value = v }
        else if let v = try? c.decode(Int.self) { value = v }
        else if let v = try? c.decode(Double.self) { value = v }
        else if let v = try? c.decode([RawEventJSON].self) { value = v.map(\.value) }
        else if let v = try? c.decode([String: RawEventJSON].self) { value = v.mapValues(\.value) }
        else { throw DecodingError.dataCorruptedError(in: c, debugDescription: "Unsupported JSON") }
    }
}

private struct JSONValue: Encodable {
    let data: Data
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        let object = try JSONSerialization.jsonObject(with: data)
        try c.encode(String(data: JSONSerialization.data(withJSONObject: object), encoding: .utf8) ?? "")
    }
}

/// The typed payload of a task event, derived from the event type + payload.
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
