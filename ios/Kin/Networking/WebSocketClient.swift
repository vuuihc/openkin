import Foundation

/// Manages a single WebSocket connection to the daemon.
/// Reconnects with exponential backoff (1s → 15s max).
/// Uses connection generation counter to discard stale callbacks.
actor WebSocketClient: NSObject {
    private let baseURL: URL
    private let token: String
    private let session: URLSession
    private var task: URLSessionWebSocketTask?
    private var generation: UInt64 = 0
    private var isReconnecting = false
    private var reconnectWork: Task<Void, Never>?
    private let decoder: JSONDecoder

    /// Called when a decoded server message is received, along with the generation
    /// at which it was received. Callers should compare against their stored generation
    /// to discard stale callbacks.
    var onMessage: (@Sendable (ServerMessage, UInt64) -> Void)?
    /// Called when connection state changes.
    var onStateChange: (@Sendable (WebSocketState) -> Void)?

    /// Set both callbacks in a single actor-isolated call to avoid data races.
    func setCallbacks(
        onMessage: @Sendable @escaping (ServerMessage, UInt64) -> Void,
        onStateChange: @Sendable @escaping (WebSocketState) -> Void
    ) {
        self.onMessage = onMessage
        self.onStateChange = onStateChange
    }

    enum WebSocketState: Equatable {
        case disconnected
        case connecting
        case connected
        case reconnecting(delay: TimeInterval)
    }

    init(baseURL: URL, token: String, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.token = token
        self.session = session
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        self.decoder = decoder
        super.init()
    }

    /// Returns the current generation for stale callback detection.
    var currentGeneration: UInt64 {
        generation
    }

    /// Connect to the daemon WebSocket endpoint.
    /// Cancels any pending reconnect and resets state.
    func connect() {
        cancelReconnect()
        task?.cancel(with: .goingAway, reason: nil)
        generation &+= 1
        isReconnecting = false
        startTask()
    }

    /// Disconnect and stop reconnecting.
    func disconnect() {
        cancelReconnect()
        generation &+= 1
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        isReconnecting = false
        reportState(.disconnected)
    }

    // MARK: - Private

    private func startTask() {
        guard let url = buildURL() else {
            scheduleReconnect()
            return
        }

        reportState(.connecting)
        let newTask = session.webSocketTask(with: url)
        task = newTask
        newTask.resume()
        receiveMessage()
    }

    private func buildURL() -> URL? {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            return nil
        }
        switch components.scheme?.lowercased() {
        case "http":
            components.scheme = "ws"
        case "https":
            components.scheme = "wss"
        default:
            return nil
        }
        components.path = "/api/ws"
        components.queryItems = [URLQueryItem(name: "token", value: token)]
        return components.url
    }

    /// Recursively listen for messages on the current task.
    private func receiveMessage() {
        let currentGen = generation
        Task { [weak self] in
            guard let self else { return }
            while true {
                guard let task = await self.task, task.state == .running else { return }
                let message: URLSessionWebSocketTask.Message
                do {
                    message = try await task.receive()
                } catch {
                    // Only initiate reconnect if we're still on the same generation
                    // and we are not already reconnecting.
                    let stillCurrentGeneration = await self.generation == currentGen
                    let notAlreadyReconnecting = !(await self.isReconnecting)
                    if stillCurrentGeneration && notAlreadyReconnecting {
                        await self.handleDisconnect()
                    }
                    return
                }

                let data: Data
                switch message {
                case let .data(d):
                    data = d
                case let .string(text):
                    data = Data(text.utf8)
                @unknown default:
                    continue
                }

                do {
                    let decoded = try await self.decoder.decode(ServerMessage.self, from: data)
                    let gen = await self.generation
                    await self.dispatchMessage(decoded, generation: gen)
                } catch {
                    // Ignore messages we can't decode
                    continue
                }
            }
        }
    }

    private func dispatchMessage(_ message: ServerMessage, generation: UInt64) {
        if generation == self.generation {
            reportState(.connected)
            onMessage?(message, generation)
        }
    }

    private func handleDisconnect() {
        guard !isReconnecting else { return }
        isReconnecting = true
        generation &+= 1
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        scheduleReconnect(delay: 1)
    }

    /// Schedule a reconnect with the given delay.
    /// Doubles the delay on each call, capped at 15 seconds.
    private func scheduleReconnect(delay: TimeInterval = 1) {
        cancelReconnect()

        let actualDelay = min(delay, 15)
        reportState(.reconnecting(delay: actualDelay))

        reconnectWork = Task { [weak self] in
            try? await Task.sleep(for: .seconds(actualDelay))
            guard !Task.isCancelled, let self else { return }
            await self.performReconnect(delay: actualDelay)
        }
    }

    private func performReconnect(delay: TimeInterval) {
        isReconnecting = false
        let nextDelay = delay < 15 ? delay * 2 : 15
        startTask()

        // If startTask fails to connect, schedule another reconnect
        // We check after a brief moment whether the task connected successfully.
        reconnectWork = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard let self else { return }
            let hasTask = await self.task != nil
            let taskState = await self.task?.state
            if !hasTask || taskState != .running {
                await self.scheduleReconnect(delay: nextDelay)
            }
        }
    }

    private func cancelReconnect() {
        reconnectWork?.cancel()
        reconnectWork = nil
    }

    private func reportState(_ state: WebSocketState) {
        onStateChange?(state)
    }
}