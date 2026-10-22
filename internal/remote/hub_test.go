package remote

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newTestHub(t *testing.T, cfg HubConfig) *Hub {
	t.Helper()
	if cfg.StateDir == "" {
		cfg.StateDir = t.TempDir()
	}
	hub, err := NewHub(cfg)
	if err != nil {
		t.Fatalf("new hub: %v", err)
	}
	t.Cleanup(func() { _ = hub.Close() })
	return hub
}

func TestHubConfigValidation(t *testing.T) {
	cases := []struct {
		name    string
		cfg     HubConfig
		wantErr string
	}{
		{"missing domain", HubConfig{StateDir: "/tmp/x"}, "domain is required"},
		{"domain with scheme", HubConfig{Domain: "https://kin.example.com", StateDir: "/tmp/x"}, "bare hostname"},
		{"domain with port", HubConfig{Domain: "kin.example.com:443", StateDir: "/tmp/x"}, "bare hostname"},
		{"domain with path", HubConfig{Domain: "kin.example.com/console", StateDir: "/tmp/x"}, "bare hostname"},
		{"missing state dir", HubConfig{Domain: "kin.example.com"}, "state dir is required"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := NewHub(tc.cfg)
			if err == nil {
				t.Fatal("expected an error")
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("error = %q, want it to mention %q", err, tc.wantErr)
			}
		})
	}
}

func TestHubNormalizesDomainAndDefaultsPorts(t *testing.T) {
	hub := newTestHub(t, HubConfig{Domain: "  Kin.Example.COM  "})
	if got := hub.Domain(); got != "kin.example.com" {
		t.Fatalf("domain = %q, want lowercased and trimmed", got)
	}
	if got := hub.URL(); got != "https://kin.example.com" {
		t.Fatalf("url = %q, want the default port elided", got)
	}
	if hub.cfg.HTTPSPort != DefaultHTTPSPort || hub.cfg.HTTPPort != DefaultHTTPPort {
		t.Fatalf("ports = %d/%d, want %d/%d",
			hub.cfg.HTTPSPort, hub.cfg.HTTPPort, DefaultHTTPSPort, DefaultHTTPPort)
	}
}

func TestHubURLKeepsNonDefaultPort(t *testing.T) {
	hub := newTestHub(t, HubConfig{Domain: "kin.example.com", HTTPSPort: 8443, HTTPPort: 8080})
	if got := hub.URL(); got != "https://kin.example.com:8443" {
		t.Fatalf("url = %q", got)
	}
}

func TestHubRejectsCollidingPorts(t *testing.T) {
	if _, err := NewHub(HubConfig{Domain: "kin.example.com", StateDir: t.TempDir(), HTTPSPort: 443, HTTPPort: 443}); err == nil {
		t.Fatal("the ACME challenge server cannot share the HTTPS port")
	}
}

// TestHubHostPolicyIsPinned is the security-relevant assertion: without a host
// policy, any hostname pointed at this IP could obtain a certificate through
// this Hub and burn Let's Encrypt's per-account rate limit doing it.
func TestHubHostPolicyIsPinned(t *testing.T) {
	hub := newTestHub(t, HubConfig{Domain: "kin.example.com"})
	if hub.manager.HostPolicy == nil {
		t.Fatal("no host policy is set; any hostname resolving here could request a certificate")
	}
	if err := hub.manager.HostPolicy(context.Background(), "kin.example.com"); err != nil {
		t.Fatalf("configured domain was refused: %v", err)
	}
	if err := hub.manager.HostPolicy(context.Background(), "attacker.example.com"); err == nil {
		t.Fatal("host policy accepted a foreign hostname")
	}
}

func TestHubRedirectsPlaintextToHTTPS(t *testing.T) {
	hub := newTestHub(t, HubConfig{Domain: "kin.example.com"})
	handler := hub.redirectToHTTPS()

	req := httptest.NewRequest(http.MethodPost, "http://kin.example.com/sessions?tab=active", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusPermanentRedirect {
		t.Fatalf("status = %d, want 308", rec.Code)
	}
	// 308 rather than 301 keeps the method and body for a client that posts to
	// the plaintext port.
	if got, want := rec.Header().Get("Location"), "https://kin.example.com/sessions?tab=active"; got != want {
		t.Fatalf("location = %q, want %q", got, want)
	}
}

func TestHubRedirectKeepsNonDefaultPort(t *testing.T) {
	hub := newTestHub(t, HubConfig{Domain: "kin.example.com", HTTPSPort: 8443, HTTPPort: 8080})
	req := httptest.NewRequest(http.MethodGet, "http://kin.example.com/", nil)
	rec := httptest.NewRecorder()
	hub.redirectToHTTPS().ServeHTTP(rec, req)
	if got, want := rec.Header().Get("Location"), "https://kin.example.com:8443/"; got != want {
		t.Fatalf("location = %q, want %q", got, want)
	}
}

func TestHubChallengeServerRoutesACMEWithoutRedirecting(t *testing.T) {
	hub := newTestHub(t, HubConfig{Domain: "kin.example.com", HTTPPort: freePort(t)})
	if err := hub.StartChallengeServer(); err != nil {
		t.Fatalf("start challenge server: %v", err)
	}

	// The ACME path must reach autocert's handler rather than the redirect,
	// otherwise no certificate can ever be issued.
	req := httptest.NewRequest(http.MethodGet, "http://kin.example.com/.well-known/acme-challenge/token", nil)
	rec := httptest.NewRecorder()
	hub.manager.HTTPHandler(hub.redirectToHTTPS()).ServeHTTP(rec, req)
	if rec.Code == http.StatusPermanentRedirect {
		t.Fatal("the ACME challenge path was redirected instead of served")
	}
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown challenge token returned %d, want 404", rec.Code)
	}
}

func TestHubTLSConfigRequiresModernTLS(t *testing.T) {
	hub := newTestHub(t, HubConfig{Domain: "kin.example.com"})
	cfg := hub.TLSConfig()
	if cfg.GetCertificate == nil {
		t.Fatal("no certificate hook; autocert is not wired in")
	}
	if cfg.MinVersion < 0x0303 {
		t.Fatalf("MinVersion = %#x, want at least TLS 1.2", cfg.MinVersion)
	}
}

func TestHubListenFailsOnPrivilegedPortWithoutPermission(t *testing.T) {
	// A Hub configured for a port already in use must report it clearly rather
	// than starting half-bound.
	busy := freePort(t)
	blocker := &Hub{cfg: HubConfig{Domain: "kin.example.com", HTTPSPort: busy, HTTPPort: 1}}
	if _, err := blocker.Listen(context.Background(), Config{}); err != nil {
		t.Fatalf("listen on a free port: %v", err)
	}
	second := &Hub{cfg: HubConfig{Domain: "kin.example.com", HTTPSPort: busy, HTTPPort: 1}}
	if _, err := second.Listen(context.Background(), Config{}); err == nil {
		t.Fatal("binding an occupied port should fail")
	}
}

// freePort returns a port that was free a moment ago. Tests that need a real
// bind use it to avoid colliding with a developer's running daemon.
func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve port: %v", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()
	return port
}
