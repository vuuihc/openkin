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
    case taskLimitWait(id: String)
    case taskUsage(id: String)
    case cancelTask(id: String)
    case deleteTask(id: String)
    case promptTask(id: String)
    case retryTask(id: String)
    case limitContinue(id: String)
    case forkTask(id: String)
    case approvals
    case approve(id: String)
    case deny(id: String)
    case userQuestions
    case answerQuestion(id: String)
    case workspaces(taskId: String)
    case workspaceDiff(taskId: String, workspaceId: String)
    case workspaceFile(taskId: String, workspaceId: String, path: String)
    case workspaceTree(taskId: String, workspaceId: String, path: String?)
    case writeWorkspaceFile(taskId: String, workspaceId: String, path: String)
    case artifacts(status: String?)
    case artifact(id: String)
    case artifactContent(id: String)
    case artifactStatus(id: String)
    case projects(status: String?)
    case createProject
    case project(id: String)
    case onePager(projectId: String)
    case putOnePager(projectId: String)
    case projectPulse(projectId: String)
    case projectTasks(projectId: String)
    case projectArtifacts(projectId: String)
    case routines(projectId: String?, enabled: Bool?, includeRuns: Bool)
    case createRoutine
    case routine(id: String)
    case patchRoutine(id: String)
    case deleteRoutine(id: String)
    case routineUnreadCount
    case routineRunNow(id: String)
    case routineRunRead(taskId: String)
    case agentsManagement(refresh: Bool)
    case usageLimits
    case usageWindows
    case settings
    case workers
    case registerWorker
    case heartbeatWorker
    case revokeWorker(id: String)
    case providers
    case provider(id: String)
    case providerActivate(id: String)
    case webSocket(token: String)

    var method: String {
        switch self {
        case .health, .version, .agents, .recentCwds, .tasks, .task,
             .taskEvents, .taskUsage, .approvals, .userQuestions, .workspaces,
             .taskLimitWait,
             .workspaceDiff, .workspaceFile, .workspaceTree, .artifacts,
             .artifact, .artifactContent, .projects, .project, .onePager,
             .projectPulse, .projectTasks, .projectArtifacts, .routines,
             .routine, .routineUnreadCount, .agentsManagement, .usageLimits,
             .usageWindows, .settings, .providers, .workers:
            return "GET"
        case .createTask, .createProject, .cancelTask, .promptTask, .retryTask,
             .limitContinue, .forkTask, .approve, .deny, .answerQuestion,
             .artifactStatus, .routineRunNow, .routineRunRead,
             .providerActivate, .createRoutine:
            return "POST"
        case .registerWorker, .heartbeatWorker, .revokeWorker:
            return "POST"
        case .writeWorkspaceFile, .putOnePager:
            return "PUT"
        case .patchRoutine:
            return "PATCH"
        case .deleteRoutine:
            return "DELETE"
        case .deleteTask:
            return "DELETE"
        case .provider:
            return "PUT"
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
        case .taskLimitWait(let id):
            return "/api/tasks/\(id)/limit-wait"
        case .taskUsage(let id):
            return "/api/tasks/\(id)/usage"
        case .cancelTask(let id):
            return "/api/tasks/\(id)/cancel"
        case .deleteTask(let id):
            return "/api/tasks/\(id)"
        case .promptTask(let id):
            return "/api/tasks/\(id)/prompt"
        case .retryTask(let id):
            return "/api/tasks/\(id)/retry"
        case .limitContinue(let id):
            return "/api/tasks/\(id)/limit/continue"
        case .forkTask(let id):
            return "/api/tasks/\(id)/fork"
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
        case .workspaceFile(let taskId, let workspaceId, _):
            return "/api/tasks/\(taskId)/workspaces/\(workspaceId)/file"
        case .workspaceTree(let taskId, let workspaceId, _):
            return "/api/tasks/\(taskId)/workspaces/\(workspaceId)/tree"
        case .writeWorkspaceFile(let taskId, let workspaceId, _):
            return "/api/tasks/\(taskId)/workspaces/\(workspaceId)/file"
        case .artifacts:
            return "/api/artifacts"
        case .artifact(let id), .artifactContent(let id), .artifactStatus(let id):
            return "/api/artifacts/\(id)" + {
                switch self {
                case .artifactContent: return "/content"
                case .artifactStatus: return "/status"
                default: return ""
                }
            }()
        case .projects, .createProject:
            return "/api/projects"
        case .project(let id):
            return "/api/projects/\(id)"
        case .onePager(let projectId):
            return "/api/projects/\(projectId)/one-pager"
        case .putOnePager(let projectId):
            return "/api/projects/\(projectId)/one-pager"
        case .projectPulse(let projectId):
            return "/api/projects/\(projectId)/pulse"
        case .projectTasks(let projectId):
            return "/api/projects/\(projectId)/tasks"
        case .projectArtifacts(let projectId):
            return "/api/projects/\(projectId)/artifacts"
        case .routines:
            return "/api/routines"
        case .createRoutine:
            return "/api/routines"
        case .routine(let id):
            return "/api/routines/\(id)"
        case .patchRoutine(let id), .deleteRoutine(let id):
            return "/api/routines/\(id)"
        case .routineUnreadCount:
            return "/api/routines/unread-count"
        case .routineRunNow(let id):
            return "/api/routines/\(id)/run-now"
        case .routineRunRead(let taskId):
            return "/api/routines/runs/\(taskId)/read"
        case .agentsManagement:
            return "/api/agents/management"
        case .usageLimits:
            return "/api/usage/limits"
        case .usageWindows:
            return "/api/usage/windows"
        case .settings:
            return "/api/settings"
        case .workers:
            return "/api/workers"
        case .registerWorker:
            return "/api/workers/register"
        case .heartbeatWorker:
            return "/api/workers/heartbeat"
        case .revokeWorker(let id):
            return "/api/workers/\(id)/revoke"
        case .providers, .provider:
            return "/api/providers" + {
                if case .provider(let id) = self { return "/\(id)" }
                return ""
            }()
        case .providerActivate(let id):
            return "/api/providers/\(id)/activate"
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
        case .workspaceFile(_, _, let path):
            return [URLQueryItem(name: "path", value: path)]
        case .workspaceTree(_, _, let path):
            return path.map { [URLQueryItem(name: "path", value: $0)] }
        case .artifacts(let status):
            return status.map { [URLQueryItem(name: "status", value: $0)] }
        case .projects(let status):
            return status.map { [URLQueryItem(name: "status", value: $0)] }
        case .projectPulse:
            return [URLQueryItem(name: "window_days", value: "90")]
        case .projectTasks:
            return [URLQueryItem(name: "limit", value: "50")]
        case .projectArtifacts:
            return [URLQueryItem(name: "limit", value: "30")]
        case .routines(let projectId, let enabled, let includeRuns):
            var items: [URLQueryItem] = []
            if let projectId { items.append(URLQueryItem(name: "project_id", value: projectId)) }
            if let enabled { items.append(URLQueryItem(name: "enabled", value: enabled ? "true" : "false")) }
            if includeRuns { items.append(URLQueryItem(name: "runs", value: "1")) }
            return items.isEmpty ? nil : items
        case .createRoutine:
            return nil
        case .agentsManagement(let refresh):
            return refresh ? [URLQueryItem(name: "refresh", value: "1")] : nil
        case .webSocket(let token):
            return [URLQueryItem(name: "token", value: token)]
        default:
            return nil
        }
    }
}
