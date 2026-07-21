package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestProjectsOnePagerCRUD(t *testing.T) {
	s, token := newTestServer(t)
	projectsDir := filepath.Join(t.TempDir(), "projects")
	s.ProjectsDir = projectsDir
	h := s.Handler()

	repo := filepath.Join(t.TempDir(), "repo")
	if err := os.MkdirAll(repo, 0o700); err != nil {
		t.Fatal(err)
	}

	body, _ := json.Marshal(map[string]any{
		"name":  "Demo",
		"mode":  "learn",
		"roots": []string{repo},
	})
	req := httptest.NewRequest(http.MethodPost, "/api/projects", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", rr.Code, rr.Body.String())
	}
	var proj map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &proj); err != nil {
		t.Fatal(err)
	}
	id, _ := proj["id"].(string)
	if id == "" {
		t.Fatalf("no id: %v", proj)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/projects/"+id+"/one-pager", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("get one-pager %d %s", rr.Code, rr.Body.String())
	}
	var op map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &op); err != nil {
		t.Fatal(err)
	}
	md, _ := op["markdown"].(string)
	if md == "" || !bytes.Contains([]byte(md), []byte("# Demo")) {
		t.Fatalf("markdown=%q", md)
	}
	updatedAt, ok := op["updated_at"].(float64)
	if !ok {
		t.Fatalf("updated_at missing: %v", op)
	}

	putBody, _ := json.Marshal(map[string]any{
		"markdown":   md + "\n\n## Notes\nhello\n",
		"updated_at": int64(updatedAt),
	})
	req = httptest.NewRequest(http.MethodPut, "/api/projects/"+id+"/one-pager", bytes.NewReader(putBody))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("put %d %s", rr.Code, rr.Body.String())
	}

	// Continue requires cwd + engine — should create task linked to project.
	contBody, _ := json.Marshal(map[string]any{"cwd": repo})
	req = httptest.NewRequest(http.MethodPost, "/api/projects/"+id+"/continue", bytes.NewReader(contBody))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusCreated {
		t.Fatalf("continue %d %s", rr.Code, rr.Body.String())
	}
	var task map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &task); err != nil {
		t.Fatal(err)
	}
	if task["project_id"] != id {
		t.Fatalf("task project_id=%v want %s", task["project_id"], id)
	}
	prompt, _ := task["prompt"].(string)
	if prompt == "" || !bytes.Contains([]byte(prompt), []byte("Project: Demo")) {
		t.Fatalf("continue prompt missing context: %q", prompt)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/projects/"+id+"/tasks", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("list tasks %d %s", rr.Code, rr.Body.String())
	}
	var tasks []map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &tasks); err != nil {
		t.Fatal(err)
	}
	if len(tasks) != 1 {
		t.Fatalf("tasks=%v", tasks)
	}

	entries, err := os.ReadDir(projectsDir)
	if err != nil || len(entries) == 0 {
		t.Fatalf("expected on-disk project dir: %v %v", entries, err)
	}
}

func TestEnsureProjectIdempotent(t *testing.T) {
	s, token := newTestServer(t)
	projectsDir := filepath.Join(t.TempDir(), "projects")
	s.ProjectsDir = projectsDir
	h := s.Handler()

	repo := filepath.Join(t.TempDir(), "kin-repo")
	if err := os.MkdirAll(repo, 0o700); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]any{"path": repo, "mode": "ship"})
	req := httptest.NewRequest(http.MethodPost, "/api/projects/ensure", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusCreated && rr.Code != http.StatusOK {
		t.Fatalf("ensure1 %d %s", rr.Code, rr.Body.String())
	}
	var p1 map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &p1)
	id1 := p1["id"].(string)

	req = httptest.NewRequest(http.MethodPost, "/api/projects/ensure", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("ensure2 %d %s", rr.Code, rr.Body.String())
	}
	var p2 map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &p2)
	if p2["id"] != id1 {
		t.Fatalf("not idempotent: %v vs %v", p1["id"], p2["id"])
	}
}

func TestListProjectArtifacts(t *testing.T) {
	s, token := newTestServer(t)
	projectsDir := filepath.Join(t.TempDir(), "projects")
	s.ProjectsDir = projectsDir
	h := s.Handler()

	repo := filepath.Join(t.TempDir(), "repo")
	if err := os.MkdirAll(repo, 0o700); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]any{
		"name": "ArtProj", "mode": "ship", "roots": []string{repo},
	})
	req := httptest.NewRequest(http.MethodPost, "/api/projects", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusCreated {
		t.Fatalf("create %d %s", rr.Code, rr.Body.String())
	}
	var proj map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &proj)
	id := proj["id"].(string)

	// empty list
	req = httptest.NewRequest(http.MethodGet, "/api/projects/"+id+"/artifacts", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("list %d %s", rr.Code, rr.Body.String())
	}
	var list []any
	if err := json.Unmarshal(rr.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if len(list) != 0 {
		t.Fatalf("want empty, got %v", list)
	}
}
