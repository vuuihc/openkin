import Foundation

/// An agent available on the Kin desktop daemon.
struct Agent: Identifiable, Codable, Hashable {
    let id: String
    let name: String
    let provider: String
    let model: String
    let models: [String]?
    let description: String?
    let defaultModel: String?
    let capabilities: [String]?

    enum CodingKeys: String, CodingKey {
        case id = "name"
        case name = "label"
        case provider, model, models, description
        case defaultModel = "default_model"
        case capabilities
    }

    init(
        id: String,
        name: String,
        provider: String,
        model: String,
        models: [String]?,
        description: String?,
        defaultModel: String?,
        capabilities: [String]?
    ) {
        self.id = id
        self.name = name
        self.provider = provider
        self.model = model
        self.models = models
        self.description = description
        self.defaultModel = defaultModel
        self.capabilities = capabilities
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        // The JSON key "name" serves as both the agent id and the display name.
        let rawID = try container.decode(String.self, forKey: .id)
        id = rawID
        name = (try? container.decodeIfPresent(String.self, forKey: .name)) ?? rawID
        provider = try container.decode(String.self, forKey: .provider)
        model = try container.decode(String.self, forKey: .model)
        models = try container.decodeIfPresent([String].self, forKey: .models)
        description = try container.decodeIfPresent(String.self, forKey: .description)
        defaultModel = try container.decodeIfPresent(String.self, forKey: .defaultModel)
        capabilities = try container.decodeIfPresent([String].self, forKey: .capabilities)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(name, forKey: .name)
        try container.encode(provider, forKey: .provider)
        try container.encode(model, forKey: .model)
        try container.encodeIfPresent(models, forKey: .models)
        try container.encodeIfPresent(description, forKey: .description)
        try container.encodeIfPresent(defaultModel, forKey: .defaultModel)
        try container.encodeIfPresent(capabilities, forKey: .capabilities)
    }
}