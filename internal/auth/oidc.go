package auth

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"net"
	"net/http"
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
	// BackchannelAddr, when set, is a host:port that replaces the issuer host
	// for outbound token and discovery requests. This exists because a Hub in a
	// container usually cannot resolve its own public hostname back to itself:
	// OIDC requires the issuer string to match, but the network path may not.
	// TLS verification still uses the issuer hostname, so this cannot be used
	// to redirect a flow to a different certificate.
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
	expiresAt  time.Time
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
func (p *OIDCProvider) Begin(bindUserID, returnTo string) (string, error) {
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
		expiresAt:  now.Add(authRequestTTL),
	}
	p.mu.Unlock()

	return p.oauth.AuthCodeURL(state,
		oidc.Nonce(nonce),
		oauth2.S256ChallengeOption(verifier),
	), nil
}

// Complete exchanges the callback code, verifies the ID token, and returns the
// asserted identity along with the flow metadata recorded at Begin.
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
		return ExternalIdentity{}, pendingAuth{}, fmt.Errorf("auth: exchange authorization code: %w", err)
	}
	rawID, ok := token.Extra("id_token").(string)
	if !ok || rawID == "" {
		return ExternalIdentity{}, pendingAuth{}, fmt.Errorf("auth: provider returned no id_token")
	}
	idToken, err := p.verifier.Verify(ctx, rawID)
	if err != nil {
		return ExternalIdentity{}, pendingAuth{}, fmt.Errorf("auth: verify id_token: %w", err)
	}
	if idToken.Nonce != req.nonce {
		// A mismatched nonce means the token was not minted for this flow.
		return ExternalIdentity{}, pendingAuth{}, fmt.Errorf("auth: id_token nonce does not match the request")
	}

	var claims struct {
		Email             string `json:"email"`
		EmailVerified     any    `json:"email_verified"`
		Name              string `json:"name"`
		PreferredUsername string `json:"preferred_username"`
	}
	if err := idToken.Claims(&claims); err != nil {
		return ExternalIdentity{}, pendingAuth{}, fmt.Errorf("auth: decode id_token claims: %w", err)
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

// backchannelClient returns an HTTP client that dials addr whenever the request
// targets issuerHost. TLS ServerName and certificate verification still use
// issuerHost, so this only changes the network path, not who we trust.
func backchannelClient(issuer, addr string) *http.Client {
	issuerHost := hostOf(issuer)
	return &http.Client{
		Timeout: 30 * time.Second,
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
				if issuerHost != "" && strings.EqualFold(hostOf(address), issuerHost) {
					address = addr
				}
				var dialer net.Dialer
				return dialer.DialContext(ctx, network, address)
			},
			ForceAttemptHTTP2: true,
		},
	}
}

func hostOf(rawURL string) string {
	trimmed := rawURL
	if i := strings.Index(trimmed, "://"); i >= 0 {
		trimmed = trimmed[i+3:]
	}
	if i := strings.IndexAny(trimmed, "/?#"); i >= 0 {
		trimmed = trimmed[:i]
	}
	host, _, err := net.SplitHostPort(trimmed)
	if err != nil {
		return trimmed
	}
	return host
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
