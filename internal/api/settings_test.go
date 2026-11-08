package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/apns"
	"github.com/vuuihc/openkin/internal/cloudflare"
	"github.com/vuuihc/openkin/internal/notify"
	"github.com/vuuihc/openkin/internal/provider"
	"github.com/vuuihc/openkin/internal/store"
)

type memorySecretStore struct {
	values  map[string]string
	gets    int
	failGet bool
}

func (s *memorySecretStore) Get(ref string) (string, error) {
	s.gets++
	if s.failGet {
		return "", errors.New("unexpected secret read")
	}
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

func TestSettingsAndProviderListDoNotReadProviderSecrets(t *testing.T) {
	s, token := newTestServer(t)
	secrets := &memorySecretStore{
		values: map[string]string{
			"secret-provider-p1": "sk-private",
		},
		failGet: true,
	}
	provider.SetSecretStore(secrets)
	t.Cleanup(func() { provider.SetSecretStore(nil) })
	if err := s.Store.SetSettings(t.Context(), map[string]string{
		provider.KeyActiveProvider: "p1",
		provider.KeyProviders:      `{"active_id":"p1","entries":[{"id":"p1","name":"Primary","kind":"openai-compatible","base_url":"https://api.example.test/v1","api_key":"secret://secret-provider-p1","model":"gpt-test"}]}`,
	}); err != nil {
		t.Fatal(err)
	}
	h := s.Handler()

	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/settings", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("GET settings: %d %s", rr.Code, rr.Body.String())
	}
	var settings map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &settings); err != nil {
		t.Fatal(err)
	}
	if settings["provider.api_key"] == "" || strings.Contains(settings["provider.api_key"].(string), "secret://") {
		t.Fatalf("provider.api_key mask = %q", settings["provider.api_key"])
	}

	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/providers", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("GET providers: %d %s", rr.Code, rr.Body.String())
	}
	if secrets.gets != 0 {
		t.Fatalf("settings display read provider secret %d time(s)", secrets.gets)
	}
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
	body := `{"ui.base_url":"http://override:7777"}`
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
	if got["ui.base_url"] != "http://override:7777" {
		t.Fatalf("base = %q", got["ui.base_url"])
	}

	// Reject unknown keys, and specifically every push secret: the APNs private
	// key and the legacy VAPID key must only ever be written by the operator
	// CLI, because a client that could write them could sign notifications.
	for _, body := range []string{
		`{"evil":"1"}`,
		`{"push.vapid_private":"AAAA"}`,
		`{"push.apns.private_key":"AAAA"}`,
	} {
		rr = httptest.NewRecorder()
		req = httptest.NewRequest(http.MethodPut, "/api/settings", bytes.NewReader([]byte(body)))
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("unknown key in %s: %d", body, rr.Code)
		}
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
			_, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
			if err != nil {
				t.Fatal(err)
			}
			reader := multipart.NewReader(bytes.NewReader(body), params["boundary"])
			var metadata map[string]any
			for {
				part, err := reader.NextPart()
				if errors.Is(err, io.EOF) {
					break
				}
				if err != nil {
					t.Fatal(err)
				}
				if part.FormName() != "metadata" {
					continue
				}
				if err := json.NewDecoder(part).Decode(&metadata); err != nil {
					t.Fatal(err)
				}
			}
			if _, ok := metadata["migrations"].(map[string]any); !ok {
				t.Fatalf("metadata migrations must be object, got %#v", metadata["migrations"])
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
	if auth.Query().Get("scope") != "workers-scripts.read workers-scripts.write account-settings.read zone.read" {
		t.Fatalf("auth URL scope=%q", auth.Query().Get("scope"))
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
	if !strings.Contains(rr.Body.String(), "kin://settings?cloudflare=connected") {
		t.Fatalf("callback did not deep-link to desktop: %s", rr.Body.String())
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

func TestCloudflareRelayDomainConfiguresCustomDomain(t *testing.T) {
	s, token := newTestServer(t)
	secrets := &memorySecretStore{}
	var sawDomainPut bool
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
		case r.URL.Path == "/client/v4/zones":
			if got := r.URL.Query().Get("account.id"); got != "acc1" {
				t.Fatalf("zones account.id=%q", got)
			}
			writeJSON(w, http.StatusOK, map[string]any{
				"success": true,
				"result": []map[string]string{{
					"id":     "zone1",
					"name":   "example.com",
					"status": "active",
				}},
			})
		case r.URL.Path == "/client/v4/accounts/acc1/workers/domains" && r.Method == http.MethodPut:
			sawDomainPut = true
			var body map[string]string
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if body["hostname"] != "kin-relay.example.com" || body["service"] != "kin-relay" || body["zone_id"] != "zone1" {
				t.Fatalf("domain body=%#v", body)
			}
			if _, ok := body["environment"]; ok {
				t.Fatalf("domain body must not include deprecated environment field: %#v", body)
			}
			writeJSON(w, http.StatusOK, map[string]any{
				"success": true,
				"result": map[string]string{
					"id":        "domain1",
					"hostname":  "kin-relay.example.com",
					"service":   "kin-relay",
					"zone_id":   "zone1",
					"zone_name": "example.com",
				},
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

	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/cloudflare/oauth/callback?state="+url.QueryEscape(auth.Query().Get("state"))+"&code=code-1", nil)
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("callback: %d %s", rr.Code, rr.Body.String())
	}

	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/cloudflare/zones?account_id=acc1", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("zones: %d %s", rr.Code, rr.Body.String())
	}

	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/cloudflare/relay/domain", strings.NewReader(`{"account_id":"acc1","zone_id":"zone1","script_name":"kin-relay"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("domain: %d %s", rr.Code, rr.Body.String())
	}
	if !sawDomainPut {
		t.Fatal("domain PUT not called")
	}
	if configured != "https://kin-relay.example.com" {
		t.Fatalf("configured relay=%q", configured)
	}
	var got map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got["relay.url"] != configured || got["cloudflare.relay_custom_domain"] != "kin-relay.example.com" {
		t.Fatalf("settings response=%#v", got)
	}
}

func TestCloudflareRelayDomainRollsBackWhenConfigureFails(t *testing.T) {
	s, token := newTestServer(t)
	secrets := &memorySecretStore{}
	var sawDetach bool
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
		case r.URL.Path == "/client/v4/zones":
			writeJSON(w, http.StatusOK, map[string]any{
				"success": true,
				"result": []map[string]string{{
					"id":     "zone1",
					"name":   "example.com",
					"status": "active",
				}},
			})
		case r.URL.Path == "/client/v4/accounts/acc1/workers/domains" && r.Method == http.MethodPut:
			writeJSON(w, http.StatusOK, map[string]any{
				"success": true,
				"result": map[string]string{
					"id":        "domain1",
					"hostname":  "kin-relay.example.com",
					"service":   "kin-relay",
					"zone_id":   "zone1",
					"zone_name": "example.com",
				},
			})
		case r.URL.Path == "/client/v4/accounts/acc1/workers/domains/domain1" && r.Method == http.MethodDelete:
			sawDetach = true
			writeJSON(w, http.StatusOK, map[string]any{"success": true, "result": map[string]any{}})
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
	s.RelaySnapshot = func() RelayStatus {
		return RelayStatus{URL: "https://old-relay.example.test", State: "connected"}
	}
	var configured []string
	s.ConfigureRelay = func(_ context.Context, rawURL string) (RelayStatus, error) {
		configured = append(configured, rawURL)
		if rawURL == "https://kin-relay.example.com" {
			return RelayStatus{}, errors.New("relay refused custom domain")
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
	req = httptest.NewRequest(http.MethodPost, "/api/cloudflare/relay/domain", strings.NewReader(`{"account_id":"acc1","zone_id":"zone1","script_name":"kin-relay"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("domain status=%d body=%s", rr.Code, rr.Body.String())
	}
	if !sawDetach {
		t.Fatal("custom domain was not detached after configure failure")
	}
	if got, _ := s.Store.GetSetting(t.Context(), "relay.url"); got != "https://old-relay.example.test" {
		t.Fatalf("relay.url after rollback=%q", got)
	}
	if got, _ := s.Store.GetSetting(t.Context(), "cloudflare.relay_custom_domain"); got != "" {
		t.Fatalf("custom domain should not be remembered after rollback, got %q", got)
	}
	wantConfigured := []string{"https://kin-relay.example.com", "https://old-relay.example.test"}
	if len(configured) != len(wantConfigured) {
		t.Fatalf("configured calls=%v", configured)
	}
	for i := range wantConfigured {
		if configured[i] != wantConfigured[i] {
			t.Fatalf("configured calls=%v", configured)
		}
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

	const deviceToken = "aabbccdd00112233445566778899aabbccddeeff00112233445566778899aabb"
	if _, err := s.Store.SavePushDevice(t.Context(), store.PushDevice{
		ID: "pd1", InstallID: "install-0001", Platform: "ios", Token: deviceToken,
		Environment: "production", Name: "iPhone", OwnerUserID: "user-owner",
		UpdatedAt: time.Now().UnixMilli(),
	}); err != nil {
		t.Fatal(err)
	}
	fake := &fakeAPNs{}
	s.Notify = &notify.Sender{Store: s.Store, Devices: s.Store, APNs: fake}
	h := s.Handler()

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
			Device  string `json:"device"`
			OK      bool   `json:"ok"`
		} `json:"results"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if !body.OK || len(body.Results) != 1 || body.Results[0].Channel != "apns" || !body.Results[0].OK {
		t.Fatalf("body = %#v", body)
	}
	if body.Results[0].Device != "pd1" {
		t.Fatalf("device = %q", body.Results[0].Device)
	}
	if got := fake.sent(); len(got) != 1 || got[0] != deviceToken {
		t.Fatalf("sent tokens = %v", got)
	}
}

// fakeAPNs records sends without talking to Apple.
type fakeAPNs struct {
	mu     sync.Mutex
	tokens []string
}

func (f *fakeAPNs) Configured() bool { return true }

func (f *fakeAPNs) Send(ctx context.Context, token string, env apns.Environment, n apns.Notification) apns.Result {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.tokens = append(f.tokens, token)
	return apns.Result{OK: true, Status: http.StatusOK}
}

func (f *fakeAPNs) sent() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.tokens...)
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

// TestPutAgentDefaultRefreshesTheNodeHello pins live propagation: the Hub's
// copy of this machine's agents — and therefore the phone's default — is built
// from the last hello, so a changed default has to make the node re-announce
// instead of waiting for a restart.
func TestPutAgentDefaultRefreshesTheNodeHello(t *testing.T) {
	s, token := newTestServer(t)
	refreshes := 0
	s.RefreshNodeHello = func() { refreshes++ }
	h := s.Handler()

	put := func(body string) {
		t.Helper()
		rr := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPut, "/api/settings", bytes.NewReader([]byte(body)))
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("%s: status %d body %s", body, rr.Code, rr.Body.String())
		}
	}

	// The store starts with no preference, so writing the same empty value is
	// not a change and must not churn the connection.
	put(`{"agent.default":""}`)
	if refreshes != 0 {
		t.Fatalf("an unchanged default refreshed the node %d time(s)", refreshes)
	}

	put(`{"agent.default":"claude-code"}`)
	if refreshes != 1 {
		t.Fatalf("changing the default refreshed the node %d time(s), want 1", refreshes)
	}

	// Saving the same value again is still not a change.
	put(`{"agent.default":"claude-code"}`)
	if refreshes != 1 {
		t.Fatalf("an unchanged default refreshed the node %d time(s), want 1", refreshes)
	}

	// Clearing it back to "no preference" is a change too.
	put(`{"agent.default":""}`)
	if refreshes != 2 {
		t.Fatalf("clearing the default refreshed the node %d time(s), want 2", refreshes)
	}

	// A write that does not touch the default leaves the connection alone.
	put(`{"ui.base_url":"http://example.test:7777"}`)
	if refreshes != 2 {
		t.Fatalf("an unrelated setting refreshed the node %d time(s), want 2", refreshes)
	}

	// The hook follows the write, not the whole request. A later failure (a
	// rejected relay URL) must not leave the Hub on the old default while a
	// retry compares equal and never refreshes.
	s.ConfigureRelay = func(context.Context, string) (RelayStatus, error) {
		return RelayStatus{}, errors.New("relay rejected")
	}
	body := `{"agent.default":"claude-code","relay.url":"http://relay.test"}`
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPut, "/api/settings", bytes.NewReader([]byte(body)))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("relay failure: status %d body %s", rr.Code, rr.Body.String())
	}
	if refreshes != 3 {
		t.Fatalf("a persisted default behind a relay failure refreshed %d time(s), want 3", refreshes)
	}
}
