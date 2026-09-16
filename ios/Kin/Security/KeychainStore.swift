import Foundation
import Security

/// Secure storage for credentials and pairing tokens using the iOS Keychain.
/// The auth token is kept in the Secure Enclave / Keychain and never written to
/// UserDefaults or included in logs or descriptions.
struct KeychainStore {
    private static let service = "dev.openkin.ios.keychain"
    private static let account = "daemon-token"

    private static func profileAccount(_ id: UUID) -> String {
        "daemon-token-\(id.uuidString)"
    }

    static func store(token: String, for profileID: UUID) throws {
        try store(token: token, accountName: profileAccount(profileID))
    }

    static func readToken(for profileID: UUID) throws -> String? {
        try readToken(accountName: profileAccount(profileID))
    }

    static func updateToken(_ token: String, for profileID: UUID) throws {
        try updateToken(token, accountName: profileAccount(profileID))
    }

    static func deleteToken(for profileID: UUID) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: profileAccount(profileID),
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.unhandledError(status: status)
        }
    }

    // MARK: - CRUD

    /// Store a new token in the Keychain.
    /// - Throws: `KeychainError.duplicate` if a token already exists (call `updateToken` instead).
    static func store(token: String) throws {
        try store(token: token, accountName: account)
    }

    private static func store(token: String, accountName: String) throws {
        guard let data = token.data(using: .utf8) else {
            throw KeychainError.unhandledError(status: errSecDecode)
        }

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: accountName,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            kSecValueData as String: data,
        ]

        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else {
            if status == errSecDuplicateItem {
                throw KeychainError.duplicate
            }
            throw KeychainError.unhandledError(status: status)
        }
    }

    /// Read the stored token from the Keychain.
    /// - Returns: The token string, or `nil` if no token exists.
    /// - Throws: `KeychainError.unhandledError` on unexpected Security framework errors.
    static func readToken() throws -> String? {
        try readToken(accountName: account)
    }

    private static func readToken(accountName: String) throws -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: accountName,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        switch status {
        case errSecSuccess:
            guard let data = result as? Data, let token = String(data: data, encoding: .utf8) else {
                throw KeychainError.unhandledError(status: errSecDecode)
            }
            return token
        case errSecItemNotFound:
            return nil
        default:
            throw KeychainError.unhandledError(status: status)
        }
    }

    /// Delete the stored token from the Keychain.
    static func deleteToken() throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]

        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.unhandledError(status: status)
        }
    }

    /// Update an existing token in the Keychain.
    /// - Throws: `KeychainError.notFound` if no token exists yet (call `store` instead).
    static func updateToken(_ token: String) throws {
        try updateToken(token, accountName: account)
    }

    private static func updateToken(_ token: String, accountName: String) throws {
        guard let data = token.data(using: .utf8) else {
            throw KeychainError.unhandledError(status: errSecDecode)
        }

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: accountName,
        ]

        let attributes: [String: Any] = [
            kSecValueData as String: data,
        ]

        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        switch status {
        case errSecSuccess:
            return
        case errSecItemNotFound:
            throw KeychainError.notFound
        default:
            throw KeychainError.unhandledError(status: status)
        }
    }
}

// MARK: - Errors

/// Errors originating from Keychain operations.
enum KeychainError: Error, CustomStringConvertible {
    case unhandledError(status: OSStatus)
    case notFound
    case duplicate

    var description: String {
        switch self {
        case .unhandledError(let status):
            return "KeychainError: unhandled Security framework error (status \(status))."
        case .notFound:
            return "KeychainError: item not found."
        case .duplicate:
            return "KeychainError: item already exists."
        }
    }
}
