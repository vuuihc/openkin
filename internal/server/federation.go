package server

import (
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"

	"github.com/vuuihc/openkin/internal/remote"
)

// federationProxy publishes an identity provider under this Hub's own origin.
//
// The reason this exists at all is OIDC's issuer rule: the `issuer` in
// discovery must match the issuer the client was configured with, exactly. A
// provider running beside Kin in the same Compose network therefore has to
// present itself at the public URL — https://kin.example.com/dex — even though
// the browser reaches it through this process and the backchannel reaches it
// over the container network. Reverse-proxying the provider's path prefix is
// what makes both true at once.
type federationProxy struct {
	prefix   string
	upstream *httputil.ReverseProxy
}

// newFederationProxy returns the proxy Kin must mount, or nil when the
// configured provider is not published behind this Hub.
//
// It refuses to proxy anything that is not same-origin with the Hub and does
// not sit under a non-root path. That keeps a misconfiguration from turning the
// Hub into an open relay for an arbitrary host.
func newFederationProxy(hub *remote.Hub, issuer, backchannelAddr string) (*federationProxy, error) {
	if hub == nil || strings.TrimSpace(backchannelAddr) == "" {
		return nil, nil
	}
	issuerURL, err := url.Parse(strings.TrimSpace(issuer))
	if err != nil {
		return nil, fmt.Errorf("parse %s: %w", envOIDCIssuer, err)
	}
	hubURL, err := url.Parse(hub.URL())
	if err != nil {
		return nil, fmt.Errorf("parse hub url: %w", err)
	}
	if !sameOrigin(issuerURL, hubURL) {
		// A provider on its own origin is reached directly. Nothing to proxy,
		// and silently proxying it would be surprising.
		return nil, nil
	}
	prefix := strings.TrimSuffix(issuerURL.Path, "/")
	if prefix == "" {
		return nil, fmt.Errorf(
			"%s is this hub's own origin but has no path prefix; a provider cannot be published at the site root",
			envOIDCIssuer)
	}

	upstreamAddr := strings.TrimSpace(backchannelAddr)
	if strings.Contains(upstreamAddr, "://") || strings.ContainsAny(upstreamAddr, "/?#") {
		return nil, fmt.Errorf("%s must be host:port without a scheme, got %q", envOIDCBackchannelAddr, backchannelAddr)
	}
	upstreamURL, err := url.Parse("http://" + upstreamAddr)
	if err != nil || upstreamURL.Host == "" || upstreamURL.Host != upstreamAddr {
		return nil, fmt.Errorf("%s must be host:port, got %q", envOIDCBackchannelAddr, backchannelAddr)
	}

	proxy := httputil.NewSingleHostReverseProxy(upstreamURL)
	baseDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		baseDirector(req)
		// Preserve the public host so the provider builds correct URLs.
		req.Host = issuerURL.Host
		// The session cookie is scoped to "/" and would otherwise be handed to
		// the identity provider on every request. Kin's own credential must not
		// leave for a third-party service, however trusted.
		req.Header.Del("Cookie")
		req.Header.Del("Authorization")
	}
	proxy.ModifyResponse = func(resp *http.Response) error {
		// A provider must not be able to replace Kin's session by reusing its
		// cookie name. Only that one cookie is dropped: the provider's own
		// session cookies are how its login flow works at all.
		setCookies := resp.Header.Values("Set-Cookie")
		if len(setCookies) == 0 {
			return nil
		}
		kept := make([]string, 0, len(setCookies))
		for _, header := range setCookies {
			if cookieNameOf(header) == remote.SessionCookieName {
				continue
			}
			kept = append(kept, header)
		}
		if len(kept) == len(setCookies) {
			return nil
		}
		resp.Header.Del("Set-Cookie")
		for _, header := range kept {
			resp.Header.Add("Set-Cookie", header)
		}
		return nil
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		http.Error(w, `{"error":"identity provider is unreachable"}`, http.StatusBadGateway)
	}

	return &federationProxy{prefix: prefix, upstream: proxy}, nil
}

// Prefix returns the path Kin mounts the proxy at.
func (f *federationProxy) Prefix() string { return f.prefix }

// ServeHTTP implements http.Handler.
func (f *federationProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.upstream.ServeHTTP(w, r)
}

// sameOrigin reports whether two URLs share a scheme and authority, treating an
// absent port as the scheme's default.
func sameOrigin(a, b *url.URL) bool {
	return strings.EqualFold(a.Scheme, b.Scheme) && strings.EqualFold(a.Host, b.Host)
}

// cookieNameOf extracts the name from a raw Set-Cookie header value, which is
// everything before the first "=".
func cookieNameOf(setCookie string) string {
	name, _, found := strings.Cut(setCookie, "=")
	if !found {
		return ""
	}
	return strings.TrimSpace(name)
}
