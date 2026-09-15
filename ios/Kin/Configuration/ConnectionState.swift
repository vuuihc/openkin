import Foundation

/// The state of the connection to a Kin daemon.
enum ConnectionState: Equatable {
    /// No server has been configured yet.
    case unconfigured
    /// Attempting to connect.
    case connecting
    /// Connected and operational.
    case connected
    /// Intentionally disconnected.
    case disconnected
    /// Connection error.
    case error(String)
}