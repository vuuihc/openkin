package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDevicePairingScopesAndRevocation(t *testing.T) {
	s, master := newTestServer(t)
	h := s.Handler()

	request := func(method, path, token, body string) *httptest.ResponseRecorder {
		t.Helper()
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		req.Header.Set("Content-Type", "application/json")
		h.ServeHTTP(rec, req)
		return rec
	}

	rec := request(http.MethodPost, "/api/pairing/sessions", master, `{"label":"phone"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create pairing session: %d %s", rec.Code, rec.Body.String())
	}
	var pairing pairingSessionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &pairing); err != nil {
		t.Fatal(err)
	}
	if pairing.Secret == "" || pairing.ExpiresAt <= 0 {
		t.Fatalf("invalid pairing response: %+v", pairing)
	}

	rec = request(http.MethodPost, "/api/pairing/exchange", "", `{"secret":"`+pairing.Secret+`"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("exchange: %d %s", rec.Code, rec.Body.String())
	}
	var exchanged pairingExchangeResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &exchanged); err != nil {
		t.Fatal(err)
	}
	if exchanged.Token == "" || exchanged.DeviceID == "" {
		t.Fatalf("invalid device response: %+v", exchanged)
	}

	// One-time pairing secrets cannot be replayed.
	rec = request(http.MethodPost, "/api/pairing/exchange", "", `{"secret":"`+pairing.Secret+`"}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("replayed pairing secret: %d %s", rec.Code, rec.Body.String())
	}
	req := httptest.NewRequest(http.MethodPost, "/api/pairing/exchange", bytes.NewBufferString(`{"secret":"`+pairing.Secret+`"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Kin-Pairing-Recovery", "1")
	recovery := httptest.NewRecorder()
	h.ServeHTTP(recovery, req)
	if recovery.Code != http.StatusOK {
		t.Fatalf("pairing recovery: %d %s", recovery.Code, recovery.Body.String())
	}
	var recovered pairingExchangeResponse
	if err := json.Unmarshal(recovery.Body.Bytes(), &recovered); err != nil {
		t.Fatal(err)
	}
	if recovered.Token != exchanged.Token || recovered.DeviceID != exchanged.DeviceID {
		t.Fatalf("recovery returned different credential: %+v", recovered)
	}

	rec = request(http.MethodGet, "/api/tasks", exchanged.Token, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("device task read: %d %s", rec.Code, rec.Body.String())
	}
	rec = request(http.MethodGet, "/api/settings", exchanged.Token, "")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("device settings access: %d %s", rec.Code, rec.Body.String())
	}
	rec = request(http.MethodDelete, "/api/tasks/does-not-exist", exchanged.Token, "")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("device task delete access: %d %s", rec.Code, rec.Body.String())
	}
	for _, path := range []string{
		"/api/terminal/profiles",
		"/api/providers",
	} {
		rec = request(http.MethodGet, path, exchanged.Token, "")
		if rec.Code != http.StatusForbidden {
			t.Fatalf("device %s access: %d %s", path, rec.Code, rec.Body.String())
		}
	}
	rec = request(http.MethodGet, "/api/devices", exchanged.Token, "")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("device management access: %d %s", rec.Code, rec.Body.String())
	}

	rec = request(http.MethodPost, "/api/devices/"+exchanged.DeviceID+"/revoke", master, "")
	if rec.Code != http.StatusNoContent {
		t.Fatalf("revoke device: %d %s", rec.Code, rec.Body.String())
	}
	rec = request(http.MethodGet, "/api/tasks", exchanged.Token, "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("revoked device access: %d %s", rec.Code, rec.Body.String())
	}
}
