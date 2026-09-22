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

enum SettingsPresentation {
    struct ProfileSummary: Equatable {
        let title: String
        let origin: String
        let transportKey: String
        let credentialKey: String
        let managementAccessKey: String
        let isActive: Bool
        let canManageDaemon: Bool
    }

    static func profileSummary(for profile: ServerProfile, activeProfileID: UUID?) -> ProfileSummary {
        ProfileSummary(
            title: profile.activeDesktopName,
            origin: profile.origin,
            transportKey: profile.transport.localizationKey,
            credentialKey: credentialKey(for: profile.credentialScope),
            managementAccessKey: profile.canManageDaemon ? "settings.management.full" : "settings.management.read_only",
            isActive: profile.id == activeProfileID,
            canManageDaemon: profile.canManageDaemon
        )
    }

    private static func credentialKey(for scope: ServerProfile.CredentialScope) -> String {
        switch scope {
        case .device:
            return "settings.profile.credential.device"
        case .master:
            return "settings.profile.credential.master"
        }
    }
}

enum OperationsPresentation {
    static func displayLabel(_ rawValue: String) -> String {
        ProjectPresentation.displayLabel(rawValue)
    }

    static func agentAuthStatusLabel(_ rawValue: String) -> String {
        localizedLabel(for: rawValue, keys: [
            "signed_in": "operations.agent_status.signed_in",
            "not_signed_in": "operations.agent_status.not_signed_in",
            "unknown": "operations.status.unknown"
        ])
    }

    static func usageStatusLabel(_ rawValue: String) -> String {
        localizedLabel(for: rawValue, keys: [
            "ok": "operations.usage_status.ok",
            "warn": "operations.usage_status.warn",
            "over": "operations.usage_status.over"
        ])
    }

    static func providerKindLabel(_ rawValue: String) -> String {
        localizedLabel(for: rawValue, keys: [
            "openai": "providers.kind.openai",
            "openai_compatible": "providers.kind.openai_compatible",
            "anthropic": "providers.kind.anthropic",
            "ollama": "providers.kind.ollama"
        ])
    }

    static func workerStateLabel(_ rawValue: String) -> String {
        localizedLabel(for: rawValue, keys: [
            "online": "workers.state.online",
            "offline": "workers.state.offline",
            "stale": "workers.state.stale",
            "revoked": "workers.state.revoked"
        ])
    }

    static func canSaveProvider(
        loadedProfileID: UUID?,
        activeProfileID: UUID?,
        canManageDaemon: Bool,
        isSaving: Bool,
        selectedID: String?,
        name: String,
        baseURL: String,
        model: String
    ) -> Bool {
        canMutateLoadedProfile(
            loadedProfileID: loadedProfileID,
            activeProfileID: activeProfileID,
            canManageDaemon: canManageDaemon
        )
            && !isSaving
            && selectedID != nil
            && !trimmed(name).isEmpty
            && !trimmed(baseURL).isEmpty
            && !trimmed(model).isEmpty
    }

    static func canMutateLoadedProfile(
        loadedProfileID: UUID?,
        activeProfileID: UUID?,
        canManageDaemon: Bool
    ) -> Bool {
        guard let loadedProfileID, let activeProfileID else { return false }
        return canManageDaemon && loadedProfileID == activeProfileID
    }

    static func workerDisplayName(_ worker: WorkerRecord) -> String {
        let trimmedLabel = worker.label?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmedLabel.isEmpty ? worker.workerId : trimmedLabel
    }

    private static func trimmed(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func normalized(_ value: String) -> String {
        trimmed(value)
            .lowercased()
            .replacingOccurrences(of: "-", with: "_")
    }

    private static func localizedLabel(for rawValue: String, keys: [String: String]) -> String {
        if let key = keys[normalized(rawValue)] {
            return String(localized: String.LocalizationValue(key))
        }
        return displayLabel(rawValue)
    }
}
