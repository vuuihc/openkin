import Foundation

/// Represents the current connection state to the Kin daemon.
enum ConnectionState: Equatable {
    case unconfigured
    case connecting
    case connected
    case reconnecting(delay: TimeInterval)
    case unauthorized
    case incompatible
    case offline(String)

    var isConnected: Bool {
        self == .connected
    }
}