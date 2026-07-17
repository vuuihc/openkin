package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/vuuihc/kin/internal/store"
)

func TestArtifactsAPI(t *testing.T) {
	s, token := newTestServer(t)
	artifactsDir := t.TempDir()
	s.ArtifactsDir = artifactsDir
	h := s.Handler()

	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/artifacts", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("list empty: %d %s", rr.Code, rr.Body.String())
	}
	var list []any
	if err := json.Unmarshal(rr.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if len(list) != 0 {
		t.Fatalf("expected empty list, got %d items", len(list))
	}

	body := `{"title":"Test","kind":"markdown","content":"# Hello\nWorld","status":"saved"}`
	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/artifacts", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", rr.Code, rr.Body.String())
	}
	var created store.Artifact
	if err := json.Unmarshal(rr.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.ID == "" || created.Title != "Test" || created.Size != 13 {
		t.Fatalf("created=%+v", created)
	}

	relPath := artifactRelPath(created.ID, "markdown")
	absPath := filepath.Join(artifactsDir, relPath)
	if _, err := os.Stat(absPath); err != nil {
		t.Fatalf("artifact file missing: %v", err)
	}

	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/artifacts", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("list: %d %s", rr.Code, rr.Body.String())
	}
	var list2 []map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &list2); err != nil {
		t.Fatal(err)
	}
	if len(list2) != 1 || list2[0]["id"] != created.ID {
		t.Fatalf("list = %+v", list2)
	}

	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/artifacts/"+created.ID, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("get: %d %s", rr.Code, rr.Body.String())
	}

	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/artifacts/"+created.ID+"/content", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("content: %d %s", rr.Code, rr.Body.String())
	}
	if ct := rr.Header().Get("Content-Type"); !strings.Contains(ct, "text/plain") {
		t.Fatalf("Content-Type = %q, want text/plain", ct)
	}
	if rr.Body.String() != "# Hello\nWorld" {
		t.Fatalf("body = %q", rr.Body.String())
	}

	statusBody := `{"status":"archived"}`
	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/artifacts/"+created.ID+"/status", strings.NewReader(statusBody))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("set status: %d %s", rr.Code, rr.Body.String())
	}
	var updated store.Artifact
	if err := json.Unmarshal(rr.Body.Bytes(), &updated); err != nil {
		t.Fatal(err)
	}
	if updated.Status != "archived" {
		t.Fatalf("status = %q", updated.Status)
	}

	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/artifacts/nonexistent", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rr.Code)
	}
}

func TestArtifactsAPI503WhenNotConfigured(t *testing.T) {
	s, token := newTestServer(t)
	s.ArtifactsDir = ""
	h := s.Handler()

	body := `{"title":"T","kind":"text","content":"hello"}`
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/artifacts", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d body=%s", rr.Code, rr.Body.String())
	}
}

func TestArtifactsAPIRejectsInvalidKind(t *testing.T) {
	s, token := newTestServer(t)
	s.ArtifactsDir = t.TempDir()
	h := s.Handler()

	body := `{"title":"T","kind":"pdf","content":"x"}`
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/artifacts", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rr.Code)
	}
}

func TestArtifactsAPIAuthRequired(t *testing.T) {
	s, _ := newTestServer(t)
	s.ArtifactsDir = t.TempDir()
	h := s.Handler()

	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/artifacts", nil))
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rr.Code)
	}
}
