package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/vuuihc/kin/internal/remote"
	"github.com/vuuihc/kin/internal/terminal"
)

const terminalTestToken = "terminal-test-token"

func newTerminalTestServer(t *testing.T, profiles []terminal.Profile) *Server {
	t.Helper()
	manager := terminal.NewManager(profiles)
	t.Cleanup(func() { _ = manager.Close() })
	return &Server{
		Auth:      remote.NewAuth(terminalTestToken),
		Terminals: manager,
	}
}

func terminalRequest(method, path, body, remoteAddr string, authenticated bool) *http.Request {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.RemoteAddr = remoteAddr
	if authenticated {
		req.Header.Set("Authorization", "Bearer "+terminalTestToken)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	return req
}

func TestTerminalLoopbackBoundary(t *testing.T) {
	server := newTerminalTestServer(t, []terminal.Profile{{ID: "sh", Name: "sh", Executable: "/bin/sh"}})
	handler := server.Handler()

	t.Run("loopback still requires token", func(t *testing.T) {
		rr := httptest.NewRecorder()
		handler.ServeHTTP(rr, terminalRequest(http.MethodGet, "/api/terminal/profiles", "", "127.0.0.1:1234", false))
		if rr.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want %d; body = %s", rr.Code, http.StatusUnauthorized, rr.Body.String())
		}
	})

	remoteRoutes := []struct {
		method string
		path   string
		body   string
	}{
		{http.MethodGet, "/api/terminal/profiles", ""},
		{http.MethodGet, "/api/terminal/sessions", ""},
		{http.MethodPost, "/api/terminal/sessions", `{}`},
		{http.MethodDelete, "/api/terminal/sessions/missing", ""},
		{http.MethodGet, "/api/terminal/sessions/missing/ws", ""},
	}
	for _, route := range remoteRoutes {
		t.Run(route.method+" "+route.path, func(t *testing.T) {
			rr := httptest.NewRecorder()
			handler.ServeHTTP(rr, terminalRequest(route.method, route.path, route.body, "192.0.2.10:1234", true))
			if rr.Code != http.StatusForbidden {
				t.Fatalf("status = %d, want %d; body = %s", rr.Code, http.StatusForbidden, rr.Body.String())
			}
		})
	}

	t.Run("forwarded loopback cannot unlock remote peer", func(t *testing.T) {
		rr := httptest.NewRecorder()
		req := terminalRequest(http.MethodGet, "/api/terminal/profiles", "", "192.0.2.10:1234", true)
		req.Header.Set("X-Forwarded-For", "127.0.0.1")
		handler.ServeHTTP(rr, req)
		if rr.Code != http.StatusForbidden {
			t.Fatalf("status = %d, want %d; body = %s", rr.Code, http.StatusForbidden, rr.Body.String())
		}
	})

	t.Run("forwarded remote cannot revoke loopback peer", func(t *testing.T) {
		rr := httptest.NewRecorder()
		req := terminalRequest(http.MethodGet, "/api/terminal/profiles", "", "127.0.0.1:1234", true)
		req.Header.Set("X-Forwarded-For", "192.0.2.10")
		handler.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("status = %d, want %d; body = %s", rr.Code, http.StatusOK, rr.Body.String())
		}
	})
}

func TestTerminalRESTProfilesAndEmptyLists(t *testing.T) {
	server := newTerminalTestServer(t, []terminal.Profile{{
		ID: "sh", Name: "sh", Executable: "/bin/sh", Args: []string{"-l"}, Default: true,
	}})
	handler := server.Handler()

	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, terminalRequest(http.MethodGet, "/api/terminal/profiles", "", "127.0.0.1:1234", true))
	if rr.Code != http.StatusOK {
		t.Fatalf("profiles status = %d; body = %s", rr.Code, rr.Body.String())
	}
	if bytes.Contains(rr.Body.Bytes(), []byte(`"args"`)) {
		t.Fatalf("profiles response exposed args: %s", rr.Body.String())
	}
	var profiles struct {
		Profiles         []terminal.Profile `json:"profiles"`
		DefaultProfileID string             `json:"default_profile_id"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &profiles); err != nil {
		t.Fatal(err)
	}
	if len(profiles.Profiles) != 1 || profiles.DefaultProfileID != "sh" {
		t.Fatalf("profiles response = %+v", profiles)
	}

	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, terminalRequest(http.MethodGet, "/api/terminal/sessions", "", "127.0.0.1:1234", true))
	if rr.Code != http.StatusOK || strings.TrimSpace(rr.Body.String()) != "[]" {
		t.Fatalf("empty sessions response = %d %s, want 200 []", rr.Code, rr.Body.String())
	}

	empty := newTerminalTestServer(t, nil)
	rr = httptest.NewRecorder()
	empty.Handler().ServeHTTP(rr, terminalRequest(http.MethodGet, "/api/terminal/profiles", "", "127.0.0.1:1234", true))
	if rr.Code != http.StatusOK || !strings.Contains(rr.Body.String(), `"profiles":[]`) {
		t.Fatalf("empty profiles response = %d %s", rr.Code, rr.Body.String())
	}
}

func TestTerminalRESTCreateListAndDelete(t *testing.T) {
	server := newTerminalTestServer(t, []terminal.Profile{{ID: "sh", Name: "sh", Executable: "/bin/sh", Default: true}})
	handler := server.Handler()
	body := map[string]any{"profile_id": "sh", "cwd": t.TempDir(), "cols": 80, "rows": 24}
	encoded, _ := json.Marshal(body)

	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, terminalRequest(http.MethodPost, "/api/terminal/sessions", string(encoded), "127.0.0.1:1234", true))
	if rr.Code != http.StatusCreated {
		t.Fatalf("create status = %d; body = %s", rr.Code, rr.Body.String())
	}
	var created terminal.SessionInfo
	if err := json.Unmarshal(rr.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.ID == "" || created.ProfileID != "sh" {
		t.Fatalf("created session = %+v", created)
	}

	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, terminalRequest(http.MethodGet, "/api/terminal/sessions", "", "127.0.0.1:1234", true))
	if rr.Code != http.StatusOK {
		t.Fatalf("list status = %d; body = %s", rr.Code, rr.Body.String())
	}
	var sessions []terminal.SessionInfo
	if err := json.Unmarshal(rr.Body.Bytes(), &sessions); err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 1 || sessions[0].ID != created.ID {
		t.Fatalf("sessions = %+v, want created session", sessions)
	}

	for i := 0; i < 2; i++ {
		rr = httptest.NewRecorder()
		handler.ServeHTTP(rr, terminalRequest(http.MethodDelete, "/api/terminal/sessions/"+created.ID, "", "127.0.0.1:1234", true))
		if rr.Code != http.StatusNoContent {
			t.Fatalf("delete attempt %d status = %d; body = %s", i+1, rr.Code, rr.Body.String())
		}
	}
}

func TestTerminalRESTCreateErrorMapping(t *testing.T) {
	server := newTerminalTestServer(t, []terminal.Profile{{ID: "sh", Name: "sh", Executable: "/bin/sh"}})
	handler := server.Handler()
	cwd := t.TempDir()
	tests := []struct {
		name string
		body map[string]any
		want int
	}{
		{"unknown profile", map[string]any{"profile_id": "missing", "cwd": cwd, "cols": 80, "rows": 24}, http.StatusBadRequest},
		{"missing cwd", map[string]any{"profile_id": "sh", "cwd": cwd + "/missing", "cols": 80, "rows": 24}, http.StatusBadRequest},
		{"invalid size", map[string]any{"profile_id": "sh", "cwd": cwd, "cols": 0, "rows": 24}, http.StatusBadRequest},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			encoded, _ := json.Marshal(tt.body)
			rr := httptest.NewRecorder()
			handler.ServeHTTP(rr, terminalRequest(http.MethodPost, "/api/terminal/sessions", string(encoded), "127.0.0.1:1234", true))
			if rr.Code != tt.want {
				t.Fatalf("status = %d, want %d; body = %s", rr.Code, tt.want, rr.Body.String())
			}
		})
	}

	for i := 0; i < terminal.MaxSessions; i++ {
		body, _ := json.Marshal(map[string]any{"profile_id": "sh", "cwd": cwd, "cols": 80, "rows": 24})
		rr := httptest.NewRecorder()
		handler.ServeHTTP(rr, terminalRequest(http.MethodPost, "/api/terminal/sessions", string(body), "127.0.0.1:1234", true))
		if rr.Code != http.StatusCreated {
			t.Fatalf("create %d status = %d; body = %s", i+1, rr.Code, rr.Body.String())
		}
	}
	bodyAtLimit, _ := json.Marshal(map[string]any{"profile_id": "sh", "cwd": cwd, "cols": 80, "rows": 24})
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, terminalRequest(http.MethodPost, "/api/terminal/sessions", string(bodyAtLimit), "127.0.0.1:1234", true))
	if rr.Code != http.StatusTooManyRequests {
		t.Fatalf("session limit status = %d, want %d; body = %s", rr.Code, http.StatusTooManyRequests, rr.Body.String())
	}
}

func TestTerminalRESTUnavailable(t *testing.T) {
	server := &Server{Auth: remote.NewAuth(terminalTestToken)}
	rr := httptest.NewRecorder()
	server.Handler().ServeHTTP(rr, terminalRequest(http.MethodGet, "/api/terminal/profiles", "", "127.0.0.1:1234", true))
	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d; body = %s", rr.Code, http.StatusServiceUnavailable, rr.Body.String())
	}
}

func TestTerminalRESTStartupFailureIsInternalError(t *testing.T) {
	server := newTerminalTestServer(t, []terminal.Profile{{
		ID: "missing", Name: "missing", Executable: "/definitely/not/a/kin-shell",
	}})
	body, _ := json.Marshal(map[string]any{
		"profile_id": "missing", "cwd": t.TempDir(), "cols": 80, "rows": 24,
	})
	rr := httptest.NewRecorder()
	server.Handler().ServeHTTP(rr, terminalRequest(http.MethodPost, "/api/terminal/sessions", string(body), "127.0.0.1:1234", true))
	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want %d; body = %s", rr.Code, http.StatusInternalServerError, rr.Body.String())
	}
}
