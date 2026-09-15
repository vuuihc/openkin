import Foundation

/// Connection profile for a Kin desktop daemon.
/// Metadata is stored in UserDefaults; the auth token is stored separately in Keychain.
struct ServerProfile: Codable, Hashable, Identifiable {
    let id: UUID
    var displayName: String
    var baseURL: URL        // normalized origin (scheme + host + port)
    let dateAdded: Date
    var lastAccessed: Date

    /// The origin string (e.g. "http://192.168.1.42:7777")
    var origin: String {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            return baseURL.absoluteString
        }
        components.path = ""
        components.query = nil
        components.fragment = nil
        return components.url?.absoluteString ?? baseURL.absoluteString
    }

    /// Is this a local-network HTTP connection?
    var isLAN: Bool {
        baseURL.scheme == "http"
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
    static func validate(baseURL: URL, token: String) async throws -> (health: Bool, version: String?) {
        guard var healthComponents = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw ServerProfileError.invalidURL
        }
        healthComponents.path = "/api/health"
        healthComponents.query = nil
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

        // Fetch version
        var versionComponents = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        versionComponents.path = "/api/version"
        versionComponents.query = nil
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
        return (try? JSONDecoder().decode([ServerProfile].self, from: data)) ?? []
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