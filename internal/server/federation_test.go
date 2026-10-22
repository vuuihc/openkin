package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/vuuihc/openkin/internal/remote"
)

func testHub(t *testing.T, domain string) *remote.Hub {
	t.Helper()
	hub, err := remote.NewHub(remote.HubConfig{Domain: domain, StateDir: t.TempDir()})
	if err != nil {
		t.Fatalf("new hub: %v", err)
	}
	t.Cleanup(func() { _ = hub.Close() })
	return hub
}

func TestFederationProxySkippedWithoutBackchannel(t *testing.T) {
	// Without a backchannel address there is nothing for Kin to forward to, and
	// proxying would only add a hop that cannot resolve.
	proxy, err := newFederationProxy(testHub(t, "kin.example.com"), "https://kin.example.com/dex", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if proxy != nil {
		t.Fatal("a proxy was built with no upstream configured")
	}
}

func TestFederationProxySkippedForForeignOrigin(t *testing.T) {
	// A provider on its own origin is reached directly. Proxying it would be
	// both pointless and surprising.
	proxy, err := newFederationProxy(testHub(t, "kin.example.com"), "https://accounts.google.com", "dex:5556")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if proxy != nil {
		t.Fatal("a foreign-origin provider was proxied")
	}
}

func TestFederationProxyRejectsRootPath(t *testing.T) {
	// Publishing a provider at the site root would shadow the console.
	_, err := newFederationProxy(testHub(t, "kin.example.com"), "https://kin.example.com", "dex:5556")
	if err == nil {
		t.Fatal("a provider at the hub's root path was accepted")
	}
}

func TestFederationProxyMountsIssuerPathPrefix(t *testing.T) {
	proxy, err := newFederationProxy(testHub(t, "kin.example.com"), "https://kin.example.com/dex", "dex:5556")
	if err != nil {
		t.Fatalf("new proxy: %v", err)
	}
	if proxy == nil {
		t.Fatal("no proxy built for a same-origin provider")
	}
	if got := proxy.Prefix(); got != "/dex" {
		t.Fatalf("prefix = %q, want /dex", got)
	}
}

func TestFederationProxyForwardsRequestsAndRewritesHost(t *testing.T) {
	var gotPath, gotHost string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotHost = r.Host
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"issuer":"https://kin.example.com/dex"}`))
	}))
	defer upstream.Close()

	proxy, err := newFederationProxy(testHub(t, "kin.example.com"), "https://kin.example.com/dex",
		strings.TrimPrefix(upstream.URL, "http://"))
	if err != nil {
		t.Fatalf("new proxy: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "https://kin.example.com/dex/.well-known/openid-configuration", nil)
	rec := httptest.NewRecorder()
	proxy.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	// The issuer's own path prefix must be preserved: Dex serves discovery
	// under /dex, not at the root.
	if gotPath != "/dex/.well-known/openid-configuration" {
		t.Fatalf("upstream path = %q", gotPath)
	}
	if gotHost != "kin.example.com" {
		t.Fatalf("upstream Host = %q, want the public host so the provider builds correct URLs", gotHost)
	}
}

// TestFederationProxyStripsCredentials is the security-relevant assertion. The
// session cookie is scoped to "/", so the browser sends it to the provider's
// paths too. Forwarding it would hand Kin's own credential to a third party.
func TestFederationProxyStripsCredentials(t *testing.T) {
	var gotCookie, gotAuth string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotCookie = r.Header.Get("Cookie")
		gotAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	proxy, err := newFederationProxy(testHub(t, "kin.example.com"), "https://kin.example.com/dex",
		strings.TrimPrefix(upstream.URL, "http://"))
	if err != nil {
		t.Fatalf("new proxy: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "https://kin.example.com/dex/auth", nil)
	req.Header.Set("Cookie", remote.SessionCookieName+"=super-secret-session")
	req.Header.Set("Authorization", "Bearer super-secret-token")
	proxy.ServeHTTP(httptest.NewRecorder(), req)

	if gotCookie != "" {
		t.Fatalf("session cookie was forwarded to the identity provider: %q", gotCookie)
	}
	if gotAuth != "" {
		t.Fatalf("authorization header was forwarded to the identity provider: %q", gotAuth)
	}
}

func TestFederationProxyKeepsProviderCookiesButNotKinSession(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.SetCookie(w, &http.Cookie{Name: "dex_session", Value: "provider-state", Path: "/dex"})
		http.SetCookie(w, &http.Cookie{Name: remote.SessionCookieName, Value: "forged", Path: "/"})
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	proxy, err := newFederationProxy(testHub(t, "kin.example.com"), "https://kin.example.com/dex",
		strings.TrimPrefix(upstream.URL, "http://"))
	if err != nil {
		t.Fatalf("new proxy: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "https://kin.example.com/dex/auth", nil)
	rec := httptest.NewRecorder()
	proxy.ServeHTTP(rec, req)

	for _, cookie := range rec.Result().Cookies() {
		if cookie.Name == remote.SessionCookieName {
			t.Fatal("the identity provider was allowed to set a cookie named " + remote.SessionCookieName)
		}
	}
	// The provider's own session cookie has to survive, or its login flow
	// cannot work at all.
	found := false
	for _, cookie := range rec.Result().Cookies() {
		if cookie.Name == "dex_session" {
			found = true
		}
	}
	if !found {
		t.Fatal("the provider's own session cookie was stripped along with Kin's")
	}
}

func TestFederationProxyReportsUnreachableUpstream(t *testing.T) {
	// A configured-but-down provider must produce a clear 502 rather than a
	// hang or a panic, because this path is hit during sign-in.
	proxy, err := newFederationProxy(testHub(t, "kin.example.com"), "https://kin.example.com/dex", "127.0.0.1:1")
	if err != nil {
		t.Fatalf("new proxy: %v", err)
	}
	req := httptest.NewRequest(http.MethodGet, "https://kin.example.com/dex/auth", nil)
	rec := httptest.NewRecorder()
	proxy.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", rec.Code)
	}
}

func TestFederationProxyRejectsNonHostPortBackchannel(t *testing.T) {
	_, err := newFederationProxy(testHub(t, "kin.example.com"), "https://kin.example.com/dex", "http://dex:5556")
	if err == nil {
		t.Fatal("a backchannel address carrying a scheme was accepted")
	}
}
