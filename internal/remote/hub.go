package remote

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/crypto/acme"
	"golang.org/x/crypto/acme/autocert"
)

// Default ports for a Hub that terminates its own TLS.
const (
	DefaultHTTPSPort = 443
	DefaultHTTPPort  = 80
)

// HubConfig describes the public HTTPS binding of a Hub.
type HubConfig struct {
	// Domain is the only hostname this Hub will obtain a certificate for.
	Domain string
	// Email is the ACME account contact. Optional, but without it Let's Encrypt
	// cannot warn about expiring certificates.
	Email string
	// StateDir holds the certificate cache.
	StateDir string
	// HTTPSPort and HTTPPort default to 443 and 80.
	HTTPSPort int
	HTTPPort  int
}

func (c HubConfig) validated() (HubConfig, error) {
	c.Domain = strings.ToLower(strings.TrimSpace(c.Domain))
	if c.Domain == "" {
		return c, fmt.Errorf("hub: domain is required")
	}
	if strings.ContainsAny(c.Domain, "/: ") {
		return c, fmt.Errorf("hub: domain %q must be a bare hostname, without scheme, port, or path", c.Domain)
	}
	if c.StateDir == "" {
		return c, fmt.Errorf("hub: state dir is required")
	}
	if c.HTTPSPort <= 0 {
		c.HTTPSPort = DefaultHTTPSPort
	}
	if c.HTTPPort <= 0 {
		c.HTTPPort = DefaultHTTPPort
	}
	if c.HTTPPort == c.HTTPSPort {
		return c, fmt.Errorf("hub: http and https ports must differ")
	}
	return c, nil
}

// Hub terminates TLS for one public hostname using Let's Encrypt.
//
// It runs two listeners: HTTPS for the console, and HTTP which serves ACME
// HTTP-01 challenges and redirects everything else. Both are required — the
// challenge port is how a certificate is obtained in the first place.
type Hub struct {
	cfg     HubConfig
	manager *autocert.Manager

	challengeLn  net.Listener
	challengeSrv *http.Server
}

// NewHub prepares the certificate manager. It does not bind anything yet and
// does not contact the ACME directory; the first certificate is requested
// lazily on the first TLS handshake.
func NewHub(cfg HubConfig) (*Hub, error) {
	cfg, err := cfg.validated()
	if err != nil {
		return nil, err
	}
	cacheDir := filepath.Join(cfg.StateDir, "autocert")
	if err := os.MkdirAll(cacheDir, 0o700); err != nil {
		return nil, fmt.Errorf("hub: certificate cache dir: %w", err)
	}
	manager := &autocert.Manager{
		Prompt: autocert.AcceptTOS,
		Cache:  autocert.DirCache(cacheDir),
		Email:  strings.TrimSpace(cfg.Email),
		// Pinning the host policy matters: without it, any hostname whose DNS
		// points at this IP could obtain a certificate through this Hub, and
		// burn Let's Encrypt's per-account rate limit doing it.
		HostPolicy: autocert.HostWhitelist(cfg.Domain),
	}
	return &Hub{cfg: cfg, manager: manager}, nil
}

// Name implements Transport.
func (h *Hub) Name() string { return "hub" }

// Domain returns the normalized hostname this Hub serves.
func (h *Hub) Domain() string { return h.cfg.Domain }

// URL returns the public console URL.
func (h *Hub) URL() string {
	if h.cfg.HTTPSPort == DefaultHTTPSPort {
		return "https://" + h.cfg.Domain
	}
	return fmt.Sprintf("https://%s:%d", h.cfg.Domain, h.cfg.HTTPSPort)
}

// TLSConfig returns the server TLS configuration. It is what enables HTTP/2:
// a plain listener wrapped by hand would negotiate HTTP/1.1 only.
func (h *Hub) TLSConfig() *tls.Config {
	cfg := h.manager.TLSConfig()
	// autocert's config already sets GetCertificate and NextProtos; the
	// explicit minimum keeps old clients from negotiating something weaker.
	cfg.MinVersion = tls.VersionTLS12
	return cfg
}

// Listen implements Transport, binding the public HTTPS port.
func (h *Hub) Listen(_ context.Context, _ Config) (net.Listener, error) {
	addr := fmt.Sprintf(":%d", h.cfg.HTTPSPort)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("hub: listen %s: %w", addr, err)
	}
	return ln, nil
}

// StartChallengeServer binds the HTTP port and serves ACME challenges,
// redirecting every other request to HTTPS.
//
// A failure here is reported but not fatal to the caller's judgement: with a
// certificate already cached, a Hub can serve HTTPS without ever using this
// port, and refusing to start would turn a missing port forward into an outage.
func (h *Hub) StartChallengeServer() error {
	addr := fmt.Sprintf(":%d", h.cfg.HTTPPort)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("hub: listen %s for ACME challenges: %w", addr, err)
	}
	h.challengeLn = ln
	h.challengeSrv = &http.Server{
		Handler:           h.manager.HTTPHandler(h.redirectToHTTPS()),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		if err := h.challengeSrv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			fmt.Fprintf(os.Stderr, "kin: hub ACME challenge server: %v\n", err)
		}
	}()
	return nil
}

// redirectToHTTPS sends non-challenge traffic to the canonical HTTPS URL.
func (h *Hub) redirectToHTTPS() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		target := h.URL() + r.URL.Path
		if r.URL.RawQuery != "" {
			target += "?" + r.URL.RawQuery
		}
		// 308 preserves the method and body, which matters if a client ever
		// posts to the plaintext port.
		http.Redirect(w, r, target, http.StatusPermanentRedirect)
	})
}

// Close shuts down the challenge listener.
func (h *Hub) Close() error {
	if h.challengeSrv == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return h.challengeSrv.Shutdown(ctx)
}

// acmeDirectoryURL exposes the configured ACME directory for diagnostics. It is
// unexported state today; kept here so tests can assert the default endpoint.
func (h *Hub) acmeDirectoryURL() string {
	if h.manager.Client == nil {
		return acme.LetsEncryptURL
	}
	return h.manager.Client.DirectoryURL
}
