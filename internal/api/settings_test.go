package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/vuuihc/openkin/internal/cloudflare"
	"github.com/vuuihc/openkin/internal/notify"
)

type memorySecretStore struct {
	values map[string]string
}

func (s *memorySecretStore) Get(ref string) (string, error) {
	if s.values == nil {
		return "", errors.New("not found")
	}
	v, ok := s.values[ref]
	if !ok {
		return "", errors.New("not found")
	}
	return v, nil
}

func (s *memorySecretStore) Put(ref, value string) error {
	if s.values == nil {
		s.values = map[string]string{}
	}
	s.values[ref] = value
	return nil
}

func (s *memorySecretStore) Delete(ref string) error {
	delete(s.values, ref)
	return nil
}

func TestSettingsGetPut(t *testing.T) {
	s, token := newTestServer(t)
	s.NetworkMode = "lan"
	s.BaseURL = "http://192.168.1.10:7777"
	s.Token = token
	h := s.Handler()

	// GET
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/settings", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("GET settings: %d %s", rr.Code, rr.Body.String())
	}
	var got map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got["network_mode"] != "lan" {
		t.Fatalf("network_mode = %q", got["network_mode"])
	}
	if got["token"] != token {
		t.Fatalf("token missing")
	}

	// PUT
	body := `{"notify.ntfy_topic":"http://127.0.0.1:9999/t","notify.bark_url":"","ui.base_url":"http://override:7777"}`
	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPut, "/api/settings", bytes.NewReader([]byte(body)))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("PUT settings: %d %s", rr.Code, rr.Body.String())
	}
	got = map[string]any{}
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got["notify.ntfy_topic"] != "http://127.0.0.1:9999/t" {
		t.Fatalf("ntfy = %q", got["notify.ntfy_topic"])
	}
	if got["ui.base_url"] != "http://override:7777" {
		t.Fatalf("base = %q", got["ui.base_url"])
	}

	// Reject unknown key
	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPut, "/api/settings", bytes.NewReader([]byte(`{"evil":"1"}`)))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("unknown key: %d", rr.Code)
	}

	// Auth required
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/settings", nil))
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("no auth: %d", rr.Code)
	}
}

func TestRelaySettingsConfigureAndPairing(t *testing.T) {
	s, token := newTestServer(t)
	var configured string
	var snapshot RelayStatus
	s.ConfigureRelay = func(_ context.Context, rawURL string) (RelayStatus, error) {
		configured = rawURL
		snapshot = RelayStatus{
			URL:        rawURL,
			State:      "connecting",
			ConnectURL: rawURL + "?room=test",
			PairingURL: rawURL + "?room=test&pairing=1",
		}
		return snapshot, nil
	}
	s.RelaySnapshot = func() RelayStatus {
		return snapshot
	}
	s.RefreshRelayPairing = func(context.Context) (RelayStatus, error) {
		snapshot = RelayStatus{
			URL:        configured,
			State:      "connected",
			PairingURL: "https://relay.example.test?pairing=refreshed",
		}
		return snapshot, nil
	}
	h := s.Handler()

	req := httptest.NewRequest(http.MethodPut, "/api/settings", bytes.NewReader([]byte(
		`{"relay.url":"https://relay.example.test"}`,
	)))
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("relay settings status=%d body=%s", rr.Code, rr.Body.String())
	}
	if configured != "https://relay.example.test" {
		t.Fatalf("configured URL=%q", configured)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/relay/pairing", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("pairing refresh status=%d body=%s", rr.Code, rr.Body.String())
	}
	var got map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got["relay.pairing_url"] != "https://relay.example.test?pairing=refreshed" {
		t.Fatalf("pairing URL=%q", got["relay.pairing_url"])
	}
}

func TestCloudflareRelayDeployConfiguresRelay(t *testing.T) {
	s, token := newTestServer(t)
	secrets := &memorySecretStore{}
	var sawTokenExchange bool
	var sawUpload bool
	var sawEnable bool
	cf := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/oauth2/token":
			sawTokenExchange = true
			if err := r.ParseForm(); err != nil {
				t.Fatalf("parse token form: %v", err)
			}
			if r.Form.Get("code_verifier") == "" {
				t.Fatalf("missing code verifier")
			}
			writeJSON(w, http.StatusOK, map[string]any{
				"access_token":  "access-1",
				"refresh_token": "refresh-1",
				"expires_in":    3600,
			})
		case r.URL.Path == "/client/v4/accounts":
			if got := r.Header.Get("Authorization"); got != "Bearer access-1" {
				t.Fatalf("accounts authorization=%q", got)
			}
			writeJSON(w, http.StatusOK, map[string]any{
				"success": true,
				"result":  []map[string]string{{"id": "acc1", "name": "Primary"}},
			})
		case r.URL.Path == "/client/v4/accounts/acc1/workers/scripts/kin-relay" && r.Method == http.MethodPut:
			sawUpload = true
			body, _ := io.ReadAll(r.Body)
			text := string(body)
			if !strings.Contains(text, `"main_module":"relay.js"`) || !strings.Contains(text, "class RelayRoom") {
				t.Fatalf("upload body missing relay module: %s", text[:min(len(text), 500)])
			}
			writeJSON(w, http.StatusOK, map[string]any{"success": true, "result": map[string]any{}})
		case r.URL.Path == "/client/v4/accounts/acc1/workers/scripts/kin-relay/subdomain" && r.Method == http.MethodPost:
			sawEnable = true
			writeJSON(w, http.StatusOK, map[string]any{"success": true, "result": map[string]bool{"enabled": true}})
		case r.URL.Path == "/client/v4/accounts/acc1/workers/subdomain":
			writeJSON(w, http.StatusOK, map[string]any{
				"success": true,
				"result":  map[string]string{"subdomain": "example-user"},
			})
		default:
			t.Fatalf("unexpected Cloudflare request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer cf.Close()
	s.Cloudflare = &cloudflare.Service{
		Store:       s.Store,
		Secrets:     secrets,
		Client:      cf.Client(),
		APIBase:     cf.URL + "/client/v4",
		AuthURL:     cf.URL + "/oauth2/auth",
		TokenURL:    cf.URL + "/oauth2/token",
		RedirectURI: "http://127.0.0.1:9999/api/cloudflare/oauth/callback",
	}
	var configured string
	s.ConfigureRelay = func(_ context.Context, rawURL string) (RelayStatus, error) {
		configured = rawURL
		return RelayStatus{URL: rawURL, State: "connecting", PairingURL: rawURL + "?pairing=1"}, nil
	}
	h := s.Handler()

	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/cloudflare/oauth/start", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("start oauth: %d %s", rr.Code, rr.Body.String())
	}
	var started map[string]string
	if err := json.Unmarshal(rr.Body.Bytes(), &started); err != nil {
		t.Fatal(err)
	}
	auth, err := url.Parse(started["auth_url"])
	if err != nil {
		t.Fatal(err)
	}
	if auth.Query().Get("code_challenge") == "" {
		t.Fatalf("auth URL missing PKCE challenge: %s", started["auth_url"])
	}
	if auth.Query().Get("redirect_uri") != "http://127.0.0.1:9999/api/cloudflare/oauth/callback" {
		t.Fatalf("auth URL redirect_uri=%q", auth.Query().Get("redirect_uri"))
	}

	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/cloudflare/oauth/callback?state="+url.QueryEscape(auth.Query().Get("state"))+"&code=code-1", nil)
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("callback: %d %s", rr.Code, rr.Body.String())
	}
	if !sawTokenExchange {
		t.Fatal("token exchange not called")
	}

	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/cloudflare/relay/deploy", strings.NewReader(`{"account_id":"acc1","script_name":"kin-relay"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("deploy: %d %s", rr.Code, rr.Body.String())
	}
	if !sawUpload || !sawEnable {
		t.Fatalf("deploy incomplete upload=%v enable=%v", sawUpload, sawEnable)
	}
	if configured != "https://kin-relay.example-user.workers.dev" {
		t.Fatalf("configured relay=%q", configured)
	}
	var got map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got["relay.url"] != configured || got["cloudflare.relay_worker_url"] != configured {
		t.Fatalf("settings response = %#v", got)
	}
}

func TestCloudflareRelayDeployRollsBackRelayURLWhenConfigureFails(t *testing.T) {
	s, token := newTestServer(t)
	secrets := &memorySecretStore{}
	cf := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/oauth2/token":
			writeJSON(w, http.StatusOK, map[string]any{
				"access_token":  "access-1",
				"refresh_token": "refresh-1",
				"expires_in":    3600,
			})
		case r.URL.Path == "/client/v4/accounts":
			writeJSON(w, http.StatusOK, map[string]any{
				"success": true,
				"result":  []map[string]string{{"id": "acc1", "name": "Primary"}},
			})
		case r.URL.Path == "/client/v4/accounts/acc1/workers/scripts/kin-relay" && r.Method == http.MethodPut:
			writeJSON(w, http.StatusOK, map[string]any{"success": true, "result": map[string]any{}})
		case r.URL.Path == "/client/v4/accounts/acc1/workers/scripts/kin-relay/subdomain" && r.Method == http.MethodPost:
			writeJSON(w, http.StatusOK, map[string]any{"success": true, "result": map[string]bool{"enabled": true}})
		case r.URL.Path == "/client/v4/accounts/acc1/workers/subdomain":
			writeJSON(w, http.StatusOK, map[string]any{
				"success": true,
				"result":  map[string]string{"subdomain": "example-user"},
			})
		default:
			t.Fatalf("unexpected Cloudflare request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer cf.Close()
	s.Cloudflare = &cloudflare.Service{
		Store:    s.Store,
		Secrets:  secrets,
		Client:   cf.Client(),
		APIBase:  cf.URL + "/client/v4",
		AuthURL:  cf.URL + "/oauth2/auth",
		TokenURL: cf.URL + "/oauth2/token",
	}
	s.RelaySnapshot = func() RelayStatus {
		return RelayStatus{URL: "https://old-relay.example.test", State: "connected"}
	}
	var configured []string
	s.ConfigureRelay = func(_ context.Context, rawURL string) (RelayStatus, error) {
		configured = append(configured, rawURL)
		if rawURL == "https://kin-relay.example-user.workers.dev" {
			return RelayStatus{}, errors.New("relay refused worker URL")
		}
		return RelayStatus{URL: rawURL, State: "connected"}, nil
	}
	h := s.Handler()

	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/cloudflare/oauth/start", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("start oauth: %d %s", rr.Code, rr.Body.String())
	}
	var started map[string]string
	if err := json.Unmarshal(rr.Body.Bytes(), &started); err != nil {
		t.Fatal(err)
	}
	auth, err := url.Parse(started["auth_url"])
	if err != nil {
		t.Fatal(err)
	}

	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/cloudflare/oauth/callback?state="+url.QueryEscape(auth.Query().Get("state"))+"&code=code-1", nil)
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("callback: %d %s", rr.Code, rr.Body.String())
	}

	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/cloudflare/relay/deploy", strings.NewReader(`{"account_id":"acc1","script_name":"kin-relay"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("deploy status=%d body=%s", rr.Code, rr.Body.String())
	}
	if got, _ := s.Store.GetSetting(t.Context(), "relay.url"); got != "https://old-relay.example.test" {
		t.Fatalf("relay.url after snapshot rollback=%q", got)
	}
	wantConfigured := []string{"https://kin-relay.example-user.workers.dev", "https://old-relay.example.test"}
	if len(configured) != len(wantConfigured) {
		t.Fatalf("configured calls=%v", configured)
	}
	for i := range wantConfigured {
		if configured[i] != wantConfigured[i] {
			t.Fatalf("configured calls=%v", configured)
		}
	}
}

func TestNotifyTestEndpoint(t *testing.T) {
	s, token := newTestServer(t)
	h := s.Handler()

	var hit bool
	oldTransport := http.DefaultTransport
	http.DefaultTransport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		hit = true
		if got := r.URL.String(); got != "https://notify.test/kin" {
			t.Fatalf("url = %q", got)
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body:       http.NoBody,
			Request:    r,
		}, nil
	})
	defer func() { http.DefaultTransport = oldTransport }()

	if err := s.Store.SetSetting(t.Context(), notify.KeyNtfyTopic, "https://notify.test/kin"); err != nil {
		t.Fatal(err)
	}

	// Auth required
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/api/notify/test", nil))
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("no auth: %d", rr.Code)
	}

	rr = httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/notify/test", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("notify test: %d %s", rr.Code, rr.Body.String())
	}
	var body struct {
		OK      bool `json:"ok"`
		Results []struct {
			Channel string `json:"channel"`
			OK      bool   `json:"ok"`
		} `json:"results"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if !body.OK || len(body.Results) != 1 || body.Results[0].Channel != "ntfy" || !body.Results[0].OK {
		t.Fatalf("body = %#v", body)
	}
	if !hit {
		t.Fatal("expected fake ntfy to be hit")
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}

func TestPutAgentDefaultRequiresAvailable(t *testing.T) {
	s, token := newTestServer(t)
	h := s.Handler()

	// Unknown agent → 400
	body := `{"agent.default":"not-a-real-agent"}`
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPut, "/api/settings", bytes.NewReader([]byte(body)))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("unknown agent: status %d body %s", rr.Code, rr.Body.String())
	}

	// Empty clears preference → 200
	body = `{"agent.default":""}`
	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPut, "/api/settings", bytes.NewReader([]byte(body)))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("clear default: status %d body %s", rr.Code, rr.Body.String())
	}

	// Registered + runnable test adapter may pass even without PATH binary
	// (GetRunnable is the final gate for adapters Kin already opened).
	body = `{"agent.default":"claude-code"}`
	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPut, "/api/settings", bytes.NewReader([]byte(body)))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("claude-code default: status %d body %s", rr.Code, rr.Body.String())
	}
}
