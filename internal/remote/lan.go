package remote

import (
	"context"
	"fmt"
	"net"
	"strings"
)

// LAN binds 0.0.0.0 so devices on the local network can connect (spec §7 LAN).
type LAN struct{}

// Name implements Transport.
func (LAN) Name() string { return "lan" }

// Listen implements Transport.
func (LAN) Listen(_ context.Context, cfg Config) (net.Listener, error) {
	addr := fmt.Sprintf("0.0.0.0:%d", cfg.PortOrDefault())
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("lan listen %s: %w", addr, err)
	}
	return ln, nil
}

// PrimaryLANIP returns a preferred non-loopback IPv4 address for QR/deep links.
// Falls back to the first non-loopback IP, then "127.0.0.1".
func PrimaryLANIP() string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return "127.0.0.1"
	}
	var fallback string
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		// Skip common virtual / tunnel interfaces when a better one exists.
		name := strings.ToLower(iface.Name)
		isVirtual := strings.HasPrefix(name, "utun") ||
			strings.HasPrefix(name, "awdl") ||
			strings.HasPrefix(name, "llw") ||
			strings.HasPrefix(name, "bridge") ||
			strings.HasPrefix(name, "veth") ||
			strings.HasPrefix(name, "docker") ||
			strings.HasPrefix(name, "br-") ||
			strings.Contains(name, "tailscale") ||
			strings.HasPrefix(name, "tun")
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			ip := addrIP(a)
			if ip == nil || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
				continue
			}
			// Prefer IPv4 on physical-looking interfaces.
			if v4 := ip.To4(); v4 != nil {
				if !isVirtual {
					return v4.String()
				}
				if fallback == "" {
					fallback = v4.String()
				}
			} else if fallback == "" {
				fallback = ip.String()
			}
		}
	}
	if fallback != "" {
		return fallback
	}
	return "127.0.0.1"
}

func addrIP(a net.Addr) net.IP {
	switch v := a.(type) {
	case *net.IPNet:
		return v.IP
	case *net.IPAddr:
		return v.IP
	default:
		return nil
	}
}

// LANURL builds http://<primary-lan-ip>:<port>/?token=<token> for QR printing.
func LANURL(port int, token string) string {
	if port <= 0 {
		port = 7777
	}
	return fmt.Sprintf("http://%s:%d/?token=%s", PrimaryLANIP(), port, token)
}
