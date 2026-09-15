import Foundation

/// Parsed result from scanning a Kin daemon QR code.
/// Expected URL format: http(s)://host:port/?token=<bearer_token>
struct PairingPayload: Equatable, CustomStringConvertible {
    let baseURL: URL      // normalized origin
    let token: String

    /// Description that deliberately omits the token to avoid leaking secrets.
    var description: String {
        "PairingPayload(baseURL: \(baseURL.absoluteString), token: <redacted>)"
    }

    /// Parse and validate a QR URL payload.
    /// - Rejects credentials embedded in the URL outside the `token` query item.
    /// - Normalizes away paths, query, fragments, trailing slash from baseURL.
    /// - Enforces HTTP/HTTPS policy: LAN HTTP ok, public HTTP rejected, HTTPS always ok.
    /// - Parameter urlString: The raw URL string from QR scan.
    /// - Returns: A valid PairingPayload.
    /// - Throws: `PairingError` if validation fails.
    static func parse(_ urlString: String) throws -> PairingPayload {
        // 1. Validate URL can be parsed
        guard let components = URLComponents(string: urlString),
              let rawURL = components.url,
              let scheme = components.scheme?.lowercased()
        else {
            throw PairingError.invalidURL
        }

        // 2. Reject embedded credentials (user:password@)
        guard components.user == nil && components.password == nil else {
            throw PairingError.embeddedCredentials
        }

        // 3. Extract token query parameter
        guard let token = components.queryItems?.first(where: { $0.name == "token" })?.value, !token.isEmpty else {
            throw PairingError.missingToken
        }

        // 4. Validate token format (non-empty, printable ASCII)
        guard token.rangeOfCharacter(from: CharacterSet.controlCharacters) == nil else {
            throw PairingError.invalidTokenFormat
        }

        // 5. Validate scheme
        guard scheme == "http" || scheme == "https" else {
            throw PairingError.invalidURL
        }

        // 6. Build normalized baseURL (scheme://host:port)
        var baseComponents = URLComponents()
        baseComponents.scheme = scheme
        baseComponents.host = components.host
        baseComponents.port = components.port

        guard let baseURL = baseComponents.url else {
            throw PairingError.invalidURL
        }

        // 7. Security: reject non-local http:// URLs
        if scheme == "http" {
            guard let host = components.host else {
                throw PairingError.invalidURL
            }
            guard isPrivateNetworkHost(host) else {
                throw PairingError.publicHTTP
            }
        }

        return PairingPayload(baseURL: baseURL, token: token)
    }

    /// Check whether `host` is a private / loopback address that is safe for plain HTTP.
    /// Accepts: localhost, 127.x.x.x, 10.x.x.x, 172.16-31.x.x, 192.168.x.x.
    private static func isPrivateNetworkHost(_ host: String) -> Bool {
        let lowercased = host.lowercased()
        if lowercased == "localhost" { return true }

        // IPv4 check
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4, let first = Int(parts[0]), let second = Int(parts[1]) else {
            // Not a recognised private IPv4 pattern; reject HTTP
            return false
        }

        switch first {
        case 127:           return true   // loopback
        case 10:            return true   // private class A
        case 172:           return (16...31).contains(second)   // private class B
        case 192 where second == 168: return true   // private class C
        default:            return false
        }
    }
}

// MARK: - Errors

enum PairingError: LocalizedError {
    case invalidURL
    case missingToken
    case embeddedCredentials  // user:pass@host is rejected
    case publicHTTP           // non-local HTTP without TLS
    case invalidTokenFormat

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "The scanned URL is not valid."
        case .missingToken:
            return "No authentication token found in the QR code."
        case .embeddedCredentials:
            return "Embedded credentials in the URL are not supported. Use the token query parameter instead."
        case .publicHTTP:
            return "Unencrypted HTTP connections are only allowed on local networks."
        case .invalidTokenFormat:
            return "The token contains invalid characters."
        }
    }
}