package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/remote/worker"
)

func TestWorkerAPIScopesLeaseToDeviceAndRevocation(t *testing.T) {
	s, master := newTestServer(t)
	h := s.Handler()

	request := func(method, path, token string, body any) *httptest.ResponseRecorder {
		t.Helper()
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(method, path, bytes.NewReader(raw))
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}

	deviceToken, deviceID := pairDevice(t, h, master)
	hello := worker.Hello{
		Version:       worker.ProtocolVersion,
		WorkerID:      "remote-1",
		Capabilities:  []worker.Capability{{Name: "kin", Features: []string{"run"}}},
		MaxConcurrent: 1,
	}
	rec := request(http.MethodPost, "/api/workers/register", deviceToken, hello)
	if rec.Code != http.StatusCreated {
		t.Fatalf("register: %d %s", rec.Code, rec.Body.String())
	}
	var registered worker.Record
	if err := json.Unmarshal(rec.Body.Bytes(), &registered); err != nil {
		t.Fatal(err)
	}
	if registered.OwnerDeviceID != deviceID || registered.State != worker.StateOnline {
		t.Fatalf("registered = %+v", registered)
	}
	rec = request(http.MethodPost, "/api/workers/register", master, hello)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("master register: %d %s", rec.Code, rec.Body.String())
	}

	rec = request(http.MethodPost, "/api/workers/heartbeat", deviceToken, worker.Heartbeat{
		WorkerID: registered.WorkerID, LeaseID: registered.Lease.ID, At: time.Now().UnixMilli(),
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("heartbeat: %d %s", rec.Code, rec.Body.String())
	}

	rec = request(http.MethodGet, "/api/workers", deviceToken, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("device list: %d %s", rec.Code, rec.Body.String())
	}
	rec = request(http.MethodGet, "/api/workers", master, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("master list: %d %s", rec.Code, rec.Body.String())
	}

	otherToken, _ := pairDevice(t, h, master)
	rec = request(http.MethodPost, "/api/workers/heartbeat", otherToken, worker.Heartbeat{
		WorkerID: registered.WorkerID, LeaseID: registered.Lease.ID, At: time.Now().UnixMilli(),
	})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("cross-device heartbeat: %d %s", rec.Code, rec.Body.String())
	}

	rec = request(http.MethodPost, "/api/devices/"+deviceID+"/revoke", master, nil)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("revoke device: %d %s", rec.Code, rec.Body.String())
	}
	rec = request(http.MethodPost, "/api/workers/heartbeat", deviceToken, worker.Heartbeat{
		WorkerID: registered.WorkerID, LeaseID: registered.Lease.ID, At: time.Now().UnixMilli(),
	})
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("revoked device heartbeat: %d %s", rec.Code, rec.Body.String())
	}
	rec = request(http.MethodPost, "/api/workers/"+registered.WorkerID+"/revoke", master, nil)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("revoke worker: %d %s", rec.Code, rec.Body.String())
	}
}

func pairDevice(t *testing.T, h http.Handler, master string) (string, string) {
	t.Helper()
	request := func(method, path, token string, body any) *httptest.ResponseRecorder {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(method, path, bytes.NewReader(raw))
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	rec := request(http.MethodPost, "/api/pairing/sessions", master, map[string]string{"label": "worker"})
	if rec.Code != http.StatusCreated {
		t.Fatalf("pairing session: %d %s", rec.Code, rec.Body.String())
	}
	var session pairingSessionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &session); err != nil {
		t.Fatal(err)
	}
	rec = request(http.MethodPost, "/api/pairing/exchange", "", map[string]string{"secret": session.Secret})
	if rec.Code != http.StatusCreated {
		t.Fatalf("pairing exchange: %d %s", rec.Code, rec.Body.String())
	}
	var exchange pairingExchangeResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &exchange); err != nil {
		t.Fatal(err)
	}
	if exchange.Token == "" || exchange.DeviceID == "" {
		t.Fatalf("invalid exchange: %+v", exchange)
	}
	return exchange.Token, exchange.DeviceID
}
