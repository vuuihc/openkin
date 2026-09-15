import Foundation

/// Errors produced by the API client layer.
enum APIError: LocalizedError, Equatable {
    case unauthorized        // 401
    case conflict            // 409 — another client already acted
    case notFound            // 404
    case serverError(Int)    // 5xx
    case clientError(Int)    // other 4xx
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
        case .clientError(let code): return "Request error (\(code))"
        case .offline: return "Cannot reach the daemon"
        case .incompatible(let msg): return "Incompatible daemon: \(msg)"
        case .invalidResponse: return "Invalid response from daemon"
        case .unknown(let msg): return msg
        }
    }
}