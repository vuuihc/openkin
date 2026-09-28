import Foundation

enum TaskStatus: String, Codable, CaseIterable, Hashable {
    case queued
    case running
    case waitingApproval = "waiting_approval"
    case waitingInput = "waiting_input"
    case succeeded
    case completed
    case failed
    case cancelled
    case paused
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = TaskStatus(rawValue: raw) ?? .unknown
    }
}

/// Daemon task model. Timestamps are Unix milliseconds, matching the Go API.
struct KinTask: Identifiable, Codable, Hashable {
    let id: String
    let status: TaskStatus
    let agent: String
    let model: String?
    let cwd: String
    /// The project this session was filed under when it was created. The daemon
    /// assigns it by matching the session's cwd against a project's roots, so it
    /// can be absent on older rows — grouping falls back to that same cwd match.
    let projectId: String?
    let prompt: String
    /// The daemon's own name for the session — a short generated summary, or the
    /// opening prompt's first line when generation failed. The web console shows
    /// this name wherever it names a session, so the phone shows it too. Absent
    /// on rows written before the daemon started naming sessions.
    let title: String?
    let permissionMode: String?
    let workspaceMode: String?
    let approvalIds: [String]?
    let questionIds: [String]?
    let createdAt: Int64
    let startedAt: Int64?
    let finishedAt: Int64?
    let elapsedSeconds: Double?
    let costUSD: Double?
    let sessionRef: String?
    let error: String?

    enum CodingKeys: String, CodingKey {
        case id, status, agent, model, cwd, prompt, title, error
        case projectId = "project_id"
        case permissionMode = "permission_mode"
        case workspaceMode = "workspace_mode"
        case approvalIds = "approval_ids"
        case questionIds = "question_ids"
        case createdAt = "created_at"
        case startedAt = "started_at"
        case finishedAt = "finished_at"
        case elapsedSeconds = "elapsed_seconds"
        case costUSD = "cost_usd"
        case sessionRef = "session_ref"
    }

    var createdDate: Date { Date(timeIntervalSince1970: Double(createdAt) / 1000) }
    var isTerminal: Bool {
        switch status {
        case .succeeded, .completed, .failed, .cancelled: return true
        default: return false
        }
    }
}

/// One project's slice of the conversation list. A group is either a real
/// project, a folder no project claims, or the leftovers with no folder.
struct ChatGroup: Identifiable, Equatable {
    enum Kind: Equatable {
        case project(id: String)
        case folder(path: String)
        case unfiled
    }

    let kind: Kind
    /// The project's name, or the folder's last path segment. Empty for the
    /// unfiled group, whose label is localized by the view.
    let title: String
    /// Most recent session first.
    let sessions: [KinTask]

    var id: String {
        switch kind {
        case .project(let id): return "project:\(id)"
        case .folder(let path): return "cwd:\(path)"
        case .unfiled: return "unfiled"
        }
    }

    /// Only the unfiled group, whose label is localized by the view rather than
    /// carried as data.
    var isUnfiled: Bool { kind == .unfiled }

    var runningCount: Int {
        sessions.filter { !$0.isTerminal }.count
    }
}

/// Display-oriented task projection shared by task list and detail surfaces.
enum TaskPresentation {
    struct Summary: Equatable {
        let title: String
        let location: String
        let agentAndModel: String
        let elapsed: String
        let cost: String
        let needsUserAction: Bool
    }

    static func summary(for task: KinTask) -> Summary {
        Summary(
            title: title(for: task),
            location: task.cwd,
            agentAndModel: agentAndModel(for: task),
            elapsed: formatElapsed(task.elapsedSeconds),
            cost: formatCostUSD(task.costUSD),
            needsUserAction: task.status == .waitingApproval || task.status == .waitingInput
        )
    }

    /// The conversation's name. The daemon names every session, and the web
    /// console uses that name wherever it shows one; deriving a second name from
    /// the prompt here would name the same conversation differently on the phone
    /// and in the console. Rows that predate daemon-side naming fall back to the
    /// prompt's first line.
    static func title(for task: KinTask) -> String {
        let daemon = task.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !daemon.isEmpty { return daemon }
        return firstLine(of: displayUserPrompt(task.prompt))
    }

    /// The line that opened a prompt. A list row, navigation title, or chat name
    /// reads better as one line than as a paragraph; callers that need the whole
    /// thing show `task.prompt` through `displayUserPrompt`.
    static func firstLine(of text: String) -> String {
        for line in text.split(whereSeparator: \.isNewline) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if !trimmed.isEmpty { return trimmed }
        }
        return ""
    }

    static func filter(_ tasks: [KinTask], query: String) -> [KinTask] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return tasks }

        let needle = trimmed.lowercased()
        return tasks.filter { task in
            let summary = summary(for: task)
            // Both the whole prompt and the daemon's name are searched: the line a
            // query matched may not be the one the row shows, and the name the row
            // does show is generated, so it need not appear in the prompt at all.
            return task.prompt.lowercased().contains(needle)
                || (task.title?.lowercased().contains(needle) ?? false)
                || summary.location.lowercased().contains(needle)
                || summary.agentAndModel.lowercased().contains(needle)
                || task.status.rawValue.lowercased().contains(needle)
        }
    }

    static func isCurrentProfileContext(boundProfileID: UUID?, activeProfileID: UUID?) -> Bool {
        guard let boundProfileID, let activeProfileID else { return true }
        return boundProfileID == activeProfileID
    }

    // MARK: - Grouping

    /// Bucket sessions under the project they belong to, mirroring the daemon's
    /// own rule (`ListTasksForProject`): a session carrying a `project_id` belongs
    /// to that project, and one without it belongs to the project whose root is
    /// its folder. Sessions no project claims stay together by folder, and
    /// sessions with no folder collect in a final unfiled group. Groups and the
    /// sessions inside them are ordered by how recently they did something.
    static func chatGroups(tasks: [KinTask], projects: [Project]) -> [ChatGroup] {
        var unclaimed = tasks
        var groups: [ChatGroup] = []

        for project in projects {
            let roots = Set((project.roots ?? []).map(normalizedPath))
            let claimed = unclaimed.filter { task in
                if task.projectId == project.id { return true }
                // A session filed under some *other* project must not be re-filed
                // here just because its folder happens to sit under this root.
                guard task.projectId == nil else { return false }
                return !task.cwd.isEmpty && roots.contains(normalizedPath(task.cwd))
            }
            guard !claimed.isEmpty else { continue }
            let claimedIDs = Set(claimed.map(\.id))
            unclaimed.removeAll { claimedIDs.contains($0.id) }
            groups.append(
                ChatGroup(kind: .project(id: project.id), title: project.name, sessions: byRecency(claimed))
            )
        }

        var byFolder: [String: [KinTask]] = [:]
        var unfiled: [KinTask] = []
        for task in unclaimed {
            if task.cwd.isEmpty {
                unfiled.append(task)
            } else {
                byFolder[normalizedPath(task.cwd), default: []].append(task)
            }
        }
        for (path, sessions) in byFolder {
            groups.append(
                ChatGroup(kind: .folder(path: path), title: lastPathSegment(path), sessions: byRecency(sessions))
            )
        }
        if !unfiled.isEmpty {
            groups.append(ChatGroup(kind: .unfiled, title: "", sessions: byRecency(unfiled)))
        }

        return groups.sorted { first, second in
            let lhs = first.sessions.first.map(lastActivity) ?? 0
            let rhs = second.sessions.first.map(lastActivity) ?? 0
            if lhs != rhs { return lhs > rhs }
            return first.id < second.id
        }
    }

    /// A folder path with any trailing separators removed, so a project root and
    /// a session's folder compare equal however either was spelled.
    static func normalizedPath(_ path: String) -> String {
        var trimmed = path
        while trimmed.count > 1 && trimmed.hasSuffix("/") {
            trimmed.removeLast()
        }
        return trimmed
    }

    static func lastPathSegment(_ path: String) -> String {
        let normalized = normalizedPath(path)
        guard let segment = normalized.split(separator: "/").last, !segment.isEmpty else {
            return normalized
        }
        return String(segment)
    }

    /// When a session last did anything. `finishedAt` alone is not it: a session
    /// that was followed up after finishing is running again with a newer
    /// `startedAt`.
    private static func lastActivity(_ task: KinTask) -> Int64 {
        max(task.finishedAt ?? 0, max(task.startedAt ?? 0, task.createdAt))
    }

    private static func byRecency(_ tasks: [KinTask]) -> [KinTask] {
        tasks.sorted { lastActivity($0) > lastActivity($1) }
    }

    static func agentAndModel(for task: KinTask) -> String {
        let model = task.model?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let model, !model.isEmpty else { return task.agent }
        return "\(task.agent) / \(model)"
    }

    static func formatElapsed(_ seconds: Double?) -> String {
        guard let seconds, seconds >= 0 else { return "—" }

        if seconds < 60 {
            return "\(Int(seconds))s"
        }

        let minutes = Int(seconds) / 60
        let secs = Int(seconds) % 60
        if minutes < 60 {
            return "\(minutes)m \(secs)s"
        }
        let hours = minutes / 60
        let mins = minutes % 60
        return "\(hours)h \(mins)m"
    }

    static func formatCostUSD(_ dollars: Double?) -> String {
        guard let dollars else { return "—" }
        if dollars < 0.01 {
            return "< $0.01"
        }
        return String(format: "$%.2f", dollars)
    }

    // MARK: - Attachment prompts

    /// The composer appends a block like
    ///
    ///     Attached image:
    ///     - shot.png: /Users/me/.kin/uploads/abc.png
    ///
    /// to a prompt so the agent — and the vision embedder — can read the files.
    /// The absolute path is for the agent, not for the reader: it is stripped
    /// before a prompt is shown or used to name a session, exactly as the web
    /// console strips it.
    private static let attachedBlock = try? NSRegularExpression(
        pattern: "(?:^|\\n)Attached (?:image|file|files):\\n((?:[ \\t]*-[ \\t].+\\n?)*)",
        options: [.caseInsensitive]
    )
    private static let attachedListItem = try? NSRegularExpression(
        pattern: "^[ \\t]*-[ \\t]+(.+?):\\s+\\S+\\s*$"
    )
    private static let attachedNoun = try? NSRegularExpression(
        // Longest first: the console's own alternation lists `file` before
        // `files`, so an "Attached files:" header comes back as the singular.
        pattern: "Attached (files|file|image)",
        options: [.caseInsensitive]
    )

    /// A prompt with every attachment block — paths included — removed, not just
    /// the first one the way the console's non-global `replace` does it.
    static func stripAttachmentBlock(_ text: String) -> String {
        guard !text.isEmpty, let attachedBlock else { return text }
        let stripped = attachedBlock.stringByReplacingMatches(
            in: text, range: NSRange(text.startIndex..., in: text), withTemplate: ""
        )
        return trimEnd(collapseBlankLines(stripped))
    }

    /// A prompt safe to show: the attachment paths are replaced by the names of
    /// the files they point at, so the reader still learns what was attached.
    static func displayUserPrompt(_ text: String) -> String {
        guard !text.isEmpty, let attachedBlock else { return text }
        let full = NSRange(text.startIndex..., in: text)
        guard let match = attachedBlock.firstMatch(in: text, range: full) else { return text }

        let names = attachmentNames(in: text, match: match)
        let noun = attachmentNoun(in: text, match: match)
        let summary: String
        switch names.count {
        case 0: summary = "Attached \(noun)"
        case 1: summary = "Attached \(noun): \(names[0])"
        default: summary = "Attached \(noun): \(names.joined(separator: ", "))"
        }

        let rest = trimEnd(stripAttachmentBlock(text))
        return rest.isEmpty ? summary : "\(rest)\n\n\(summary)"
    }

    private static func attachmentNames(in text: String, match: NSTextCheckingResult) -> [String] {
        guard let attachedListItem, match.numberOfRanges > 1,
              let groupRange = Range(match.range(at: 1), in: text)
        else { return [] }

        var names: [String] = []
        for line in text[groupRange].split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(line)
            let full = NSRange(line.startIndex..., in: line)
            guard let item = attachedListItem.firstMatch(in: line, range: full),
                  let nameRange = Range(item.range(at: 1), in: line)
            else { continue }
            names.append(line[nameRange].trimmingCharacters(in: .whitespaces))
        }
        return names
    }

    private static func attachmentNoun(in text: String, match: NSTextCheckingResult) -> String {
        guard let attachedNoun, let blockRange = Range(match.range(at: 0), in: text) else {
            return "file"
        }
        let block = String(text[blockRange])
        let full = NSRange(block.startIndex..., in: block)
        guard let noun = attachedNoun.firstMatch(in: block, range: full),
              let nounRange = Range(noun.range(at: 1), in: block)
        else { return "file" }
        return block[nounRange].lowercased()
    }

    private static func collapseBlankLines(_ text: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: "\\n{3,}") else { return text }
        return regex.stringByReplacingMatches(
            in: text, range: NSRange(text.startIndex..., in: text), withTemplate: "\n\n"
        )
    }

    private static func trimEnd(_ text: String) -> String {
        var trimmed = Substring(text)
        while let last = trimmed.last, last.isWhitespace {
            trimmed = trimmed.dropLast()
        }
        return String(trimmed)
    }
}
