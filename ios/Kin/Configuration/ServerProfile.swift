import Foundation

func kinJoinedPath(_ basePath: String, _ endpoint: String) -> String {
    let base = basePath.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    let suffix = endpoint.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    if base.isEmpty { return "/" + suffix }
    if suffix.isEmpty { return "/" + base }
    return "/" + base + "/" + suffix
}

enum ServerProfileTransport: Equatable {
    case lanHTTP
    case httpsTunnel
    case relay

    var localizationKey: String {
        switch self {
        case .lanHTTP:
            return "desktop.transport.lan_http"
        case .httpsTunnel:
            return "desktop.transport.https_tunnel"
        case .relay:
            return "desktop.transport.relay"
        }
    }
}

/// Connection profile for a Kin desktop daemon.
/// Metadata is stored in UserDefaults; the auth token is stored separately in Keychain.
struct ServerProfile: Codable, Hashable, Identifiable {
    enum CredentialScope: String, Codable {
        case device
        case master
    }

    let id: UUID
    var displayName: String
    var baseURL: URL        // normalized origin (scheme + host + port)
    var relayKey: String?
    var relayRoom: String?
    let dateAdded: Date
    var lastAccessed: Date
    var credentialScope: CredentialScope

    init(
        id: UUID,
        displayName: String,
        baseURL: URL,
        relayKey: String?,
        relayRoom: String?,
        dateAdded: Date,
        lastAccessed: Date,
        credentialScope: CredentialScope = .device
    ) {
        self.id = id
        self.displayName = displayName
        self.baseURL = baseURL
        self.relayKey = relayKey
        self.relayRoom = relayRoom
        self.dateAdded = dateAdded
        self.lastAccessed = lastAccessed
        self.credentialScope = credentialScope
    }

    enum CodingKeys: String, CodingKey {
        case id, displayName, baseURL, relayKey, relayRoom, dateAdded, lastAccessed, credentialScope
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(UUID.self, forKey: .id)
        displayName = try container.decode(String.self, forKey: .displayName)
        baseURL = try container.decode(URL.self, forKey: .baseURL)
        relayKey = try container.decodeIfPresent(String.self, forKey: .relayKey)
        relayRoom = try container.decodeIfPresent(String.self, forKey: .relayRoom)
        dateAdded = try container.decode(Date.self, forKey: .dateAdded)
        lastAccessed = try container.decode(Date.self, forKey: .lastAccessed)
        credentialScope = try container.decodeIfPresent(CredentialScope.self, forKey: .credentialScope) ?? .device
    }

    /// The public base string (e.g. "http://192.168.1.42:7777").
    var origin: String {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            return baseURL.absoluteString
        }
        if components.path == "/" {
            components.path = ""
        }
        components.query = nil
        components.fragment = nil
        return components.url?.absoluteString ?? baseURL.absoluteString
    }

    /// Is this a local-network HTTP connection?
    var isLAN: Bool {
        baseURL.scheme == "http"
    }

    var canManageDaemon: Bool {
        credentialScope == .master
    }

    var displayHost: String {
        URLComponents(url: baseURL, resolvingAgainstBaseURL: false)?.host ?? origin
    }

    var activeDesktopName: String {
        let trimmed = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? displayHost : trimmed
    }

    var transport: ServerProfileTransport {
        if relayKey?.isEmpty == false || relayRoom?.isEmpty == false {
            return .relay
        }
        return isLAN ? .lanHTTP : .httpsTunnel
    }
}

// MARK: - Validation

/// Validates a connection against a Kin daemon.
struct ServerProfileValidator {
    /// Validates the given base URL and auth token by hitting the daemon health and version endpoints.
    /// - Parameters:
    ///   - baseURL: The daemon's base URL (e.g. http://192.168.1.42:7777).
    ///   - token:  The bearer token to present.
    /// - Returns: A tuple with a health flag and an optional version string.
    /// - Throws: `ServerProfileError` if the daemon is unreachable, incompatible, or the token is rejected.
    static func validate(
        baseURL: URL, token: String, relayKey: String? = nil, relayRoom: String? = nil
    ) async throws -> (health: Bool, version: String?) {
        guard var healthComponents = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw ServerProfileError.invalidURL
        }
        healthComponents.path = kinJoinedPath(healthComponents.path, "/api/health")
        healthComponents.queryItems = relayQueryItems(key: relayKey, room: relayRoom)
        healthComponents.fragment = nil

        guard let healthURL = healthComponents.url else {
            throw ServerProfileError.invalidURL
        }

        var healthRequest = URLRequest(url: healthURL)
        healthRequest.httpMethod = "GET"
        healthRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        healthRequest.timeoutInterval = 10

        let (healthData, healthResponse): (Data, URLResponse)
        do {
            (healthData, healthResponse) = try await URLSession.shared.data(for: healthRequest)
        } catch {
            throw ServerProfileError.unreachable
        }

        guard let httpResponse = healthResponse as? HTTPURLResponse else {
            throw ServerProfileError.unreachable
        }

        switch httpResponse.statusCode {
        case 200:
            break
        case 401, 403:
            throw ServerProfileError.unauthorized
        case 404:
            throw ServerProfileError.incompatible
        default:
            throw ServerProfileError.unreachable
        }

        let health = (try? JSONSerialization.jsonObject(with: healthData) as? [String: Any])?["ok"] as? Bool ?? false

        // Health is intentionally public, so validate the bearer token against
        // an authenticated read before accepting the profile.
        var probeComponents = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        probeComponents.path = kinJoinedPath(probeComponents.path, "/api/tasks")
        probeComponents.queryItems = [URLQueryItem(name: "limit", value: "1")] +
            (relayQueryItems(key: relayKey, room: relayRoom) ?? [])
        guard let probeURL = probeComponents.url else {
            throw ServerProfileError.invalidURL
        }
        var probeRequest = URLRequest(url: probeURL)
        probeRequest.httpMethod = "GET"
        probeRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        probeRequest.timeoutInterval = 10
        do {
            let (_, probeResponse) = try await URLSession.shared.data(for: probeRequest)
            guard let probeHTTP = probeResponse as? HTTPURLResponse else {
                throw ServerProfileError.unreachable
            }
            switch probeHTTP.statusCode {
            case 200:
                break
            case 401, 403:
                throw ServerProfileError.unauthorized
            default:
                throw ServerProfileError.unreachable
            }
        } catch let error as ServerProfileError {
            throw error
        } catch {
            throw ServerProfileError.unreachable
        }

        // Fetch version
        var versionComponents = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        versionComponents.path = kinJoinedPath(versionComponents.path, "/api/version")
        versionComponents.queryItems = relayQueryItems(key: relayKey, room: relayRoom)
        versionComponents.fragment = nil

        guard let versionURL = versionComponents.url else {
            return (health, nil)
        }

        var versionRequest = URLRequest(url: versionURL)
        versionRequest.httpMethod = "GET"
        versionRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        versionRequest.timeoutInterval = 10

        let versionString: String?
        do {
            let (versionData, versionResponse) = try await URLSession.shared.data(for: versionRequest)
            if let vHttp = versionResponse as? HTTPURLResponse, vHttp.statusCode == 200 {
                versionString = String(data: versionData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
            } else {
                versionString = nil
            }
        } catch {
            versionString = nil
        }

        return (health, versionString)
    }
}

private func relayQueryItems(key: String?, room: String?) -> [URLQueryItem]? {
    let items = (room.map { [URLQueryItem(name: "room", value: $0)] } ?? []) +
        (key.map { [URLQueryItem(name: "key", value: $0)] } ?? [])
    return items.isEmpty ? nil : items
}

// MARK: - Errors

/// Errors that can occur when connecting to or validating a Kin daemon.
enum ServerProfileError: LocalizedError {
    case unreachable
    case unauthorized
    case incompatible
    case invalidURL

    var errorDescription: String? {
        switch self {
        case .unreachable:
            return "The server could not be reached. Check the address and network connection."
        case .unauthorized:
            return "The token was rejected. Re-scan the QR code to obtain a fresh token."
        case .incompatible:
            return "The server version is not compatible with this app."
        case .invalidURL:
            return "The server address is not a valid URL."
        }
    }
}

// MARK: - UserDefaults Persistence

extension UserDefaults {
    private static let serverProfileKey = "kin_server_profile"
    private static let serverProfilesKey = "kin_server_profiles"

    /// Load the saved server profile from UserDefaults (legacy single-profile).
    static func loadServerProfile() -> ServerProfile? {
        guard let data = UserDefaults.standard.data(forKey: serverProfileKey) else { return nil }
        return try? JSONDecoder().decode(ServerProfile.self, from: data)
    }

    /// Save a server profile to UserDefaults (legacy single-profile).
    static func saveServerProfile(_ profile: ServerProfile) {
        if let data = try? JSONEncoder().encode(profile) {
            UserDefaults.standard.set(data, forKey: serverProfileKey)
        }
    }

    /// Remove the saved server profile from UserDefaults.
    static func deleteServerProfile() {
        UserDefaults.standard.removeObject(forKey: serverProfileKey)
    }

    // MARK: - Multi-device support

    /// Load all saved server profiles.
    static func loadServerProfiles() -> [ServerProfile] {
        guard let data = UserDefaults.standard.data(forKey: serverProfilesKey) else {
            // Migrate from legacy single profile
            if let legacy = loadServerProfile() {
                let profiles = [legacy]
                saveServerProfiles(profiles)
                return profiles
            }
            return []
        }
        return ((try? JSONDecoder().decode([ServerProfile].self, from: data)) ?? [])
            .sorted { $0.lastAccessed > $1.lastAccessed }
    }

    /// Save all server profiles.
    static func saveServerProfiles(_ profiles: [ServerProfile]) {
        if let data = try? JSONEncoder().encode(profiles) {
            UserDefaults.standard.set(data, forKey: serverProfilesKey)
        }
    }

    /// Add or update a profile by id.
    static func upsertServerProfile(_ profile: ServerProfile) {
        var profiles = loadServerProfiles()
        if let idx = profiles.firstIndex(where: { $0.id == profile.id }) {
            profiles[idx] = profile
        } else {
            profiles.append(profile)
        }
        saveServerProfiles(profiles)
    }

    /// Delete a profile by id.
    static func deleteServerProfile(id: UUID) {
        var profiles = loadServerProfiles()
        profiles.removeAll { $0.id == id }
        saveServerProfiles(profiles)
    }
}
