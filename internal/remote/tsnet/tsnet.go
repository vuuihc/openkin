// Package tsnet implements the Tailscale/Headscale transport for Kin.
//
// Import boundary (spec §7.1): this is the ONLY package allowed to import
// tailscale.com/*. A CI test greps the rest of the module for violations.
package tsnet

import (
	"context"
	"fmt"
	"log"
	"net"
	"os"
	"strings"

	"tailscale.com/tsnet"

	"github.com/vuuihc/kin/internal/remote"
)

// Transport binds via an embedded Tailscale node named "kin" (spec §7).
type Transport struct {
	// ServerFactory builds a *tsnet.Server from config. Tests inject a stub;
	// production uses BuildServer.
	ServerFactory func(cfg remote.Config) Server

	// OnAuthURL is called when the first-run login URL is observed (optional).
	OnAuthURL func(url string)

	// OnReady is called with the tailnet base URL once the node is up (optional).
	OnReady func(baseURL string)

	server Server
}

// Server is the subset of *tsnet.Server used by this transport.
// Tests can implement it without network I/O.
type Server interface {
	// Up brings the node online and returns when connected (or ctx cancels).
	Up(ctx context.Context) error
	// Listen starts a TCP listener on the tailnet (or Funnel when funnel=true).
	Listen(network, addr string) (net.Listener, error)
	// ListenFunnel starts a public HTTPS Funnel listener.
	ListenFunnel(network, addr string) (net.Listener, error)
	// TailnetURL returns a preferred http(s) base URL for the node (no trailing slash).
	TailnetURL() string
	// FunnelURL returns the public Funnel base URL when available.
	FunnelURL() string
	// Close shuts down the node.
	Close() error
	// ControlURL returns the configured control plane URL (for tests).
	ControlURL() string
}

// Name implements remote.Transport.
func (t *Transport) Name() string { return "tsnet" }

// Listen implements remote.Transport. Does not dial if ServerFactory returns a
// pre-configured test double; production BuildServer only contacts the network
// when Up/Listen is invoked by the caller of this method.
func (t *Transport) Listen(ctx context.Context, cfg remote.Config) (net.Listener, error) {
	factory := t.ServerFactory
	if factory == nil {
		factory = func(c remote.Config) Server { return BuildServer(c) }
	}
	s := factory(cfg)
	t.server = s

	if err := s.Up(ctx); err != nil {
		_ = s.Close()
		return nil, fmt.Errorf("tsnet up: %w", err)
	}

	if base := s.TailnetURL(); base != "" && t.OnReady != nil {
		t.OnReady(base)
	}

	port := cfg.PortOrDefault()
	if cfg.Funnel {
		ln, err := s.ListenFunnel("tcp", ":443")
		if err != nil {
			_ = s.Close()
			return nil, fmt.Errorf("tsnet funnel listen: %w", err)
		}
		return &closeBoth{Listener: ln, server: s}, nil
	}

	addr := fmt.Sprintf(":%d", port)
	ln, err := s.Listen("tcp", addr)
	if err != nil {
		_ = s.Close()
		return nil, fmt.Errorf("tsnet listen %s: %w", addr, err)
	}
	return &closeBoth{Listener: ln, server: s}, nil
}

// Server returns the active server (after Listen), or nil.
func (t *Transport) Server() Server { return t.server }

// BuildServer constructs a real *tsnet.Server from cfg without connecting.
// Safe for unit tests that only assert field plumbing (ControlURL, Dir, Hostname).
func BuildServer(cfg remote.Config) Server {
	hostname := cfg.Hostname
	if hostname == "" {
		hostname = "kin"
	}
	dir := cfg.StateDir
	if dir == "" {
		home, _ := os.UserHomeDir()
		dir = home + "/.kin/tsnet"
	}
	_ = os.MkdirAll(dir, 0o700)

	s := &tsnet.Server{
		Hostname:   hostname,
		Dir:        dir,
		ControlURL: cfg.ControlURL,
		UserLogf:   log.Printf,
		// Discard backend spam; UserLogf still prints AuthURL.
		Logf: func(string, ...any) {},
	}
	return &liveServer{s: s, controlURL: cfg.ControlURL}
}

type liveServer struct {
	s          *tsnet.Server
	controlURL string
	statusURL  string
	funnelURL  string
}

func (l *liveServer) ControlURL() string { return l.controlURL }

func (l *liveServer) Up(ctx context.Context) error {
	st, err := l.s.Up(ctx)
	if err != nil {
		return err
	}
	// Prefer MagicDNS name; fall back to Tailscale IPs.
	if st != nil {
		if st.Self != nil {
			dns := strings.TrimSuffix(st.Self.DNSName, ".")
			if dns != "" {
				l.statusURL = "http://" + dns
			}
			for _, ip := range st.Self.TailscaleIPs {
				if ip.Is4() {
					if l.statusURL == "" {
						l.statusURL = "http://" + ip.String()
					}
					break
				}
			}
		}
	}
	// Funnel public name from cert domains when available.
	for _, d := range l.s.CertDomains() {
		d = strings.TrimSuffix(d, ".")
		if d != "" {
			l.funnelURL = "https://" + d
			break
		}
	}
	return nil
}

func (l *liveServer) Listen(network, addr string) (net.Listener, error) {
	return l.s.Listen(network, addr)
}

func (l *liveServer) ListenFunnel(network, addr string) (net.Listener, error) {
	return l.s.ListenFunnel(network, addr)
}

func (l *liveServer) TailnetURL() string { return l.statusURL }
func (l *liveServer) FunnelURL() string  { return l.funnelURL }

func (l *liveServer) Close() error { return l.s.Close() }

// closeBoth closes the listener and the underlying tsnet server.
type closeBoth struct {
	net.Listener
	server Server
}

func (c *closeBoth) Close() error {
	err1 := c.Listener.Close()
	var err2 error
	if c.server != nil {
		err2 = c.server.Close()
	}
	if err1 != nil {
		return err1
	}
	return err2
}

// ValidateFlags checks funnel + control-url mutual exclusion (spec §7.2).
// Call before starting any listener.
func ValidateFlags(funnel bool, controlURL string) error {
	if funnel && strings.TrimSpace(controlURL) != "" {
		return fmt.Errorf("--funnel is a Tailscale-only feature and cannot be used with --ts-control-url (Headscale); remove one of them")
	}
	return nil
}
