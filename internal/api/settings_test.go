package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/vuuihc/openkin/internal/notify"
)

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
	var got map[string]string
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
	got = map[string]string{}
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
	var got map[string]string
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got["relay.pairing_url"] != "https://relay.example.test?pairing=refreshed" {
		t.Fatalf("pairing URL=%q", got["relay.pairing_url"])
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
