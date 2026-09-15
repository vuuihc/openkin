import Foundation
import Observation

@Observable
final class AppModel {
    var activeProfile: ServerProfile?
    var connectionState: ConnectionState = .unconfigured
    var savedProfiles: [ServerProfile] = []

    init() {
        loadSavedProfiles()
    }

    // MARK: - Profile management

    func loadSavedProfiles() {
        savedProfiles = UserDefaults.loadServerProfiles()
        // If there are saved profiles, default to the first (or most recently connected)
        if activeProfile == nil, let first = savedProfiles.first {
            activeProfile = first
        }
    }

    /// Called on app launch to select a profile to connect to.
    /// Returns the profile to use, or nil if the user should pick.
    func resolveStartupProfile() -> ServerProfile? {
        loadSavedProfiles()
        if savedProfiles.count == 1 {
            // Single profile — auto-connect
            activeProfile = savedProfiles.first
            return activeProfile
        }
        if savedProfiles.count > 1 {
            // Multiple profiles — return nil so the UI shows a picker
            activeProfile = nil
            return nil
        }
        return nil
    }

    /// Connect to a specific profile.
    func connect(to profile: ServerProfile) {
        activeProfile = profile
        connectionState = .connecting
        // Update the last connected timestamp
        var updated = profile
        updated.lastConnected = Date()
        UserDefaults.upsertServerProfile(updated)
        // Actual connection logic (URLSession, WebSocket, etc.) would go here.
        // For now, simulate connection success.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            guard let self else { return }
            self.connectionState = .connected
            self.loadSavedProfiles()
        }
    }

    func disconnect() {
        connectionState = .disconnected
        activeProfile = nil
    }

    func addProfile(_ profile: ServerProfile) {
        UserDefaults.upsertServerProfile(profile)
        loadSavedProfiles()
    }

    func deleteProfile(_ profile: ServerProfile) {
        UserDefaults.deleteServerProfile(id: profile.id)
        loadSavedProfiles()
        if activeProfile?.id == profile.id {
            activeProfile = savedProfiles.first
        }
    }
}