import Foundation

/// Errors produced by the API client layer.
enum APIError: LocalizedError, Equatable {
    case unauthorized        // 401
    case conflict            // 409 — another client already acted
    case notFound            // 404
    case serverError(Int)    // 5xx
    /// Other 4xx. Carries the daemon's own message when it sent one, so a 400
    /// that arrives with an explanation is not shown as a bare status code.
    case clientError(Int, String?)
    case offline             // transport failure (no connection, timeout, etc.)
    case incompatible(String) // decoding failure or unexpected API contract
    case invalidResponse     // unexpected response shape
    case unknown(String)

    var errorDescription: String? {
        switch self {
        case .unauthorized: return "Unauthorized — check your connection"
        case .conflict: return "This was already handled by another client"
        case .notFound: return "Resource not found"
        case .serverError(let code): return "Server error (\(code))"
        case .clientError(let code, let message):
            return message.map { "\($0) (\(code))" } ?? "Request error (\(code))"
        case .offline: return "Cannot reach the daemon"
        case .incompatible(let msg): return "Incompatible daemon: \(msg)"
        case .invalidResponse: return "Invalid response from daemon"
        case .unknown(let msg): return msg
        }
    }
}