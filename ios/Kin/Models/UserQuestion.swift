import Foundation

enum QuestionType: String, Codable, Hashable {
    case singleSelect = "single_select"
    case multiSelect = "multi_select"
    case freeText = "free_text"
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = QuestionType(rawValue: raw) ?? .unknown
    }
}

struct QuestionOption: Identifiable, Codable, Hashable {
    let id: String
    let label: String
    let selected: Bool?

    enum CodingKeys: String, CodingKey { case id, label, selected }

    init(id: String, label: String, selected: Bool?) {
        self.id = id
        self.label = label
        self.selected = selected
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let label = try c.decode(String.self, forKey: .label)
        self.id = try c.decodeIfPresent(String.self, forKey: .id) ?? label
        self.label = label
        self.selected = try c.decodeIfPresent(Bool.self, forKey: .selected)
    }
}

/// Native projection of the daemon's flattened question row and nested payload.
struct UserQuestion: Identifiable, Codable, Hashable {
    let id: String
    let taskId: String
    let question: String
    let type: QuestionType
    let options: [QuestionOption]?
    let otherText: String?
    let answeredAt: Int64?

    private struct Payload: Decodable {
        let question: String
        let options: [QuestionOption]
        let multiSelect: Bool?

        enum CodingKeys: String, CodingKey {
            case question, options
            case multiSelect = "multi_select"
        }
    }

    private struct Response: Decodable {
        let selected: [String]?
        let otherText: String?
        enum CodingKeys: String, CodingKey {
            case selected
            case otherText = "other_text"
        }
    }

    private enum CodingKeys: String, CodingKey {
        case id, taskId = "task_id", payload, response
        case answeredAt = "answered_at"
    }

    init(id: String, taskId: String, question: String, type: QuestionType,
         options: [QuestionOption]?, otherText: String?, answeredAt: Int64?) {
        self.id = id
        self.taskId = taskId
        self.question = question
        self.type = type
        self.options = options
        self.otherText = otherText
        self.answeredAt = answeredAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        taskId = try c.decode(String.self, forKey: .taskId)
        let payload = try c.decode(Payload.self, forKey: .payload)
        question = payload.question
        options = payload.options.isEmpty ? nil : payload.options
        type = payload.multiSelect == true ? .multiSelect : (payload.options.isEmpty ? .freeText : .singleSelect)
        answeredAt = try c.decodeIfPresent(Int64.self, forKey: .answeredAt)
        if let response = try c.decodeIfPresent(Response.self, forKey: .response) {
            otherText = response.otherText
        } else {
            otherText = nil
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(taskId, forKey: .taskId)
        try c.encode(answeredAt, forKey: .answeredAt)
    }
}
