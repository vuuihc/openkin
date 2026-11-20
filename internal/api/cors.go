package api

import (
	"net/http"
	"strings"
)

// The bundled console is the copy of web/dist that ships inside the phone app
// (mobile/capacitor.config.ts:50). On iOS Capacitor serves it from
// capacitor://localhost and on Android from http://localhost; either way the
// page's origin is not the Hub's, so reading the console set or /api/version
// from it is a cross-origin read the browser refuses unless the Hub says
// otherwise. This middleware says otherwise for exactly those two origins, for
// reads only.
//
// It is deliberately not a general CORS layer: the list is two platform
// constants matched on the whole origin string, no port is accepted on
// http://localhost, no wildcard is ever emitted, and no answer carries
// Access-Control-Allow-Credentials. Cookies stay out of this path -- the app
// origin never receives a Hub session -- and csrfGuard still refuses every
// state-changing request from it (see secure.go), so this grant can read but
// cannot send.

// bundledConsoleOrigins are the origins a Capacitor webview serves the bundled
// console from. Matched case-insensitively on scheme and host (both are
// case-insensitive in a URI) and otherwise exactly: no prefix, no suffix, no
// port, no path.
var bundledConsoleOrigins = []string{
	"capacitor://localhost", // iOS WKWebView
	"http://localhost",      // Android WebView
}

// bundledConsoleOrigin returns the canonical allow-list entry matching origin,
// or "" when origin is not one of them. Answers name the canonical entry rather
// than echoing the request, so even a case-fold lookalike EqualFold happens to
// admit receives a value no browser accepts as its own origin.
func bundledConsoleOrigin(origin string) string {
	origin = strings.TrimSpace(origin)
	if origin == "" {
		return ""
	}
	for _, allowed := range bundledConsoleOrigins {
		if strings.EqualFold(origin, allowed) {
			return allowed
		}
	}
	return ""
}

// corsForBundledConsole grants those two origins read access. It sits beside
// securityHeaders, ahead of csrfGuard and auth, so every route -- static
// console assets included -- carries the header and a preflight is answered
// before a credential is required.
//
// An origin that is not on the list gets no CORS header at all; this is not an
// error response, and it is not a refusal of the request itself.
func corsForBundledConsole(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		allowed := bundledConsoleOrigin(r.Header.Get("Origin"))
		if allowed == "" {
			next.ServeHTTP(w, r)
			return
		}
		h := w.Header()
		switch r.Method {
		case http.MethodGet, http.MethodHead:
			h.Set("Access-Control-Allow-Origin", allowed)
			h.Add("Vary", "Origin")
		case http.MethodOptions:
			// Only a preflight for a read is answered. Anything asking for a
			// state-changing method falls through with no allow headers, and
			// the browser refuses the real request before sending it.
			switch strings.ToUpper(strings.TrimSpace(r.Header.Get("Access-Control-Request-Method"))) {
			case http.MethodGet, http.MethodHead:
				h.Set("Access-Control-Allow-Origin", allowed)
				h.Add("Vary", "Origin")
				h.Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
				h.Set("Access-Control-Allow-Headers", "Authorization")
				h.Set("Access-Control-Max-Age", "600")
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
