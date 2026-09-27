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
    /// Selectable models the agent advertises; nil when it advertises none.
    let models: [AgentModelOption]?

    enum CodingKeys: String, CodingKey {
        case id, name, kind, available
        case isDefault = "default"
        case capabilities, model, models
    }
}

/// One selectable model from GET /api/agents.
struct AgentModelOption: Codable, Hashable {
    let id: String
    let label: String?
    let tier: String?

    enum CodingKeys: String, CodingKey {
        case id, label, tier
    }

    /// Picker text: the daemon's label when it supplies one, else the last path
    /// segment of the id — the fallback the console uses too, since configured
    /// provider models carry no label and their ids may be "vendor/model".
    var displayLabel: String {
        let label = label?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !label.isEmpty {
            return label
        }
        let id = id.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let slash = id.lastIndex(of: "/") else { return id }
        let segment = String(id[id.index(after: slash)...])
        return segment.isEmpty ? id : segment
    }
}
