import Foundation

/// Type-safe API endpoint definitions.
enum Endpoint {
    case health
    case version
    case agents
    case recentCwds
    case tasks(limit: Int?, offset: Int?)
    case createTask
    case task(id: String)
    case taskEvents(id: String, sinceSeq: Int?)
    case cancelTask(id: String)
    case promptTask(id: String)
    case retryTask(id: String)
    case approvals
    case approve(id: String)
    case deny(id: String)
    case userQuestions
    case answerQuestion(id: String)
    case workspaces(taskId: String)
    case workspaceDiff(taskId: String, workspaceId: String)
    case workspaceFile(taskId: String, workspaceId: String, path: String)
    case webSocket(token: String)

    var method: String {
        switch self {
        case .health, .version, .agents, .recentCwds, .tasks, .task,
             .taskEvents, .approvals, .userQuestions, .workspaces,
             .workspaceDiff, .workspaceFile:
            return "GET"
        case .createTask, .cancelTask, .promptTask, .retryTask,
             .approve, .deny, .answerQuestion:
            return "POST"
        case .webSocket:
            return "GET"
        }
    }

    var path: String {
        switch self {
        case .health:
            return "/api/health"
        case .version:
            return "/api/version"
        case .agents:
            return "/api/agents"
        case .recentCwds:
            return "/api/recent-cwds"
        case .tasks, .createTask:
            return "/api/tasks"
        case .task(let id):
            return "/api/tasks/\(id)"
        case .taskEvents(let id, _):
            return "/api/tasks/\(id)/events"
        case .cancelTask(let id):
            return "/api/tasks/\(id)/cancel"
        case .promptTask(let id):
            return "/api/tasks/\(id)/prompt"
        case .retryTask(let id):
            return "/api/tasks/\(id)/retry"
        case .approvals:
            return "/api/approvals"
        case .approve(let id), .deny(let id):
            return "/api/approvals/\(id)/decision"
        case .userQuestions:
            return "/api/user-questions"
        case .answerQuestion(let id):
            return "/api/user-questions/\(id)/answer"
        case .workspaces(let taskId):
            return "/api/tasks/\(taskId)/workspaces"
        case .workspaceDiff(let taskId, let workspaceId):
            return "/api/tasks/\(taskId)/workspaces/\(workspaceId)/diff"
        case .workspaceFile(let taskId, let workspaceId, let path):
            let encoded = path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? path
            return "/api/tasks/\(taskId)/workspaces/\(workspaceId)/file/\(encoded)"
        case .webSocket:
            return "/api/ws"
        }
    }

    var needsAuth: Bool {
        switch self {
        case .health:
            return false
        default:
            return true
        }
    }

    var queryItems: [URLQueryItem]? {
        switch self {
        case .tasks(let limit, let offset):
            var items: [URLQueryItem] = []
            if let limit {
                items.append(URLQueryItem(name: "limit", value: String(limit)))
            }
            if let offset {
                items.append(URLQueryItem(name: "offset", value: String(offset)))
            }
            return items.isEmpty ? nil : items
        case .taskEvents(_, let sinceSeq):
            guard let sinceSeq else { return nil }
            return [URLQueryItem(name: "since_seq", value: String(sinceSeq))]
        case .webSocket(let token):
            return [URLQueryItem(name: "token", value: token)]
        default:
            return nil
        }
    }
}