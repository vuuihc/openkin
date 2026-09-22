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

enum ProjectPresentation {
    struct Summary: Equatable {
        let title: String?
        let modeLabel: String
        let statusLabel: String
        let progress: String?
        let root: String?
        let lastActiveDate: Date
        let sessionWindow: Int
        let runningCount: Int
        let waitingCount: Int
        let commitWindow: Int
        let hasLiveWork: Bool
    }

    struct OnePagerFocus: Equatable {
        let northStar: String?
        let focus: String?
        let next: [String]
        let displayMarkdown: String?
        let isEmpty: Bool
    }

    static func summary(for project: Project) -> Summary {
        summary(for: project, pulse: nil as ProjectPulse?)
    }

    static func summary(for project: Project, pulse: ProjectPulse?) -> Summary {
        Summary(
            title: clean(project.name),
            modeLabel: displayLabel(project.mode),
            statusLabel: displayLabel(project.status),
            progress: clean(project.softProgress),
            root: clean(project.roots?.first),
            lastActiveDate: millisecondsDate(project.lastActiveAt),
            sessionWindow: pulse?.sessionWindow ?? 0,
            runningCount: pulse?.sessionsRunning ?? 0,
            waitingCount: pulse?.sessionsWaiting ?? 0,
            commitWindow: pulse?.commitWindow ?? 0,
            hasLiveWork: (pulse?.sessionsRunning ?? 0) > 0 || (pulse?.sessionsWaiting ?? 0) > 0
        )
    }

    static func onePagerFocus(for onePager: OnePager?) -> OnePagerFocus {
        let northStar = clean(onePager?.onePagerSummary?.northStar)
        let focus = clean(onePager?.onePagerSummary?.focus)
        let next = onePager?.onePagerSummary?.next?.compactMap(clean) ?? []
        let summaryMarkedEmpty = onePager?.onePagerSummary?.empty == true
        let markdown = clean(onePager?.markdown)
        let displayMarkdown = summaryMarkedEmpty || isDefaultTemplateMarkdown(markdown) ? nil : markdown
        let markdownIsEmpty = displayMarkdown == nil

        return OnePagerFocus(
            northStar: northStar,
            focus: focus,
            next: next,
            displayMarkdown: displayMarkdown,
            isEmpty: summaryMarkedEmpty || (markdownIsEmpty && northStar == nil && focus == nil && next.isEmpty)
        )
    }

    static func displayLabel(_ rawValue: String) -> String {
        let normalized = rawValue
            .replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return "Unknown" }
        return normalized
            .split(separator: " ")
            .map { word in word.prefix(1).uppercased() + word.dropFirst().lowercased() }
            .joined(separator: " ")
    }

    private static func clean(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func millisecondsDate(_ milliseconds: Int64) -> Date {
        Date(timeIntervalSince1970: Double(milliseconds) / 1000)
    }

    private static func isDefaultTemplateMarkdown(_ markdown: String?) -> Bool {
        guard let markdown else { return false }
        let lower = markdown.lowercased()
        return lower.contains("## north star")
            && lower.contains("## current focus")
            && lower.contains("<!-- kin:auto:start -->")
            && (
                lower.contains("你为什么做这个项目")
                    || lower.contains("当下唯一主线")
                    || lower.contains("why you are building")
                    || lower.contains("single main thread")
            )
    }
}

enum ArtifactPresentation {
    struct Summary: Equatable {
        let title: String?
        let kindLabel: String
        let statusLabel: String
        let sizeText: String
        let sourceTitle: String?
        let updatedDate: Date
        let isArchived: Bool
    }

    static func summary(for artifact: Artifact) -> Summary {
        Summary(
            title: clean(artifact.title),
            kindLabel: ProjectPresentation.displayLabel(artifact.kind),
            statusLabel: ProjectPresentation.displayLabel(artifact.status),
            sizeText: ByteCountFormatter.string(fromByteCount: artifact.size, countStyle: .file),
            sourceTitle: clean(artifact.sourceTaskTitle),
            updatedDate: Date(timeIntervalSince1970: Double(artifact.updatedAt) / 1000),
            isArchived: artifact.status == "archived"
        )
    }

    private static func clean(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
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

struct WorkerCapability: Codable, Hashable {
    let name: String
    let version: String?
    let features: [String]?
}

struct WorkerLease: Codable, Hashable {
    let leaseId: String
    let workerId: String
    let issuedAt: Int64
    let expiresAt: Int64
}

struct WorkerRecord: Identifiable, Codable, Hashable {
    var id: String { workerId }
    let version: Int
    let workerId: String
    let label: String?
    let ownerDeviceId: String?
    let capabilities: [WorkerCapability]
    let maxConcurrent: Int
    let lease: WorkerLease
    let state: String
    let lastSeenAt: Int64
    let revokedAt: Int64?
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
