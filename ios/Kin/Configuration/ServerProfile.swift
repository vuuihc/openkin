import Foundation

/// A saved server connection profile.
struct ServerProfile: Identifiable, Codable, Equatable {
    let id: UUID
    var displayName: String
    var baseURL: URL
    var lastConnected: Date?

    init(id: UUID = UUID(), displayName: String, baseURL: URL, lastConnected: Date? = nil) {
        self.id = id
        self.displayName = displayName
        self.baseURL = baseURL
        self.lastConnected = lastConnected
    }
}

// MARK: - UserDefaults multi-profile storage

extension UserDefaults {
    private static let serverProfilesKey = "kin_server_profiles"

    /// Load all saved server profiles.
    static func loadServerProfiles() -> [ServerProfile] {
        guard let data = UserDefaults.standard.data(forKey: serverProfilesKey) else { return [] }
        return (try? JSONDecoder().decode([ServerProfile].self, from: data)) ?? []
    }

    /// Save all server profiles.
    static func saveServerProfiles(_ profiles: [ServerProfile]) {
        if let data = try? JSONEncoder().encode(profiles) {
            UserDefaults.standard.set(data, forKey: serverProfilesKey)
        }
    }

    /// Add or update a profile (by id).
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

    // MARK: - Legacy single-profile support

    private static let legacyServerURLKey = "kin_server_url"
    private static let legacyServerNameKey = "kin_server_name"

    /// Load the legacy single profile (migrates to multi if needed).
    static func loadServerProfile() -> ServerProfile? {
        // Prefer multi-profile storage
        let profiles = loadServerProfiles()
        if let first = profiles.first {
            return first
        }
        // Fall back to legacy keys
        guard let urlString = UserDefaults.standard.string(forKey: legacyServerURLKey),
              let url = URL(string: urlString) else { return nil }
        let name = UserDefaults.standard.string(forKey: legacyServerNameKey) ?? url.host ?? "Server"
        let profile = ServerProfile(displayName: name, baseURL: url)
        // Migrate to multi-profile
        upsertServerProfile(profile)
        return profile
    }

    /// Save a single profile (legacy, delegates to multi-profile).
    static func saveServerProfile(_ profile: ServerProfile) {
        upsertServerProfile(profile)
        // Also write legacy keys for any old code paths
        UserDefaults.standard.set(profile.baseURL.absoluteString, forKey: legacyServerURLKey)
        UserDefaults.standard.set(profile.displayName, forKey: legacyServerNameKey)
    }

    /// Delete all profiles.
    static func deleteServerProfile() {
        UserDefaults.standard.removeObject(forKey: serverProfilesKey)
        UserDefaults.standard.removeObject(forKey: legacyServerURLKey)
        UserDefaults.standard.removeObject(forKey: legacyServerNameKey)
    }
}