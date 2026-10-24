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
	s.DesktopID = "desktop_1234abcd"
	s.DesktopName = "Work Mac"
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
	if exchanged.DesktopID != "desktop_1234abcd" || exchanged.DesktopName != "Work Mac" {
		t.Fatalf("desktop identity missing from exchange: %+v", exchanged)
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
	if recovered.DesktopID != exchanged.DesktopID || recovered.DesktopName != exchanged.DesktopName {
		t.Fatalf("recovery returned different desktop identity: %+v", recovered)
	}

	rec = request(http.MethodGet, "/api/version", exchanged.Token, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("device version read: %d %s", rec.Code, rec.Body.String())
	}
	var version map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &version); err != nil {
		t.Fatal(err)
	}
	if version["desktop_id"] != exchanged.DesktopID || version["desktop_name"] != exchanged.DesktopName {
		t.Fatalf("device version missing desktop identity: %#v", version)
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

// A console that arrived through a pairing link is a device — that is what the
// exchange mints — so the machines it can send work to have to be readable by
// one. A picker fed by the operator-only device list collapses to the one
// machine serving the page, which is the whole feature; the management view of
// the same rows stays the operator's.
func TestAPairedDeviceCanDiscoverMachinesButNotManageThem(t *testing.T) {
	// The machine plumbing, because becoming a machine is the thing under test:
	// a paired device is a console until it dials in.
	s, master, conns := machinesServer(t)
	s.DesktopID = "desktop_1234abcd"
	s.DesktopName = "Work Mac"
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

	token, id := pairDevice(t, h, master)

	// Pairing makes a console, not a machine. The phone reading this list is
	// itself a paired device, so a list that offers every device offers the
	// person the one they are holding — offline, and unable to run anything.
	machines := listMachines(t, s.Handler(), token)
	if len(machines) != 0 {
		t.Fatalf("machines = %+v, want none: nothing has dialled in yet", machines)
	}

	// Saying hello is what makes it a machine this Hub can hand a turn to.
	hub := httptest.NewServer(s.Handler())
	defer hub.Close()
	startResponder(t, hub.URL, token, t.TempDir())
	awaitConnected(t, conns, id)

	machines = listMachines(t, s.Handler(), token)
	if len(machines) != 1 || machines[0].ID != id {
		t.Fatalf("machines = %+v, want the machine that dialled in", machines)
	}
	if machines[0].Reachability == "" {
		t.Fatalf("machine %s is offered with no reachability: %+v", id, machines[0])
	}
	// The same row, read as management, says why it counts as a machine.
	if rec := request(http.MethodGet, "/api/devices", master, ""); rec.Code != http.StatusOK {
		t.Fatalf("device list: %d %s", rec.Code, rec.Body.String())
	} else {
		var devices []deviceResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &devices); err != nil {
			t.Fatal(err)
		}
		var role string
		for _, device := range devices {
			if device.ID == id {
				role = device.Role
			}
		}
		if role != "node" {
			t.Fatalf("role = %q, want the hello to have made it a node", role)
		}
	}

	// The same rows, read as management, are still the operator's.
	if rec := request(http.MethodGet, "/api/devices", token, ""); rec.Code != http.StatusForbidden {
		t.Fatalf("device management access: %d %s", rec.Code, rec.Body.String())
	}
	if rec := request(http.MethodPost, "/api/devices/"+id+"/revoke", token, ""); rec.Code != http.StatusForbidden {
		t.Fatalf("device revoke access: %d %s", rec.Code, rec.Body.String())
	}

	// A machine taken off this Hub is not a place work can go, so it is left out
	// rather than reported and filtered by the console that has to name one.
	if rec := request(http.MethodPost, "/api/devices/"+id+"/revoke", master, ""); rec.Code != http.StatusNoContent {
		t.Fatalf("revoke device: %d %s", rec.Code, rec.Body.String())
	}
	for _, machine := range listMachines(t, s.Handler(), master) {
		if machine.ID == id {
			t.Fatalf("a revoked machine is still offered as somewhere work can go: %+v", machine)
		}
	}
}

// listMachines reads the machine list as one principal and requires it to answer.
func listMachines(t *testing.T, h http.Handler, token string) []machineResponse {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/machines", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("machine list: %d %s", rec.Code, rec.Body.String())
	}
	var machines []machineResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &machines); err != nil {
		t.Fatal(err)
	}
	return machines
}
