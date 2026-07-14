package remote

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

func TestTokenRotateInvalidatesOld(t *testing.T) {
	dir := t.TempDir()
	old, err := EnsureToken(dir)
	if err != nil {
		t.Fatal(err)
	}
	auth := NewFileAuth(TokenFile(dir))
	h := auth.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`ok`))
	}))

	// Old token works.
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	req.Header.Set("Authorization", "Bearer "+old)
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("old token before rotate: %d", rr.Code)
	}

	newTok, err := RotateToken(dir)
	if err != nil {
		t.Fatal(err)
	}
	if newTok == old {
		t.Fatal("token did not change")
	}
	// File on disk matches.
	got, err := ReadToken(dir)
	if err != nil || got != newTok {
		t.Fatalf("ReadToken = %q err=%v", got, err)
	}

	// Old token → 401
	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/tasks", nil)
	req.Header.Set("Authorization", "Bearer "+old)
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("old token after rotate: %d, want 401", rr.Code)
	}

	// New token → 200
	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/tasks", nil)
	req.Header.Set("Authorization", "Bearer "+newTok)
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("new token: %d, want 200", rr.Code)
	}

	// Path sanity
	if filepath.Base(TokenFile(dir)) != "token" {
		t.Fatal(TokenFile(dir))
	}
}
