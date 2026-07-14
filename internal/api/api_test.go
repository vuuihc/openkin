package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/vuuihc/kin/internal/remote"
	"github.com/vuuihc/kin/internal/store"
)

func TestHealthAndTasks(t *testing.T) {
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	const token = "aabbccdd00112233445566778899aabbccddeeff00112233445566778899aabb"
	s := &Server{
		Store:   st,
		Auth:    remote.NewAuth(token),
		Version: "test",
	}
	h := s.Handler()

	// Health — no auth
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/health", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("health status %d", rr.Code)
	}
	var health map[string]bool
	if err := json.Unmarshal(rr.Body.Bytes(), &health); err != nil {
		t.Fatal(err)
	}
	if !health["ok"] {
		t.Fatalf("health body: %s", rr.Body.String())
	}

	// Tasks without token — 401
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/tasks", nil))
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("tasks no auth: %d", rr.Code)
	}

	// Tasks with token — []
	rr = httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/tasks", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("tasks auth: %d body %s", rr.Code, rr.Body.String())
	}
	var tasks []any
	if err := json.Unmarshal(rr.Body.Bytes(), &tasks); err != nil {
		t.Fatal(err)
	}
	if len(tasks) != 0 {
		t.Fatalf("want empty list, got %v", tasks)
	}
}
