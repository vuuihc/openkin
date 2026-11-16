package remote

import (
	"context"
	"fmt"
	"net"
)

// Loopback binds 127.0.0.1 only (spec §7 Local).
type Loopback struct{}

// Name implements Transport.
func (Loopback) Name() string { return "loopback" }

// Listen implements Transport.
func (Loopback) Listen(_ context.Context, cfg Config) (net.Listener, error) {
	addr := fmt.Sprintf("127.0.0.1:%d", cfg.PortOrDefault())
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("loopback listen %s: %w", addr, err)
	}
	return ln, nil
}
