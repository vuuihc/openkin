package auth

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"
)

func TestIsTrueAcceptsOnlyBooleanTrue(t *testing.T) {
	// Providers differ on how they serialize this claim. Anything other than a
	// real boolean true must not be read as "verified".
	cases := []struct {
		name string
		in   any
		want bool
	}{
		{"bool true", true, true},
		{"bool false", false, false},
		{"nil", nil, false},
		{"string true", "true", false},
		{"string false", "false", false},
		{"number one", 1.0, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isTrue(tc.in); got != tc.want {
				t.Fatalf("isTrue(%#v) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}

func TestHostOf(t *testing.T) {
	cases := map[string]string{
		"https://kin.example.com":          "kin.example.com",
		"https://kin.example.com/dex":      "kin.example.com",
		"https://kin.example.com:8443/dex": "kin.example.com",
		"http://dex:5556/dex":              "dex",
		"https://kin.example.com/dex?x=1":  "kin.example.com",
		"kin.example.com":                  "kin.example.com",
		"kin.example.com:443":              "kin.example.com",
	}
	for in, want := range cases {
		if got := hostOf(in); got != want {
			t.Errorf("hostOf(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestOIDCProviderKeySeparatesIssuers(t *testing.T) {
	// Two issuers can mint the same subject value. Namespacing by issuer is
	// what keeps those from colliding into one identity.
	a := OIDCConfig{Issuer: "https://github.com"}
	b := OIDCConfig{Issuer: "https://gitlab.com"}
	if a.ProviderKey() == b.ProviderKey() {
		t.Fatal("different issuers produced the same provider key")
	}
	if got, want := a.ProviderKey(), "oidc:https://github.com"; got != want {
		t.Fatalf("ProviderKey() = %q, want %q", got, want)
	}
	trailingSlash := OIDCConfig{Issuer: "https://x.example.com/"}
	if got, want := trailingSlash.ProviderKey(), "oidc:https://x.example.com"; got != want {
		t.Fatalf("trailing slash not normalized: %q", got)
	}
}

func TestOIDCConfigValidate(t *testing.T) {
	cases := []struct {
		name string
		cfg  OIDCConfig
	}{
		{"missing issuer", OIDCConfig{ClientID: "c", RedirectURL: "https://x/cb"}},
		{"missing client id", OIDCConfig{Issuer: "https://x", RedirectURL: "https://x/cb"}},
		{"missing redirect", OIDCConfig{Issuer: "https://x", ClientID: "c"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.cfg.validate(); err == nil {
				t.Fatal("expected a validation error")
			}
		})
	}
}

func TestOIDCProviderLabelFallsBackToHost(t *testing.T) {
	if got := (OIDCConfig{Issuer: "https://accounts.google.com"}).ProviderLabel(); got != "accounts.google.com" {
		t.Fatalf("ProviderLabel() = %q", got)
	}
	if got := (OIDCConfig{Issuer: "https://x", DisplayName: "GitHub"}).ProviderLabel(); got != "GitHub" {
		t.Fatalf("display name not honored: %q", got)
	}
}

// newFakeIdP stands up a minimal OIDC provider that signs real ID tokens, so
// the test exercises discovery, code exchange, signature verification, and
// nonce checking rather than stubbing them out.
type fakeIdP struct {
	server   *httptest.Server
	key      *rsa.PrivateKey
	keyID    string
	clientID string
	// claims is merged into the ID token the token endpoint mints.
	claims map[string]any
	// nonce is echoed into the ID token. The nonce travels on the front
	// channel, so a test that skips the browser hop has to carry it across by
	// hand; see nonceFromAuthURL.
	nonce string
}

func newFakeIdP(t *testing.T, clientID string) *fakeIdP {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	idp := &fakeIdP{key: key, keyID: "test-key", clientID: clientID}

	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(t, w, map[string]any{
			"issuer":                                idp.server.URL,
			"authorization_endpoint":                idp.server.URL + "/auth",
			"token_endpoint":                        idp.server.URL + "/token",
			"jwks_uri":                              idp.server.URL + "/jwks",
			"id_token_signing_alg_values_supported": []string{"RS256"},
			"response_types_supported":              []string{"code"},
			"subject_types_supported":               []string{"public"},
		})
	})
	mux.HandleFunc("/jwks", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(t, w, map[string]any{"keys": []any{map[string]any{
			"kty": "RSA", "kid": idp.keyID, "use": "sig", "alg": "RS256",
			"n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()),
			"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes()),
		}}})
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		claims := map[string]any{
			"iss": idp.server.URL,
			"sub": "subject-1",
			"aud": idp.clientID,
			"exp": time.Now().Add(time.Hour).Unix(),
			"iat": time.Now().Unix(),
		}
		if idp.nonce != "" {
			claims["nonce"] = idp.nonce
		}
		for k, v := range idp.claims {
			claims[k] = v
		}
		token := idp.sign(t, claims)
		writeJSON(t, w, map[string]any{
			"access_token": "access-token", "token_type": "Bearer",
			"id_token": token, "expires_in": 3600,
		})
	})

	idp.server = httptest.NewServer(mux)
	t.Cleanup(idp.server.Close)
	return idp
}

func (f *fakeIdP) sign(t *testing.T, claims map[string]any) string {
	t.Helper()
	signer, err := jose.NewSigner(
		jose.SigningKey{Algorithm: jose.RS256, Key: jose.JSONWebKey{Key: f.key, KeyID: f.keyID}},
		(&jose.SignerOptions{}).WithType("JWT"),
	)
	if err != nil {
		t.Fatalf("new signer: %v", err)
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("marshal claims: %v", err)
	}
	obj, err := signer.Sign(payload)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	serialized, err := obj.CompactSerialize()
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}
	return serialized
}

func writeJSON(t *testing.T, w http.ResponseWriter, v any) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		t.Errorf("encode response: %v", err)
	}
}

func newTestOIDCProvider(t *testing.T, idp *fakeIdP) *OIDCProvider {
	t.Helper()
	provider, err := NewOIDCProvider(context.Background(), OIDCConfig{
		Issuer:       idp.server.URL,
		ClientID:     idp.clientID,
		ClientSecret: "secret",
		RedirectURL:  "https://kin.example.com/api/auth/oidc/callback",
	})
	if err != nil {
		t.Fatalf("new oidc provider: %v", err)
	}
	return provider
}

func TestOIDCFlowReturnsVerifiedIdentity(t *testing.T) {
	idp := newFakeIdP(t, "kin-client")
	idp.claims = map[string]any{
		"email":          "Owner@Example.com",
		"email_verified": true,
		"name":           "The Owner",
	}
	provider := newTestOIDCProvider(t, idp)

	state := beginFlow(t, idp, provider, "", "/sessions")

	ident, req, err := provider.Complete(context.Background(), state, "auth-code")
	if err != nil {
		t.Fatalf("complete: %v", err)
	}
	if ident.Subject != "subject-1" {
		t.Fatalf("subject = %q", ident.Subject)
	}
	if ident.Email != "owner@example.com" {
		t.Fatalf("email = %q, want normalized", ident.Email)
	}
	if !ident.EmailVerified {
		t.Fatal("email_verified=true was not carried through")
	}
	if ident.DisplayName != "The Owner" {
		t.Fatalf("display name = %q", ident.DisplayName)
	}
	if ident.Provider != "oidc:"+idp.server.URL {
		t.Fatalf("provider = %q", ident.Provider)
	}
	if req.ReturnTo() != "/sessions" {
		t.Fatalf("returnTo = %q", req.ReturnTo())
	}
}

func TestOIDCFlowRejectsReplayedState(t *testing.T) {
	idp := newFakeIdP(t, "kin-client")
	provider := newTestOIDCProvider(t, idp)

	state := beginFlow(t, idp, provider, "", "")
	if _, _, err := provider.Complete(context.Background(), state, "auth-code"); err != nil {
		t.Fatalf("first complete: %v", err)
	}
	if _, _, err := provider.Complete(context.Background(), state, "auth-code"); err == nil {
		t.Fatal("a replayed state was accepted; authorization codes must be single-use")
	}
}

func TestOIDCFlowRejectsUnknownState(t *testing.T) {
	idp := newFakeIdP(t, "kin-client")
	provider := newTestOIDCProvider(t, idp)
	if _, _, err := provider.Complete(context.Background(), "never-issued", "code"); err == nil {
		t.Fatal("an unknown state was accepted")
	}
}

func TestOIDCFlowRejectsMismatchedNonce(t *testing.T) {
	idp := newFakeIdP(t, "kin-client")
	provider := newTestOIDCProvider(t, idp)

	state := beginFlow(t, idp, provider, "", "")
	// The provider mints a token for a different flow's nonce.
	idp.nonce = "some-other-nonce"

	if _, _, err := provider.Complete(context.Background(), state, "auth-code"); err == nil {
		t.Fatal("an ID token with a foreign nonce was accepted")
	}
}

func TestOIDCFlowTreatsMissingEmailVerifiedAsUnverified(t *testing.T) {
	idp := newFakeIdP(t, "kin-client")
	// GitHub-style: an address is present but nothing vouches for it.
	idp.claims = map[string]any{"email": "owner@example.com"}
	provider := newTestOIDCProvider(t, idp)

	state := beginFlow(t, idp, provider, "", "")
	ident, _, err := provider.Complete(context.Background(), state, "auth-code")
	if err != nil {
		t.Fatalf("complete: %v", err)
	}
	if ident.EmailVerified {
		t.Fatal("an absent email_verified claim was read as verified")
	}
}

func TestOIDCBeginCarriesBindUser(t *testing.T) {
	idp := newFakeIdP(t, "kin-client")
	provider := newTestOIDCProvider(t, idp)

	state := beginFlow(t, idp, provider, "01USER", "/settings")
	_, req, err := provider.Complete(context.Background(), state, "code")
	if err != nil {
		t.Fatalf("complete: %v", err)
	}
	if req.BindUserID() != "01USER" {
		t.Fatalf("bindUserID = %q, want 01USER", req.BindUserID())
	}
}

func TestOIDCExpiredAuthRequestIsRejected(t *testing.T) {
	idp := newFakeIdP(t, "kin-client")
	provider := newTestOIDCProvider(t, idp)

	state := beginFlow(t, idp, provider, "", "")

	provider.mu.Lock()
	req := provider.pending[state]
	req.expiresAt = time.Now().Add(-time.Second)
	provider.pending[state] = req
	provider.mu.Unlock()

	if _, _, err := provider.Complete(context.Background(), state, "code"); err == nil {
		t.Fatal("an expired authorization request was accepted")
	}
}

func TestOIDCBeginCapsPendingRequests(t *testing.T) {
	idp := newFakeIdP(t, "kin-client")
	provider := newTestOIDCProvider(t, idp)

	for i := 0; i < maxPendingAuthRequests; i++ {
		if _, err := provider.Begin("", ""); err != nil {
			t.Fatalf("begin %d: %v", i, err)
		}
	}
	if _, err := provider.Begin("", ""); err == nil {
		t.Fatal("pending authorization requests are unbounded; an unauthenticated caller can grow memory")
	}
}

func TestBackchannelClientRedirectsOnlyTheIssuerHost(t *testing.T) {
	var issuerHits, otherHits int
	issuerSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		issuerHits++
		if got := r.Host; got != issuerHost {
			t.Errorf("backchannel request carried Host %q, want %q", got, issuerHost)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer issuerSrv.Close()
	otherSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		otherHits++
		w.WriteHeader(http.StatusOK)
	}))
	defer otherSrv.Close()

	// Kin's own public hostname deliberately does not resolve from inside the
	// container in this test, which is the situation the backchannel exists for.
	client := backchannelClient("http://"+issuerHost, strings.TrimPrefix(issuerSrv.URL, "http://"))

	resp, err := client.Get("http://" + issuerHost + "/.well-known/openid-configuration")
	if err != nil {
		t.Fatalf("request through backchannel: %v", err)
	}
	_ = resp.Body.Close()
	if issuerHits != 1 {
		t.Fatalf("issuer hits = %d, want 1", issuerHits)
	}

	// An unrelated host must resolve normally rather than be rewritten.
	resp, err = client.Get(otherSrv.URL)
	if err != nil {
		t.Fatalf("request to unrelated host: %v", err)
	}
	_ = resp.Body.Close()
	if otherHits != 1 {
		t.Fatalf("unrelated host hits = %d, want 1", otherHits)
	}
}

// beginFlow starts an authorization flow and copies the front-channel nonce
// into the fake IdP, standing in for the browser hop this test skips.
func beginFlow(t *testing.T, idp *fakeIdP, provider *OIDCProvider, bindUserID, returnTo string) string {
	t.Helper()
	authURL, err := provider.Begin(bindUserID, returnTo)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	parsed, err := url.Parse(authURL)
	if err != nil {
		t.Fatalf("parse auth url: %v", err)
	}
	idp.nonce = parsed.Query().Get("nonce")
	if idp.nonce == "" {
		t.Fatal("authorization URL carries no nonce")
	}
	state := parsed.Query().Get("state")
	if state == "" {
		t.Fatal("authorization URL carries no state")
	}
	return state
}

// issuerHost is the Hub's own public hostname, which does not resolve inside
// the test container's network namespace.
const issuerHost = "kin.invalid"
