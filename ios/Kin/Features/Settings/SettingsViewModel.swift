import Foundation
import Observation

@Observable
final class SettingsViewModel {
    var savedProfiles: [ServerProfile] = []
    var activeProfileId: UUID?
    var daemonVersion: String?
    var connectionState: ConnectionState = .unconfigured

    func load() {
        savedProfiles = UserDefaults.loadServerProfiles()
    }

    func isActive(_ profile: ServerProfile) -> Bool {
        profile.id == activeProfileId
    }

    func switchTo(_ profile: ServerProfile) {
        // Update the active profile reference
        activeProfileId = profile.id
        // The caller (AppModel) is responsible for the actual reconnection.
    }

    func deleteProfile(_ profile: ServerProfile) {
        UserDefaults.deleteServerProfile(id: profile.id)
        savedProfiles = UserDefaults.loadServerProfiles()
        if activeProfileId == profile.id {
            activeProfileId = savedProfiles.first?.id
        }
    }

    func forgetAll() {
        UserDefaults.deleteServerProfile()
        savedProfiles = []
        activeProfileId = nil
    }

    func updateLastConnected(profileId: UUID) {
        guard let idx = savedProfiles.firstIndex(where: { $0.id == profileId }) else { return }
        var updated = savedProfiles[idx]
        updated.lastConnected = Date()
        savedProfiles[idx] = updated
        UserDefaults.upsertServerProfile(updated)
    }
}