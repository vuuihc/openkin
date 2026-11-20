package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The two origins a Capacitor app serves its bundled console from: the iOS
// WKWebView scheme and the Android WebView's loopback origin. They are platform
// constants, not properties of any one machine.
const (
	bundledIOSOrigin     = "capacitor://localhost"
	bundledAndroidOrigin = "http://localhost"
)

// corsCall drives one request through the real middleware chain (Handler()).
func corsCall(h http.Handler, method, target, origin string, headers map[string]string) *httptest.ResponseRecorder {
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(method, target, nil)
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	for name, value := range headers {
		req.Header.Set(name, value)
	}
	h.ServeHTTP(rr, req)
	return rr
}

func varyContains(values []string, want string) bool {
	for _, value := range values {
		for _, part := range strings.Split(value, ",") {
			if strings.EqualFold(strings.TrimSpace(part), want) {
				return true
			}
		}
	}
	return false
}

// R-continue-006-cors: the bundled console's two origins may read the Hub's
// own console set and /api/version, so the answer names that origin -- never
// a wildcard -- and varies on Origin so no cache serves it to another site.
func TestBundledConsoleOriginGetsCORSOnReads(t *testing.T) {
	h := securityTestHandler(t)
	for _, origin := range []string{bundledIOSOrigin, bundledAndroidOrigin} {
		for _, method := range []string{http.MethodGet, http.MethodHead} {
			rr := corsCall(h, method, "/api/version", origin, nil)
			// chi registers GET only; the middleware still stamps the grant on
			// a HEAD, but the route itself answers 405. The grant is what this
			// test owns, so only GET has its status pinned.
			if method == http.MethodGet && rr.Code != http.StatusOK {
				t.Errorf("%s %s: status %d, want 200", method, origin, rr.Code)
			}
			if got := rr.Header().Get("Access-Control-Allow-Origin"); got != origin {
				t.Errorf("%s %s: Access-Control-Allow-Origin = %q, want %q", method, origin, got, origin)
			}
			if !varyContains(rr.Header().Values("Vary"), "Origin") {
				t.Errorf("%s %s: Vary = %q, want it to contain Origin", method, origin, rr.Header().Values("Vary"))
			}
		}
	}

	// The comparison is case-insensitive on scheme and host; the answer names
	// the canonical platform constant rather than echoing the request's casing.
	rr := corsCall(h, http.MethodGet, "/api/version", "CAPACITOR://LOCALHOST", nil)
	if got := rr.Header().Get("Access-Control-Allow-Origin"); got != bundledIOSOrigin {
		t.Errorf("uppercase origin: Access-Control-Allow-Origin = %q, want %q", got, bundledIOSOrigin)
	}
}

// An origin that is not one of the two exact platform origins gets no CORS
// header at all -- including a port on localhost, a suffix lookalike, and the
// http(s) loopback a page on this machine would otherwise have.
func TestUnknownOriginGetsNoCORS(t *testing.T) {
	h := securityTestHandler(t)
	for _, origin := range []string{
		"https://evil.example",
		"http://localhost:3000",
		"capacitor://localhost.evil.example",
		"https://localhost",
		"http://127.0.0.1",
		"null",
	} {
		for _, method := range []string{http.MethodGet, http.MethodHead} {
			rr := corsCall(h, method, "/api/version", origin, nil)
			if got := rr.Header().Get("Access-Control-Allow-Origin"); got != "" {
				t.Errorf("%s %s: Access-Control-Allow-Origin = %q, want none", method, origin, got)
			}
		}
	}
}

// A preflight is answered only for the two read methods. A preflight naming a
// state-changing method gets no allow headers at all, so the browser refuses
// the real request before it is sent.
func TestPreflightAllowsOnlyReads(t *testing.T) {
	h := securityTestHandler(t)
	for _, origin := range []string{bundledIOSOrigin, bundledAndroidOrigin} {
		for _, method := range []string{http.MethodGet, http.MethodHead} {
			rr := corsCall(h, http.MethodOptions, "/api/version", origin, map[string]string{
				"Access-Control-Request-Method":  method,
				"Access-Control-Request-Headers": "authorization",
			})
			if rr.Code != http.StatusNoContent {
				t.Errorf("%s preflight %s: status %d, want 204", method, origin, rr.Code)
			}
			if rr.Body.Len() != 0 {
				t.Errorf("%s preflight %s: body %q, want empty", method, origin, rr.Body.String())
			}
			for name, want := range map[string]string{
				"Access-Control-Allow-Origin":  origin,
				"Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
				"Access-Control-Allow-Headers": "Authorization",
				"Access-Control-Max-Age":       "600",
			} {
				if got := rr.Header().Get(name); got != want {
					t.Errorf("%s preflight %s: %s = %q, want %q", method, origin, name, got, want)
				}
			}
		}

		for _, method := range []string{
			http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete,
		} {
			rr := corsCall(h, http.MethodOptions, "/api/version", origin, map[string]string{
				"Access-Control-Request-Method": method,
			})
			for _, name := range []string{
				"Access-Control-Allow-Origin",
				"Access-Control-Allow-Methods",
				"Access-Control-Allow-Headers",
				"Access-Control-Max-Age",
			} {
				if got := rr.Header().Get(name); got != "" {
					t.Errorf("%s preflight from %s: %s = %q, want none", method, origin, name, got)
				}
			}
		}
	}

	// A preflight from an unlisted origin is not answered either.
	rr := corsCall(h, http.MethodOptions, "/api/version", "https://evil.example", map[string]string{
		"Access-Control-Request-Method": http.MethodGet,
	})
	if got := rr.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("unlisted preflight: Access-Control-Allow-Origin = %q, want none", got)
	}
}

// Cookies are not part of this path: no answer may carry the credentials grant,
// and no answer may name a wildcard origin.
func TestCORSNeverGrantsCredentials(t *testing.T) {
	h := securityTestHandler(t)
	origins := []string{bundledIOSOrigin, bundledAndroidOrigin, "https://evil.example", ""}
	type call struct {
		method  string
		headers map[string]string
	}
	calls := []call{
		{http.MethodGet, nil},
		{http.MethodHead, nil},
		{http.MethodOptions, map[string]string{"Access-Control-Request-Method": http.MethodGet}},
		{http.MethodOptions, nil},
	}
	for _, origin := range origins {
		for _, c := range calls {
			rr := corsCall(h, c.method, "/api/version", origin, c.headers)
			if got := rr.Header().Get("Access-Control-Allow-Credentials"); got != "" {
				t.Errorf("%s %q: Access-Control-Allow-Credentials = %q, want none", c.method, origin, got)
			}
			if got := rr.Header().Get("Access-Control-Allow-Origin"); got == "*" {
				t.Errorf("%s %q: wildcard Access-Control-Allow-Origin", c.method, origin)
			}
		}
	}
}

// The CORS grant is read-only. csrfGuard still refuses a state-changing request
// from the bundled console's own origin; that boundary is what keeps the app
// origin from sending anything even after P15's boot half lands.
func TestBundledConsoleCannotPost(t *testing.T) {
	h := securityTestHandler(t)
	for _, origin := range []string{bundledIOSOrigin, bundledAndroidOrigin} {
		rr := corsCall(h, http.MethodPost, "/api/auth/login", origin, nil)
		if rr.Code != http.StatusForbidden {
			t.Errorf("POST from %s: status %d, want 403", origin, rr.Code)
		}
		if !strings.Contains(rr.Body.String(), "cross-site request refused") {
			t.Errorf("POST from %s: body %q, want the cross-site refusal", origin, rr.Body.String())
		}
		if got := rr.Header().Get("Access-Control-Allow-Origin"); got != "" {
			t.Errorf("POST from %s: Access-Control-Allow-Origin = %q, want none", origin, got)
		}
	}
}

// A same-origin caller (the Hub console in a browser) is not a bundled-console
// origin: its answer is byte-for-byte what it was before the middleware, with
// no CORS header and the security headers still in place.
func TestSameOriginAnswersUnchanged(t *testing.T) {
	h := securityTestHandler(t)
	rr := corsCall(h, http.MethodGet, "/api/version", "http://example.com", nil)
	if rr.Code != http.StatusOK {
		t.Errorf("same-origin GET: status %d, want 200", rr.Code)
	}
	if got := rr.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("same-origin GET: Access-Control-Allow-Origin = %q, want none", got)
	}
	if got := rr.Header().Get("Content-Security-Policy"); got != consoleCSP {
		t.Errorf("same-origin GET: Content-Security-Policy = %q, want the console policy", got)
	}
	if got := rr.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Errorf("same-origin GET: X-Content-Type-Options = %q, want nosniff", got)
	}
}
