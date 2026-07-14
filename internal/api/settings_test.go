package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
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
