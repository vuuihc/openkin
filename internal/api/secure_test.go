package api

import (
	"crypto/tls"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/vuuihc/openkin/internal/remote"
)

// The server the security middleware tests use: Handler() with the minimum
// fields a request actually touches. One shared instance per test is fine --
// the middleware holds no state.
func securityTestHandler(t *testing.T) http.Handler {
	t.Helper()
	s, _ := newTestServer(t)
	return s.Handler()
}

// T12: every answer carries the security headers, and HSTS only when the
// request arrived over TLS.
func TestSecurityHeaders(t *testing.T) {
	h := securityTestHandler(t)

	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/health", nil))
	for name, want := range map[string]string{
		"Content-Security-Policy": consoleCSP,
		"X-Content-Type-Options":  "nosniff",
		"Referrer-Policy":         "no-referrer",
		"X-Frame-Options":         "DENY",
	} {
		if got := rr.Header().Get(name); got != want {
			t.Errorf("%s = %q, want %q", name, got, want)
		}
	}
	if got := rr.Header().Get("Strict-Transport-Security"); got != "" {
		t.Errorf("HSTS sent over plaintext: %q", got)
	}

	rr = httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	req.TLS = &tls.ConnectionState{}
	h.ServeHTTP(rr, req)
	if got := rr.Header().Get("Strict-Transport-Security"); got == "" {
		t.Error("no HSTS over TLS")
	}
}

// T12: a state-changing request with another site's Origin is refused before
// its handler; the same request without an Origin (curl, the CLI) passes, and
// a same-origin one passes.
func TestCSRFGuard(t *testing.T) {
	h := securityTestHandler(t)

	cross := func(origin string) int {
		rr := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/auth/login", nil)
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		h.ServeHTTP(rr, req)
		return rr.Code
	}
	if got := cross("https://evil.example.com"); got != http.StatusForbidden {
		t.Errorf("cross-site POST: %d, want 403", got)
	}
	// Origin null (sandboxed iframe) is not "absent".
	if got := cross("null"); got != http.StatusForbidden {
		t.Errorf("null-origin POST: %d, want 403", got)
	}
	if got := cross(""); got == http.StatusForbidden {
		t.Error("Originless POST refused; curl and the CLI do not send one")
	}
	if got := cross("http://example.com"); got == http.StatusForbidden {
		t.Error("same-origin POST refused (httptest names example.com)")
	}
	// GET is never gated: consoles load links from other origins.
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	req.Header.Set("Origin", "https://evil.example.com")
	h.ServeHTTP(rr, req)
	if rr.Code == http.StatusForbidden {
		t.Error("cross-site GET refused; reads are not state changes")
	}
}

// T14: without TrustProxyHeaders, X-Forwarded-For does not move the address
// the limiter sees; with it, the forwarded address does. The assertion runs
// through remote.ClientIP, the one helper every per-caller decision reads --
// and, untrusted, the connection must win even though RealIP ran.
func TestTrustProxyHeaders(t *testing.T) {
	// The full peer-capture + trust-flag + RealIP chain, in the order
	// Handler() installs it.
	chain := func(trust bool) http.Handler {
		r := chi.NewRouter()
		r.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				ctx := remote.WithPeerAddr(req.Context(), req.RemoteAddr)
				if trust {
					ctx = remote.WithTrustedProxy(ctx)
				}
				next.ServeHTTP(w, req.WithContext(ctx))
			})
		})
		if trust {
			r.Use(middleware.RealIP)
		}
		r.Get("/", func(w http.ResponseWriter, req *http.Request) {
			_, _ = w.Write([]byte(remote.ClientIP(req)))
		})
		return r
	}

	call := func(h http.Handler) string {
		rr := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Header.Set("X-Forwarded-For", "203.0.113.9")
		h.ServeHTTP(rr, req)
		return rr.Body.String()
	}
	// httptest.NewRequest puts the peer at 192.0.2.1:1234. Untrusting, the
	// header must not move it; trusting, it must.
	if got := call(chain(false)); got != "192.0.2.1" {
		t.Errorf("untrusting: limiter saw %q, want the peer 192.0.2.1", got)
	}
	if got := call(chain(true)); got != "203.0.113.9" {
		t.Errorf("trusting: limiter saw %q, want the forwarded 203.0.113.9", got)
	}
}
