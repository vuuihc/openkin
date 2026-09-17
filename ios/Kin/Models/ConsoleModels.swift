import Foundation

struct Artifact: Identifiable, Codable, Hashable {
    let id: String
    var title: String
    var kind: String
    var size: Int64
    var status: String
    var sourceTaskId: String?
    var sourceTaskTitle: String?
    var createdAt: Int64
    var updatedAt: Int64

    enum CodingKeys: String, CodingKey {
        case id, title, kind, size, status
        case sourceTaskId = "source_task_id"
        case sourceTaskTitle = "source_task_title"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

struct Project: Identifiable, Codable, Hashable {
    let id: String
    var name: String
    var mode: String
    var status: String
    var softProgress: String?
    var createdAt: Int64
    var updatedAt: Int64
    var lastActiveAt: Int64
    var roots: [String]?
    var onePagerPath: String?

    enum CodingKeys: String, CodingKey {
        case id, name, mode, status, roots
        case softProgress = "soft_progress"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case lastActiveAt = "last_active_at"
        case onePagerPath = "one_pager_path"
    }
}

struct OnePager: Codable, Hashable {
    let projectId: String
    var markdown: String
    var updatedAt: Int64
    var onePagerSummary: OnePagerSummary?

    enum CodingKeys: String, CodingKey {
        case projectId = "project_id"
        case markdown
        case updatedAt = "updated_at"
        case onePagerSummary = "one_pager_summary"
    }
}

struct OnePagerSummary: Codable, Hashable {
    var name: String?
    var mode: String?
    var northStar: String?
    var focus: String?
    var next: [String]?
    var empty: Bool?

    enum CodingKeys: String, CodingKey {
        case name, mode
        case northStar = "north_star"
        case focus, next, empty
    }
}

struct ProjectPulse: Codable, Hashable {
    let projectId: String
    let generatedAt: Int64
    let windowDays: Int
    let sessionTotal: Int
    let sessionWindow: Int
    let sessionsRunning: Int
    let sessionsWaiting: Int
    let lastSessionAt: Int64?
    let gitAvailable: Bool
    let gitRoot: String?
    let commitWindow: Int
    let autoMarkdown: String

    enum CodingKeys: String, CodingKey {
        case projectId = "project_id"
        case generatedAt = "generated_at"
        case windowDays = "window_days"
        case sessionTotal = "session_total"
        case sessionWindow = "session_window"
        case sessionsRunning = "sessions_running"
        case sessionsWaiting = "sessions_waiting"
        case lastSessionAt = "last_session_at"
        case gitAvailable = "git_available"
        case gitRoot = "git_root"
        case commitWindow = "commit_window"
        case autoMarkdown = "auto_markdown"
    }
}

struct Routine: Identifiable, Codable, Hashable {
    let id: String
    var projectId: String?
    var cwd: String
    var agent: String
    var permissionMode: String
    var prompt: String
    var intervalSecs: Int
    var enabled: Bool
    var lastRunAt: Int64?
    var nextDueAt: Int64
    var consecFailures: Int
    var createdAt: Int64
    var title: String

    enum CodingKeys: String, CodingKey {
        case id, cwd, agent, prompt, enabled, title
        case projectId = "project_id"
        case permissionMode = "permission_mode"
        case intervalSecs = "interval_secs"
        case lastRunAt = "last_run_at"
        case nextDueAt = "next_due_at"
        case consecFailures = "consec_failures"
        case createdAt = "created_at"
    }
}

struct AgentManagement: Identifiable, Codable, Hashable {
    let id: String
    var version: String?
    var authStatus: String
    var authDetail: String?
    var installCmd: String?
    var updateCmd: String?

    enum CodingKeys: String, CodingKey {
        case id, version
        case authStatus = "auth_status"
        case authDetail = "auth_detail"
        case installCmd = "install_cmd"
        case updateCmd = "update_cmd"
    }
}

struct AgentUsageLimit: Identifiable, Codable, Hashable {
    var id: String { agent }
    let agent: String
    let limitSpendUSD: Double?
    let usedSpendUSD: Double
    let limitTokens: Int64?
    let usedTokens: Int64
    let status: String
    let periodStart: String

    enum CodingKeys: String, CodingKey {
        case agent
        case limitSpendUSD = "limit_spend_usd"
        case usedSpendUSD = "used_spend_usd"
        case limitTokens = "limit_tokens"
        case usedTokens = "used_tokens"
        case status
        case periodStart = "period_start"
    }
}

struct TaskLimitWait: Codable, Hashable {
    let taskId: String
    let eventEpoch: Int64
    let userSeq: Int
    let agent: String?
    let provider: String?
    let window: String?
    let resetAt: Int64?
    let state: String
    let attempts: Int
    let nextProbeAt: Int64
    let firstWaitAt: Int64
    let lastProbeAt: Int64?
    let lastError: String?
    let claimedAt: Int64?
    let updatedAt: Int64
}

struct ProviderEntry: Identifiable, Codable, Hashable {
    let id: String
    var name: String
    var kind: String
    var baseURL: String
    var apiKey: String?
    var model: String
    var stream: Bool?
    var active: Bool
    var supportsAgents: [String]?

    enum CodingKeys: String, CodingKey {
        case id, name, kind, model, stream, active
        case baseURL = "base_url"
        case apiKey = "api_key"
        case supportsAgents = "supports_agents"
    }
}

struct ProvidersResponse: Codable, Hashable {
    let activeId: String
    let providers: [ProviderEntry]

    enum CodingKeys: String, CodingKey {
        case activeId = "active_id"
        case providers
    }
}

struct SettingsSnapshot: Codable, Hashable {
    var agentDefault: String?
    var networkMode: String?
    var connectURL: String?
    var notifyBarkURL: String?
    var notifyNtfyTopic: String?
}

struct WorkspaceTreeResponse: Codable, Hashable {
    let workspaceId: String?
    let path: String
    let entries: [WorkspaceTreeEntry]

    enum CodingKeys: String, CodingKey {
        case workspaceId = "workspace_id"
        case path, entries
    }
}

struct WorkspaceTreeEntry: Identifiable, Codable, Hashable {
    var id: String { path }
    let name: String
    let path: String
    let type: String
    let size: Int64?

    enum CodingKeys: String, CodingKey {
        case name, path, type, size
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        path = try container.decodeIfPresent(String.self, forKey: .path) ?? name
        type = try container.decode(String.self, forKey: .type)
        size = try container.decodeIfPresent(Int64.self, forKey: .size)
    }
}
