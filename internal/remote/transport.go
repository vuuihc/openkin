package remote

import (
	"context"
	"net"
)

// Config configures a Transport listener (spec §7.1).
type Config struct {
	// Port is the TCP port to listen on (default 7777 when zero).
	Port int
	// Hostname is the tsnet node name (default "kin").
	Hostname string
	// StateDir is the tsnet state directory (default ~/.kin/tsnet).
	StateDir string
	// ControlURL is the Headscale / custom coordination server URL.
	// Empty means the Tailscale default control plane.
	ControlURL string
	// Funnel enables public HTTPS via Tailscale Funnel (tsnet only).
	Funnel bool
}

// PortOrDefault returns Port, or 7777 if Port is zero.
func (c Config) PortOrDefault() int {
	if c.Port <= 0 {
		return 7777
	}
	return c.Port
}

// Transport is a network binding for the Kin daemon (spec §7.1).
// Implementations: loopback, lan, tsnet (under internal/remote/tsnet).
//
// Import boundary: tailscale.com/* may only be imported under
// internal/remote/tsnet/.
type Transport interface {
	Name() string
	Listen(ctx context.Context, cfg Config) (net.Listener, error)
}
