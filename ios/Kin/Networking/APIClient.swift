import Foundation

/// HTTP client for the Kin desktop daemon API.
///
/// Uses URLSession under the hood. All requests are relative to the configured base URL.
/// Bearer auth is attached automatically to authenticated endpoints.
actor APIClient {
    private let session: URLSession
    private let baseURL: URL
    private let token: String
    private let relayKey: String?
    private let relayRoom: String?
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    init(baseURL: URL, token: String, relayKey: String? = nil, relayRoom: String? = nil, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.token = token
        self.relayKey = relayKey
        self.relayRoom = relayRoom
        self.session = session

        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        // ISO8601 with optional fractional seconds
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let dateString = try container.decode(String.self)
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = formatter.date(from: dateString) {
                return date
            }
            formatter.formatOptions = [.withInternetDateTime]
            if let date = formatter.date(from: dateString) {
                return date
            }
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Invalid ISO8601 date: \(dateString)"
            )
        }
        self.decoder = decoder

        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        encoder.dateEncodingStrategy = .iso8601
        self.encoder = encoder
    }

    // MARK: - Public API methods

    func health() async throws -> Bool {
        struct HealthResponse: Decodable {
            let ok: Bool
        }
        let response: HealthResponse = try await perform(.health, timeout: 10)
        return response.ok
    }

    func version() async throws -> String? {
        struct VersionResponse: Decodable {
            let version: String
        }
        let response: VersionResponse = try await perform(.version)
        return response.version
    }

    func agents() async throws -> [Agent] {
        try await perform(.agents)
    }

    func recentCwds() async throws -> [String] {
        try await perform(.recentCwds)
    }

    func tasks(limit: Int? = nil, offset: Int? = nil) async throws -> [KinTask] {
        try await perform(.tasks(limit: limit, offset: offset), timeout: 30)
    }

    func task(id: String) async throws -> KinTask {
        try await perform(.task(id: id), timeout: 60)
    }

    func createTask(
        prompt: String,
        agent: String,
        model: String?,
        cwd: String,
        permissionMode: String?,
        workspaceMode: String?
    ) async throws -> KinTask {
        let body = CreateTaskBody(
            prompt: prompt,
            agent: agent,
            model: model,
            cwd: cwd,
            permissionMode: permissionMode,
            workspaceMode: workspaceMode
        )
        return try await perform(.createTask, body: body, timeout: 60)
    }

    func taskEvents(id: String, sinceSeq: Int? = nil) async throws -> [TaskEvent] {
        try await perform(.taskEvents(id: id, sinceSeq: sinceSeq), timeout: 30)
    }

    func deleteTask(id: String) async throws {
        try await performEmpty(.deleteTask(id: id))
    }

    func cancelTask(id: String) async throws {
        try await performEmpty(.cancelTask(id: id))
    }

    func promptTask(id: String, message: String) async throws {
        let body = PromptBody(message: message)
        try await performEmpty(.promptTask(id: id), body: body)
    }

    func retryTask(id: String) async throws -> KinTask {
        try await perform(.retryTask(id: id), timeout: 60)
    }

    func continueTask(id: String, action: String = "wait") async throws -> KinTask {
        try await perform(
            .limitContinue(id: id),
            body: LimitContinueBody(action: action),
            timeout: 60
        )
    }

    func forkTask(id: String, prompt: String?) async throws -> KinTask {
        try await perform(
            .forkTask(id: id),
            body: ForkBody(prompt: prompt),
            timeout: 60
        )
    }

    func approvals() async throws -> [Approval] {
        try await perform(.approvals, timeout: 30)
    }

    func approve(id: String) async throws {
        let body = DecisionBody(decision: "approved")
        try await performEmpty(.approve(id: id), body: body)
    }

    func deny(id: String) async throws {
        let body = DecisionBody(decision: "denied")
        try await performEmpty(.deny(id: id), body: body)
    }

    func userQuestions() async throws -> [UserQuestion] {
        try await perform(.userQuestions, timeout: 30)
    }

    func answerQuestion(id: String, selected: [String]?, otherText: String?) async throws {
        let body = AnswerBody(selected: selected, otherText: otherText)
        try await performEmpty(.answerQuestion(id: id), body: body)
    }

    func workspaces(taskId: String) async throws -> [Workspace] {
        try await perform(.workspaces(taskId: taskId))
    }

    func workspaceDiff(taskId: String, workspaceId: String) async throws -> String {
        try await performString(.workspaceDiff(taskId: taskId, workspaceId: workspaceId))
    }

    func workspaceFile(taskId: String, workspaceId: String, path: String) async throws -> String {
        let response: WorkspaceFilePayload = try await perform(
            .workspaceFile(taskId: taskId, workspaceId: workspaceId, path: path)
        )
        return response.content
    }

    func workspaceTree(taskId: String, workspaceId: String, path: String? = nil) async throws -> WorkspaceTreeResponse {
        try await perform(.workspaceTree(taskId: taskId, workspaceId: workspaceId, path: path))
    }

    func writeWorkspaceFile(taskId: String, workspaceId: String, path: String, content: String) async throws {
        try await performEmpty(
            .writeWorkspaceFile(taskId: taskId, workspaceId: workspaceId, path: path),
            body: WorkspaceWriteBody(path: path, content: content)
        )
    }

    func artifacts(status: String? = "saved") async throws -> [Artifact] {
        try await perform(.artifacts(status: status))
    }

    func artifactContent(id: String) async throws -> String {
        try await performString(.artifactContent(id: id))
    }

    func setArtifactStatus(id: String, status: String) async throws -> Artifact {
        try await perform(.artifactStatus(id: id), body: ArtifactStatusBody(status: status))
    }

    func projects(status: String? = "active") async throws -> [Project] {
        try await perform(.projects(status: status))
    }

    func createProject(name: String, mode: String, roots: [String]) async throws -> Project {
        try await perform(
            .createProject,
            body: ProjectWriteBody(name: name, mode: mode, roots: roots)
        )
    }

    func project(id: String) async throws -> Project {
        try await perform(.project(id: id))
    }

    func onePager(projectId: String) async throws -> OnePager {
        try await perform(.onePager(projectId: projectId))
    }

    func saveOnePager(projectId: String, markdown: String, updatedAt: Int64? = nil) async throws -> OnePager {
        try await perform(
            .putOnePager(projectId: projectId),
            body: OnePagerBody(markdown: markdown, updatedAt: updatedAt)
        )
    }

    func projectPulse(projectId: String) async throws -> ProjectPulse {
        try await perform(.projectPulse(projectId: projectId))
    }

    func projectTasks(projectId: String) async throws -> [KinTask] {
        try await perform(.projectTasks(projectId: projectId))
    }

    func routines(projectId: String? = nil, enabled: Bool? = nil, includeRuns: Bool = false) async throws -> [Routine] {
        let response: RoutineListResponse = try await perform(
            .routines(projectId: projectId, enabled: enabled, includeRuns: includeRuns)
        )
        return response.routines
    }

    func createRoutine(body: RoutineWriteBody) async throws -> Routine {
        try await perform(.createRoutine, body: body)
    }

    func updateRoutine(id: String, body: RoutinePatchBody) async throws -> Routine {
        try await perform(.patchRoutine(id: id), body: body)
    }

    func deleteRoutine(id: String) async throws {
        try await performEmpty(.deleteRoutine(id: id))
    }

    func runRoutineNow(id: String) async throws -> KinTask {
        try await perform(.routineRunNow(id: id))
    }

    func markRoutineRunRead(taskId: String) async throws {
        try await performEmpty(.routineRunRead(taskId: taskId))
    }

    func agentManagement(refresh: Bool = false) async throws -> [AgentManagement] {
        try await perform(.agentsManagement(refresh: refresh))
    }

    func usageLimits() async throws -> [AgentUsageLimit] {
        try await perform(.usageLimits)
    }

    func providers() async throws -> ProvidersResponse {
        try await perform(.providers)
    }

    func updateProvider(id: String, body: ProviderWriteBody) async throws -> ProvidersResponse {
        try await perform(.provider(id: id), body: body)
    }

    func activateProvider(id: String) async throws -> ProvidersResponse {
        try await perform(.providerActivate(id: id))
    }

    /// Build a WebSocket URL for the daemon.
    /// Converts http → ws and https → wss.
    nonisolated func webSocketURL() throws -> URL {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw APIError.invalidResponse
        }
        switch components.scheme?.lowercased() {
        case "http":
            components.scheme = "ws"
        case "https":
            components.scheme = "wss"
        default:
            throw APIError.invalidResponse
        }
        components.path = Endpoint.webSocket(token: token).path
        components.queryItems = [URLQueryItem(name: "token", value: token)] +
            (relayRoom.map { [URLQueryItem(name: "room", value: $0)] } ?? []) +
            (relayKey.map { [URLQueryItem(name: "key", value: $0)] } ?? [])
        guard let url = components.url else {
            throw APIError.invalidResponse
        }
        return url
    }

    // MARK: - Internal request building

    /// Build a URLRequest from an endpoint, with auth, method, and optional body.
    private func request(
        for endpoint: Endpoint,
        body: Data? = nil,
        timeout: TimeInterval = 30
    ) throws -> URLRequest {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw APIError.invalidResponse
        }
        components.path = endpoint.path
        if let queryItems = endpoint.queryItems {
            components.queryItems = queryItems
        }
        if let relayRoom {
            components.queryItems = (components.queryItems ?? []) + [URLQueryItem(name: "room", value: relayRoom)]
        }
        if let relayKey {
            components.queryItems = (components.queryItems ?? []) + [URLQueryItem(name: "key", value: relayKey)]
        }
        guard let url = components.url else {
            throw APIError.invalidResponse
        }

        var request = URLRequest(url: url)
        request.httpMethod = endpoint.method
        request.timeoutInterval = timeout
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        if endpoint.needsAuth {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        request.setValue("ios", forHTTPHeaderField: "X-Client-Type")

        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        return request
    }

    /// Perform a request and decode the response body.
    private func perform<T: Decodable>(
        _ endpoint: Endpoint,
        body: Encodable? = nil,
        timeout: TimeInterval = 30
    ) async throws -> T {
        let encodedBody: Data?
        if let body {
            encodedBody = try encoder.encode(AnyEncodable(body))
        } else {
            encodedBody = nil
        }
        let request = try self.request(for: endpoint, body: encodedBody, timeout: timeout)
        let data = try await execute(request)
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError.incompatible("Failed to decode response: \(error.localizedDescription)")
        }
    }

    /// Perform a request that returns no body (2xx with empty or ignored response).
    private func performEmpty(
        _ endpoint: Endpoint,
        body: Encodable? = nil,
        timeout: TimeInterval = 30
    ) async throws {
        let encodedBody: Data?
        if let body {
            encodedBody = try encoder.encode(AnyEncodable(body))
        } else {
            encodedBody = nil
        }
        let request = try self.request(for: endpoint, body: encodedBody, timeout: timeout)
        _ = try await execute(request)
    }

    /// Perform a request and return the raw response body as a UTF-8 string.
    private func performString(
        _ endpoint: Endpoint,
        timeout: TimeInterval = 30
    ) async throws -> String {
        let request = try self.request(for: endpoint, timeout: timeout)
        let data = try await execute(request)
        guard let text = String(data: data, encoding: .utf8) else {
            throw APIError.incompatible("Response is not valid UTF-8 text")
        }
        return text
    }

    /// Execute a URLRequest and return the raw response data.
    /// Maps transport errors and HTTP status codes to APIError.
    private func execute(_ request: URLRequest) async throws -> Data {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError.offline
        }

        guard let http = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }

        let statusCode = http.statusCode
        guard (200..<300).contains(statusCode) else {
            let message = decodeErrorMessage(data) ?? HTTPURLResponse.localizedString(forStatusCode: statusCode)
            switch statusCode {
            case 401:
                throw APIError.unauthorized
            case 404:
                throw APIError.notFound
            case 409:
                throw APIError.conflict
            case 400..<500:
                throw APIError.clientError(statusCode)
            case 500..<600:
                throw APIError.serverError(statusCode)
            default:
                throw APIError.unknown(message)
            }
        }

        return data
    }

    /// Decode an error message from an error response body.
    private func decodeErrorMessage(_ data: Data) -> String? {
        struct ErrorEnvelope: Decodable {
            let error: String
        }
        return try? decoder.decode(ErrorEnvelope.self, from: data).error
    }
}

// MARK: - Request body types

private struct CreateTaskBody: Encodable {
    let prompt: String
    let agent: String
    let model: String?
    let cwd: String
    let permissionMode: String?
    let workspaceMode: String?
}

private struct PromptBody: Encodable {
    let message: String
}

private struct ForkBody: Encodable {
    let prompt: String?
}

private struct LimitContinueBody: Encodable {
    let action: String
}

private struct DecisionBody: Encodable {
    let decision: String
}

private struct AnswerBody: Encodable {
    let selected: [String]?
    let otherText: String?
}

private struct WorkspaceFilePayload: Decodable {
    let content: String
}

struct WorkspaceWriteBody: Encodable {
    let path: String
    let content: String
}

private struct ArtifactStatusBody: Encodable {
    let status: String
}

private struct OnePagerBody: Encodable {
    let markdown: String
    let updatedAt: Int64?
}

private struct RoutineListResponse: Decodable {
    let routines: [Routine]

    init(from decoder: Decoder) throws {
        if let values = try? decoder.singleValueContainer().decode([Routine].self) {
            routines = values
            return
        }
        let container = try decoder.container(keyedBy: CodingKeys.self)
        routines = try container.decode([Routine].self, forKey: .routines)
    }

    private enum CodingKeys: String, CodingKey {
        case routines
    }
}

struct RoutineWriteBody: Encodable {
    let title: String
    let projectId: String?
    let cwd: String
    let agent: String
    let permissionMode: String
    let prompt: String
    let intervalSecs: Int
    let enabled: Bool
}

struct RoutinePatchBody: Encodable {
    let title: String?
    let projectId: String?
    let cwd: String?
    let agent: String?
    let permissionMode: String?
    let prompt: String?
    let intervalSecs: Int?
    let enabled: Bool?
}

struct ProviderWriteBody: Encodable {
    let name: String
    let kind: String
    let baseURL: String
    let apiKey: String?
    let model: String
    let stream: Bool?
    let active: Bool?
    let clearApiKey: Bool?
}

private struct ProjectWriteBody: Encodable {
    let name: String
    let mode: String
    let roots: [String]
}

/// Type-erased encodable wrapper to allow encoding different body types uniformly.
private struct AnyEncodable: Encodable {
    private let _encode: (Encoder) throws -> Void

    init(_ wrapped: Encodable) {
        _encode = { encoder in
            try wrapped.encode(to: encoder)
        }
    }

    func encode(to encoder: Encoder) throws {
        try _encode(encoder)
    }
}
