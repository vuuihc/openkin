package remote

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestEnsureTokenCreatesAndReuses(t *testing.T) {
	dir := t.TempDir()
	tok1, err := EnsureToken(dir)
	if err != nil {
		t.Fatalf("EnsureToken: %v", err)
	}
	if len(tok1) != 64 { // 32 bytes hex
		t.Fatalf("token len = %d, want 64", len(tok1))
	}
	tok2, err := EnsureToken(dir)
	if err != nil {
		t.Fatalf("EnsureToken reuse: %v", err)
	}
	if tok1 != tok2 {
		t.Fatalf("token changed on second call")
	}
	data, err := os.ReadFile(filepath.Join(dir, "token"))
	if err != nil {
		t.Fatal(err)
	}
	if got := string(data[:len(tok1)]); got != tok1 {
		t.Fatalf("file token = %q, want %q", got, tok1)
	}
}

func TestAuthMiddleware(t *testing.T) {
	const token = "aabbccdd00112233445566778899aabbccddeeff00112233445566778899aabb"
	a := NewAuth(token)
	h := a.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, ok := TokenFromContext(r.Context())
		if !ok || got != token {
			t.Fatalf("TokenFromContext = %q, %v; want request token", got, ok)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`[]`))
	}))

	// No token → 401
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/tasks", nil))
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("no token: status %d, want 401", rr.Code)
	}
	if got := rr.Result().Header.Values("WWW-Authenticate"); len(got) != 1 {
		t.Fatalf("WWW-Authenticate headers = %v, want one", got)
	}

	// Bearer → 200
	rr = httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/tasks", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("bearer: status %d, want 200", rr.Code)
	}

	// ?token= → 200
	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/tasks?token="+token, nil)
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("query token: status %d, want 200", rr.Code)
	}

	// Wrong token → 401
	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/tasks", nil)
	req.Header.Set("Authorization", "Bearer wrong")
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("wrong token: status %d, want 401", rr.Code)
	}
}

func TestAuthMiddlewareStoresDeviceTokenInContext(t *testing.T) {
	const deviceToken = "device-token"
	a := NewAuth("master-token")
	a.SetDeviceLookup(func(_ context.Context, token string) (Principal, bool) {
		if token != deviceToken {
			return Principal{}, false
		}
		return Principal{Kind: PrincipalDevice, DeviceID: "dev-1", Label: "Phone"}, true
	})
	h := a.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, ok := PrincipalFromContext(r.Context())
		if !ok || principal.Kind != PrincipalDevice || principal.DeviceID != "dev-1" {
			t.Fatalf("PrincipalFromContext = %+v, %v", principal, ok)
		}
		got, ok := TokenFromContext(r.Context())
		if !ok || got != deviceToken {
			t.Fatalf("TokenFromContext = %q, %v; want device token", got, ok)
		}
		w.WriteHeader(http.StatusOK)
	}))

	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/tasks", nil)
	req.Header.Set("Authorization", "Bearer "+deviceToken)
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("device token: status %d, want 200", rr.Code)
	}
}
