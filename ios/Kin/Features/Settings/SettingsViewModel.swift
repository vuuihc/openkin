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

    func deleteProfile(_ profile: ServerProfile) {
        UserDefaults.deleteServerProfile(id: profile.id)
        savedProfiles = UserDefaults.loadServerProfiles()
    }
}