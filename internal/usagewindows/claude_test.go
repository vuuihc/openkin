package usagewindows

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestClaudeProberRefreshesWhenAccessNearExpiry(t *testing.T) {
	var refreshHits, probeHits atomic.Int32
	var sawRefreshBody bool

	mux := http.NewServeMux()
	mux.HandleFunc("/v1/oauth/token", func(w http.ResponseWriter, r *http.Request) {
		refreshHits.Add(1)
		body, _ := io.ReadAll(r.Body)
		var req map[string]string
		_ = json.Unmarshal(body, &req)
		if req["grant_type"] != "refresh_token" || req["refresh_token"] != "refresh-1" {
			t.Errorf("unexpected refresh body: %s", body)
		}
		if req["client_id"] != claudeOAuthClientID {
			t.Errorf("client_id = %q", req["client_id"])
		}
		if req["scope"] == "" {
			t.Errorf("scope missing")
		}
		sawRefreshBody = true
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token":  "access-new",
			"refresh_token": "refresh-2",
			"expires_in":    3600,
			"scope":         "user:profile user:inference",
		})
	})
	mux.HandleFunc("/v1/messages", func(w http.ResponseWriter, r *http.Request) {
		probeHits.Add(1)
		auth := r.Header.Get("Authorization")
		if auth != "Bearer access-new" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("anthropic-ratelimit-unified-5h-utilization", "0.25")
		w.Header().Set("anthropic-ratelimit-unified-5h-reset", "100")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{}`))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	// Route both OAuth and Messages through the test server by rewriting URLs
	// via a custom RoundTripper is heavy; instead point TokenURL at srv and
	// override the messages URL by using a Client that rewrites host. Simpler:
	// use httptest and a transport that maps known hosts.
	client := &http.Client{Transport: rewriteHostTransport{base: srv.URL}}

	now := time.Unix(1_700_000_000, 0)
	var written claudeStoredCred
	prober := &ClaudeProber{
		Client:   client,
		TokenURL: srv.URL + "/v1/oauth/token",
		now:      func() time.Time { return now },
		readToken: func() (claudeStoredCred, error) {
			return claudeStoredCred{
				AccessToken:  "access-old",
				RefreshToken: "refresh-1",
				// Already past skew window relative to now.
				ExpiresAtMs: now.Add(time.Minute).UnixMilli(),
				Scopes:      []string{"user:profile", "user:inference"},
				Plan:        "pro",
				Raw: map[string]json.RawMessage{
					"claudeAiOauth":    json.RawMessage(`{"accessToken":"access-old","refreshToken":"refresh-1","expiresAt":1,"scopes":["user:profile"],"subscriptionType":"pro","rateLimitTier":"default_claude_ai"}`),
					"organizationUuid": json.RawMessage(`"org-1"`),
				},
			}, nil
		},
		writeToken: func(c claudeStoredCred) error {
			written = c
			return nil
		},
	}
	// Override messages URL by temporarily patching via transport rewrite only.

	// Swap global messages URL through transport: rewriteHostTransport maps
	// api.anthropic.com → srv.
	prov, err := prober.Probe(context.Background())
	if err != nil {
		t.Fatalf("Probe: %v", err)
	}
	if prov.Error != "" {
		t.Fatalf("unexpected error: %q", prov.Error)
	}
	if !sawRefreshBody || refreshHits.Load() != 1 {
		t.Fatalf("refresh hits = %d sawBody=%v", refreshHits.Load(), sawRefreshBody)
	}
	if probeHits.Load() != 1 {
		t.Fatalf("probe hits = %d", probeHits.Load())
	}
	if len(prov.Windows) != 1 || prov.Windows[0].UsedPercent != 25 {
		t.Fatalf("windows = %+v", prov.Windows)
	}
	if written.AccessToken != "access-new" || written.RefreshToken != "refresh-2" {
		t.Fatalf("written tokens = %+v", written)
	}
	if written.ExpiresAtMs != now.Add(3600*time.Second).UnixMilli() {
		t.Fatalf("written expiresAt = %d", written.ExpiresAtMs)
	}
}

func TestClaudeProberRefreshesOn401AndRetries(t *testing.T) {
	var refreshHits, probeHits atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/oauth/token", func(w http.ResponseWriter, r *http.Request) {
		refreshHits.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token": "access-new",
			"expires_in":   3600,
		})
	})
	mux.HandleFunc("/v1/messages", func(w http.ResponseWriter, r *http.Request) {
		n := probeHits.Add(1)
		auth := r.Header.Get("Authorization")
		if n == 1 {
			if auth != "Bearer access-old" {
				t.Errorf("first probe auth = %q", auth)
			}
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if auth != "Bearer access-new" {
			t.Errorf("retry auth = %q", auth)
		}
		w.Header().Set("anthropic-ratelimit-unified-5h-utilization", "0.1")
		w.Header().Set("anthropic-ratelimit-unified-5h-reset", "50")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{}`))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	now := time.Unix(1_700_000_000, 0)
	prober := &ClaudeProber{
		Client:   &http.Client{Transport: rewriteHostTransport{base: srv.URL}},
		TokenURL: srv.URL + "/v1/oauth/token",
		now:      func() time.Time { return now },
		readToken: func() (claudeStoredCred, error) {
			return claudeStoredCred{
				AccessToken:  "access-old",
				RefreshToken: "refresh-1",
				// Far from expiry so proactive refresh is skipped.
				ExpiresAtMs: now.Add(2 * time.Hour).UnixMilli(),
				Plan:        "pro",
			}, nil
		},
		writeToken: func(claudeStoredCred) error { return nil },
	}

	prov, err := prober.Probe(context.Background())
	if err != nil {
		t.Fatalf("Probe: %v", err)
	}
	if prov.Error != "" {
		t.Fatalf("error = %q", prov.Error)
	}
	if refreshHits.Load() != 1 || probeHits.Load() != 2 {
		t.Fatalf("refresh=%d probe=%d", refreshHits.Load(), probeHits.Load())
	}
}

func TestClaudeProberRefreshFailureSurfacesReLogin(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/oauth/token", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"invalid_grant"}`))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	now := time.Unix(1_700_000_000, 0)
	prober := &ClaudeProber{
		Client:   &http.Client{Transport: rewriteHostTransport{base: srv.URL}},
		TokenURL: srv.URL + "/v1/oauth/token",
		now:      func() time.Time { return now },
		readToken: func() (claudeStoredCred, error) {
			return claudeStoredCred{
				AccessToken:  "access-old",
				RefreshToken: "refresh-bad",
				ExpiresAtMs:  now.Add(time.Minute).UnixMilli(),
				Plan:         "pro",
			}, nil
		},
		writeToken: func(claudeStoredCred) error { return nil },
	}

	prov, err := prober.Probe(context.Background())
	if err != nil {
		t.Fatalf("Probe: %v", err)
	}
	if prov.Error != "claude token expired; re-login" {
		t.Fatalf("error = %q", prov.Error)
	}
}

func TestParseClaudeCredentialJSONPreservesRaw(t *testing.T) {
	raw := []byte(`{
		"claudeAiOauth": {
			"accessToken": "a",
			"refreshToken": "r",
			"expiresAt": 123,
			"scopes": ["user:inference"],
			"subscriptionType": "max",
			"rateLimitTier": "default_claude_ai"
		},
		"organizationUuid": "org-uuid"
	}`)
	cred, err := parseClaudeCredentialJSON(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if cred.AccessToken != "a" || cred.RefreshToken != "r" || cred.Plan != "max" {
		t.Fatalf("cred = %+v", cred)
	}
	built, err := buildClaudeCredentialJSON(claudeStoredCred{
		AccessToken:  "a2",
		RefreshToken: "r2",
		ExpiresAtMs:  999,
		Scopes:       []string{"user:inference"},
		Plan:         "max",
		Raw:          cred.Raw,
	})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	var top map[string]json.RawMessage
	if err := json.Unmarshal(built, &top); err != nil {
		t.Fatalf("unmarshal built: %v", err)
	}
	if string(top["organizationUuid"]) != `"org-uuid"` {
		t.Fatalf("org lost: %s", top["organizationUuid"])
	}
	var oauth claudeOAuthBlob
	if err := json.Unmarshal(top["claudeAiOauth"], &oauth); err != nil {
		t.Fatalf("oauth: %v", err)
	}
	if oauth.AccessToken != "a2" || oauth.RefreshToken != "r2" || oauth.ExpiresAt != 999 {
		t.Fatalf("oauth = %+v", oauth)
	}
	if oauth.RateLimitTier != "default_claude_ai" {
		t.Fatalf("rateLimitTier lost: %q", oauth.RateLimitTier)
	}
}

func TestParseKeychainAccount(t *testing.T) {
	out := `keychain: "/Users/x/Library/Keychains/login.keychain-db"
class: "genp"
attributes:
    "acct"<blob>="vuuihc"
    "svce"<blob>="Claude Code-credentials"
`
	if got := parseKeychainAccount(out); got != "vuuihc" {
		t.Fatalf("got %q", got)
	}
}

// rewriteHostTransport sends api.anthropic.com and platform.claude.com
// requests to the httptest base URL while keeping the original path.
type rewriteHostTransport struct {
	base string
}

func (t rewriteHostTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	u := *req.URL
	baseURL, err := http.NewRequest(http.MethodGet, t.base, nil)
	if err != nil {
		return nil, err
	}
	u.Scheme = baseURL.URL.Scheme
	u.Host = baseURL.URL.Host
	// Messages path in production is /v1/messages; token path is absolute via TokenURL.
	clone := req.Clone(req.Context())
	clone.URL = &u
	clone.Host = u.Host
	clone.RequestURI = ""
	return http.DefaultTransport.RoundTrip(clone)
}
