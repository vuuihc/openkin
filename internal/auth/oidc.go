package auth

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

// ProviderOIDCPrefix namespaces federated identities in user_identities. The
// issuer is part of the provider key so that two different IdPs can never
// produce a colliding subject.
const ProviderOIDCPrefix = "oidc:"

// authRequestTTL bounds how long a started authorization flow stays valid.
const authRequestTTL = 10 * time.Minute

// maxPendingAuthRequests caps in-flight flows so an unauthenticated caller
// cannot grow memory by repeatedly hitting the start endpoint.
const maxPendingAuthRequests = 512

// OIDCConfig describes one configured identity provider. Kin implements exactly
// one federation protocol; adding Google, GitLab, or GitHub is a configuration
// change on the provider side, not new code here.
type OIDCConfig struct {
	// Issuer is the provider's issuer URL. It is used verbatim as the OIDC
	// `issuer` and must match discovery exactly, so it is the public URL even
	// when BackchannelAddr points somewhere else.
	Issuer       string
	ClientID     string
	ClientSecret string
	RedirectURL  string
	Scopes       []string
	// DisplayName is shown on the login button. Falls back to the issuer host.
	DisplayName string
	// BackchannelAddr, when set, is a host:port that outbound discovery and
	// token requests are sent to over plain HTTP instead of the public issuer
	// URL. This exists because a Hub in a container usually cannot resolve its
	// own public hostname back to itself: OIDC requires the issuer string to
	// match, but the network path may not.
	//
	// The hop is unencrypted by design — a sidecar provider on the Compose
	// network serves HTTP on an internal port while the public issuer is HTTPS.
	// The client secret and authorization codes cross it, so it must only name
	// an address on a network the operator trusts (the Compose bridge, not a
	// public host).
	BackchannelAddr string
}

// ProviderKey returns the user_identities.provider value for this issuer.
func (c OIDCConfig) ProviderKey() string {
	return ProviderOIDCPrefix + strings.TrimSuffix(strings.TrimSpace(c.Issuer), "/")
}

// ProviderLabel returns the human-facing name for this provider.
func (c OIDCConfig) ProviderLabel() string {
	if name := strings.TrimSpace(c.DisplayName); name != "" {
		return name
	}
	return strings.TrimSuffix(strings.TrimPrefix(strings.TrimPrefix(c.Issuer, "https://"), "http://"), "/")
}

func (c OIDCConfig) validate() error {
	if strings.TrimSpace(c.Issuer) == "" {
		return fmt.Errorf("auth: oidc issuer is required")
	}
	if strings.TrimSpace(c.ClientID) == "" {
		return fmt.Errorf("auth: oidc client id is required")
	}
	if strings.TrimSpace(c.RedirectURL) == "" {
		return fmt.Errorf("auth: oidc redirect url is required")
	}
	// The backchannel address is a dial target, not a URL. A scheme or a path
	// here produces an opaque request error during discovery, which reads as a
	// provider outage; reject the shape while the operator can still see the
	// value they typed.
	if addr := strings.TrimSpace(c.BackchannelAddr); addr != "" {
		if strings.Contains(addr, "://") || strings.ContainsAny(addr, "/?#") {
			return fmt.Errorf("auth: oidc backchannel address must be host:port, got %q", addr)
		}
		host, port, err := net.SplitHostPort(addr)
		if err != nil || host == "" {
			return fmt.Errorf("auth: oidc backchannel address must be host:port, got %q", addr)
		}
		// A service name would depend on the container's /etc/services; the
		// address is a dial target the operator writes, so require the number
		// they will also see in the Compose file.
		if _, err := strconv.Atoi(port); err != nil {
			return fmt.Errorf("auth: oidc backchannel address must be host:port, got %q", addr)
		}
	}
	return nil
}

// OIDCProvider is a discovered, ready-to-use identity provider.
type OIDCProvider struct {
	cfg      OIDCConfig
	provider *oidc.Provider
	verifier *oidc.IDTokenVerifier
	oauth    *oauth2.Config

	mu      sync.Mutex
	pending map[string]pendingAuth
}

type pendingAuth struct {
	nonce      string
	verifier   string
	returnTo   string
	bindUserID string
	// deviceKey, when non-empty, marks a flow started by the native app (G9).
	// It is recorded here rather than carried on the provider URL: the browser
	// hop is untrusted middle ground, and a key that merely travels through it
	// says nothing about who started the flow. The app proves possession of the
	// key later, when it spends the code the callback minted.
	deviceKey string
	expiresAt time.Time
}

// NewOIDCProvider performs discovery and returns a ready provider.
func NewOIDCProvider(ctx context.Context, cfg OIDCConfig) (*OIDCProvider, error) {
	if err := cfg.validate(); err != nil {
		return nil, err
	}
	discoveryCtx := ctx
	if cfg.BackchannelAddr != "" {
		discoveryCtx = oidc.ClientContext(ctx, backchannelClient(cfg.Issuer, cfg.BackchannelAddr))
	}
	provider, err := oidc.NewProvider(discoveryCtx, cfg.Issuer)
	if err != nil {
		return nil, fmt.Errorf("auth: oidc discovery for %s: %w", cfg.Issuer, err)
	}
	scopes := cfg.Scopes
	if len(scopes) == 0 {
		scopes = []string{oidc.ScopeOpenID, "profile", "email"}
	}
	return &OIDCProvider{
		cfg:      cfg,
		provider: provider,
		verifier: provider.Verifier(&oidc.Config{ClientID: cfg.ClientID}),
		oauth: &oauth2.Config{
			ClientID:     cfg.ClientID,
			ClientSecret: cfg.ClientSecret,
			Endpoint:     provider.Endpoint(),
			RedirectURL:  cfg.RedirectURL,
			Scopes:       scopes,
		},
		pending: make(map[string]pendingAuth),
	}, nil
}

// Config returns the provider's configuration.
func (p *OIDCProvider) Config() OIDCConfig { return p.cfg }

// Begin starts an authorization flow and returns the URL to send the browser
// to. bindUserID is non-empty for a link flow started from a live session; the
// callback then attaches the identity instead of opening a new session.
// deviceKey is non-empty for a flow started by the native app (G9): the
// callback then routes back to the app instead of opening a browser session.
func (p *OIDCProvider) Begin(bindUserID, returnTo, deviceKey string) (string, error) {
	state, err := randomURLSafe(32)
	if err != nil {
		return "", err
	}
	nonce, err := randomURLSafe(32)
	if err != nil {
		return "", err
	}
	verifier := oauth2.GenerateVerifier()

	now := time.Now()
	p.mu.Lock()
	p.pruneLocked(now)
	if len(p.pending) >= maxPendingAuthRequests {
		p.mu.Unlock()
		return "", fmt.Errorf("auth: too many pending authorization requests")
	}
	p.pending[state] = pendingAuth{
		nonce:      nonce,
		verifier:   verifier,
		returnTo:   returnTo,
		bindUserID: bindUserID,
		deviceKey:  deviceKey,
		expiresAt:  now.Add(authRequestTTL),
	}
	p.mu.Unlock()

	return p.oauth.AuthCodeURL(state,
		oidc.Nonce(nonce),
		oauth2.S256ChallengeOption(verifier),
	), nil
}

// Complete exchanges the callback code, verifies the ID token, and returns the
// asserted identity along with the flow metadata recorded at Begin. On failure
// it still returns the flow metadata when the state was known, so the caller
// can route the failure to the surface (app or browser) that started the flow;
// with an unknown, expired, or replayed state the returned pendingAuth is zero.
func (p *OIDCProvider) Complete(ctx context.Context, state, code string) (ExternalIdentity, pendingAuth, error) {
	req, ok := p.take(state)
	if !ok {
		return ExternalIdentity{}, pendingAuth{}, fmt.Errorf("auth: unknown or expired authorization state")
	}
	if p.cfg.BackchannelAddr != "" {
		ctx = oidc.ClientContext(ctx, backchannelClient(p.cfg.Issuer, p.cfg.BackchannelAddr))
	}
	token, err := p.oauth.Exchange(ctx, code, oauth2.VerifierOption(req.verifier))
	if err != nil {
		return ExternalIdentity{}, req, fmt.Errorf("auth: exchange authorization code: %w", err)
	}
	rawID, ok := token.Extra("id_token").(string)
	if !ok || rawID == "" {
		return ExternalIdentity{}, req, fmt.Errorf("auth: provider returned no id_token")
	}
	idToken, err := p.verifier.Verify(ctx, rawID)
	if err != nil {
		return ExternalIdentity{}, req, fmt.Errorf("auth: verify id_token: %w", err)
	}
	if idToken.Nonce != req.nonce {
		// A mismatched nonce means the token was not minted for this flow.
		return ExternalIdentity{}, req, fmt.Errorf("auth: id_token nonce does not match the request")
	}

	var claims struct {
		Email             string `json:"email"`
		EmailVerified     any    `json:"email_verified"`
		Name              string `json:"name"`
		PreferredUsername string `json:"preferred_username"`
	}
	if err := idToken.Claims(&claims); err != nil {
		return ExternalIdentity{}, req, fmt.Errorf("auth: decode id_token claims: %w", err)
	}

	displayName := strings.TrimSpace(claims.Name)
	if displayName == "" {
		displayName = strings.TrimSpace(claims.PreferredUsername)
	}
	return ExternalIdentity{
		Provider: p.cfg.ProviderKey(),
		Subject:  idToken.Subject,
		Email:    NormalizeEmail(claims.Email),
		// Only the exact JSON boolean true counts. Providers differ on whether
		// they omit, null, or stringify this claim, and treating "present" as
		// "verified" is how an unverified address gets trusted.
		EmailVerified: isTrue(claims.EmailVerified),
		DisplayName:   displayName,
		Label:         p.cfg.ProviderLabel(),
	}, req, nil
}

// take removes and returns a pending flow, rejecting expired entries.
func (p *OIDCProvider) take(state string) (pendingAuth, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	req, ok := p.pending[state]
	if !ok {
		return pendingAuth{}, false
	}
	delete(p.pending, state)
	if time.Now().After(req.expiresAt) {
		return pendingAuth{}, false
	}
	return req, true
}

func (p *OIDCProvider) pruneLocked(now time.Time) {
	for state, req := range p.pending {
		if now.After(req.expiresAt) {
			delete(p.pending, state)
		}
	}
}

// returnToFrom exposes the recorded post-login target to the callback.
func (r pendingAuth) ReturnTo() string   { return r.returnTo }
func (r pendingAuth) BindUserID() string { return r.bindUserID }
func (r pendingAuth) DeviceKey() string  { return r.deviceKey }

// Abort takes a pending flow out of play without completing it — the callback's
// provider-error branch. It returns the recorded flow metadata so the caller can
// still route the failure to whichever surface (app or browser) started it;
// after a mismatched or replayed state it returns an empty pendingAuth, and the
// caller treats the failure as coming from nowhere.
func (p *OIDCProvider) Abort(state string) pendingAuth {
	req, _ := p.take(state)
	return req
}

// backchannelClient returns an HTTP client that sends every request for the
// issuer's origin to addr over plain HTTP.
//
// A sidecar provider on the Compose network serves HTTP on an internal port
// while the public issuer is HTTPS. Discovery and token requests are built from
// the issuer string, so the URL has to stay public for the protocol's own
// checks; rewriting the scheme and host is what lets one URL be true for the
// browser and reachable for Kin.
func backchannelClient(issuer, addr string) *http.Client {
	issuerURL, err := url.Parse(strings.TrimSpace(issuer))
	if err != nil || issuerURL.Host == "" {
		return &http.Client{Timeout: 30 * time.Second}
	}
	return &http.Client{
		Timeout: 30 * time.Second,
		Transport: &backchannelTransport{
			issuerHost: issuerURL.Host,
			addr:       strings.TrimSpace(addr),
			base:       &http.Transport{ForceAttemptHTTP2: true},
		},
	}
}

// backchannelTransport rewrites requests addressed to the public issuer origin
// onto the private plain-HTTP address, leaving every other host alone.
type backchannelTransport struct {
	issuerHost string
	addr       string
	base       http.RoundTripper
}

func (t *backchannelTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if !strings.EqualFold(req.URL.Host, t.issuerHost) {
		return t.base.RoundTrip(req)
	}
	out := req.Clone(req.Context())
	out.URL.Scheme = "http"
	out.URL.Host = t.addr
	// The provider builds absolute URLs — its own issuer, its callback paths —
	// from the Host it sees. Those must be the public ones, not dex:5556.
	out.Host = t.issuerHost
	return t.base.RoundTrip(out)
}

func randomURLSafe(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("auth: read randomness: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// isTrue accepts only the JSON boolean true. Some providers serialize booleans
// as strings; those are deliberately not treated as verified.
func isTrue(v any) bool {
	b, ok := v.(bool)
	return ok && b
}
