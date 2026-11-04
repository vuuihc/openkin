package api

import (
	"net/http"
	"strings"
)

// The response headers T12/G18 require on every answer this daemon gives, plus
// the Origin check that keeps another site from riding a logged-in browser into
// a state-changing endpoint. They sit at the top of the middleware chain so
// health checks, static pages, and API answers all carry them: a missing header
// on one route is the exception a scanner finds first.
//
// The policy is deliberately conservative about what the console needs, because
// the right CSP is one that never has to say 'unsafe-eval' or list a CDN: the
// console is served same-origin, fonts and images are self-hosted, and script
// comes from one hashed bundle. blob: is on img-src because file previews
// create object URLs locally.

const consoleCSP = "default-src 'self'; " +
	"script-src 'self'; " +
	"style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' data: blob:; " +
	"media-src 'self' blob:; " +
	"font-src 'self'; " +
	"connect-src 'self' ws: wss:; " +
	"manifest-src 'self'; " +
	"object-src 'none'; " +
	"base-uri 'none'; " +
	"form-action 'self'; " +
	"frame-ancestors 'none'"

// securityHeaders is the middleware that stamps them on. HSTS is only sent
// when the request arrived over TLS (directly or through a proxy the daemon
// already trusts): advertising it over plaintext would tell a browser to
// refuse the one connection a LAN-only daemon can offer.
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", consoleCSP)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Frame-Options", "DENY")
		if requestIsSecure(r) {
			h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}
		next.ServeHTTP(w, r)
	})
}

// sameSiteRequest reports whether a request the browser itself could have made
// from this origin. Cross-site state changes are refused before any handler
// runs: a session cookie is SameSite=Lax already, but Lax still sends cookies
// on top-level navigations, and those can carry POSTs (form hijacking), so the
// check does not lean on the cookie alone.
//
// An absent Origin (curl, the CLI, the Node WebSocket dial, same-origin GET
// navigations in some browsers) is allowed — those callers are not subject to
// ambient cookie authority, or are GETs, which this guard does not gate. A
// present Origin that is not this origin is refused.
func sameSiteRequest(r *http.Request) bool {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return true
	}
	return origin == originOf(r)
}

// originOf derives the scheme://host the request names, from Host and the
// scheme the request is known to have arrived with. Only an exact scheme/host
// match counts: an Origin of null (sandboxed iframe, some redirects), or one
// carrying a port or path this daemon did not answer on, never matches.
func originOf(r *http.Request) string {
	scheme := "http"
	if requestIsSecure(r) {
		scheme = "https"
	}
	host := r.Host
	if host == "" {
		return ""
	}
	return scheme + "://" + host
}

// csrfGuard refuses state-changing requests whose Origin names another site.
// GET/HEAD/OPTIONS are exempt everywhere; WebSocket upgrades are checked by
// their own path (see terminalOriginAllowed) because their handshake is a GET.
func csrfGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			next.ServeHTTP(w, r)
			return
		}
		if !sameSiteRequest(r) {
			writeJSON(w, http.StatusForbidden, map[string]string{
				"error": "cross-site request refused",
			})
			return
		}
		next.ServeHTTP(w, r)
	})
}
