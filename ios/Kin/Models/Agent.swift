import Foundation

/// An agent available on the Kin desktop daemon.
///
/// The daemon returns:
/// ```json
/// {"id": "claude-code", "name": "Claude Code", "kind": "cli",
///  "available": true, "default": false, "capabilities": ["run"]}
/// ```
struct Agent: Identifiable, Codable, Hashable {
    let id: String
    let name: String
    let kind: String?
    let available: Bool?
    let isDefault: Bool?
    let capabilities: [String]?
    /// The model string from an available agent; nil for unavailable agents.
    let model: String?
    let models: [String]?

    enum CodingKeys: String, CodingKey {
        case id, name, kind, available
        case isDefault = "default"
        case capabilities, model, models
    }
}