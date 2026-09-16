import Foundation

/// A file that was changed within a workspace generation.
struct ChangedFile: Codable, Hashable, Identifiable {
    let path: String
    let additions: Int
    let deletions: Int
    let isBinary: Bool?

    var id: String { path }

    enum CodingKeys: String, CodingKey {
        case path, additions, deletions
        case isBinary = "is_binary"
    }
}

/// A workspace managed by the Kin daemon, representing a snapshot of the
/// filesystem state at a given generation.
struct Workspace: Identifiable, Codable, Hashable {
    let id: String
    let taskId: String
    let generation: Int
    let isCurrent: Bool?
    let changedFiles: [ChangedFile]?
    let createdAt: Int64

    enum CodingKeys: String, CodingKey {
        case id
        case taskId = "task_id"
        case generation
        case isCurrent = "is_current"
        case changedFiles = "changed_files"
        case createdAt = "created_at"
    }
}
