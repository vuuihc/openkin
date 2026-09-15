import Foundation

/// The type of question posed to the user.
enum QuestionType: String, Codable, Hashable {
    case singleSelect = "single_select"
    case multiSelect = "multi_select"
    case freeText = "free_text"
    case unknown

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let rawValue = try container.decode(String.self)
        self = QuestionType(rawValue: rawValue) ?? .unknown
    }
}

/// An option within a selection-type question.
struct QuestionOption: Identifiable, Codable, Hashable {
    let id: String
    let label: String
    let selected: Bool?
}

/// A question posed by the Kin agent daemon requiring user input.
struct UserQuestion: Identifiable, Codable, Hashable {
    let id: String
    let taskId: String
    let question: String
    let type: QuestionType
    let options: [QuestionOption]?
    let otherText: String?
    let answeredAt: Date?

    enum CodingKeys: String, CodingKey {
        case id
        case taskId = "task_id"
        case question, type, options
        case otherText = "other_text"
        case answeredAt = "answered_at"
    }
}