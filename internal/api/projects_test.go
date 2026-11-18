package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/remote"
	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/task"
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

	// Creating a task with project_id injects One-Pager context (ADR 0013 recipes).
	createBody, _ := json.Marshal(map[string]any{
		"cwd":        repo,
		"prompt":     "continue focus",
		"project_id": id,
		"agent":      "claude-code",
	})
	req = httptest.NewRequest(http.MethodPost, "/api/tasks", bytes.NewReader(createBody))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusCreated {
		t.Fatalf("create task %d %s", rr.Code, rr.Body.String())
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
		t.Fatalf("create task prompt missing project inject: %q", prompt)
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

func TestProjectPulseRefresh(t *testing.T) {
	s, token := newTestServer(t)
	projectsDir := filepath.Join(t.TempDir(), "projects")
	s.ProjectsDir = projectsDir
	h := s.Handler()
	repo := filepath.Join(t.TempDir(), "repo")
	if err := os.MkdirAll(repo, 0o700); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]any{"path": repo, "name": "PulseDemo", "mode": "ship"})
	req := httptest.NewRequest(http.MethodPost, "/api/projects/ensure", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusCreated && rr.Code != http.StatusOK {
		t.Fatalf("ensure %d %s", rr.Code, rr.Body.String())
	}
	var proj map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &proj)
	id := proj["id"].(string)

	req = httptest.NewRequest(http.MethodGet, "/api/projects/"+id+"/pulse?window_days=30", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("pulse %d %s", rr.Code, rr.Body.String())
	}

	req = httptest.NewRequest(http.MethodPost, "/api/projects/"+id+"/pulse/refresh", bytes.NewReader([]byte(`{"window_days":30}`)))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("refresh %d %s", rr.Code, rr.Body.String())
	}
	var res map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &res)
	md, _ := res["markdown"].(string)
	if md == "" || !bytes.Contains([]byte(md), []byte("kin:auto:start")) {
		t.Fatalf("markdown missing auto block: %q", md)
	}
}

func TestFindProjectByRootIncludesSummary(t *testing.T) {
	s, token := newTestServer(t)
	projectsDir := t.TempDir()
	s.ProjectsDir = projectsDir
	h := s.Handler()

	repo := filepath.Join(t.TempDir(), "repo")
	if err := os.MkdirAll(repo, 0o700); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]any{"path": repo, "name": "SumDemo", "mode": "ship"})
	req := httptest.NewRequest(http.MethodPost, "/api/projects/ensure", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusCreated && rr.Code != http.StatusOK {
		t.Fatalf("ensure %d %s", rr.Code, rr.Body.String())
	}
	var proj map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &proj)
	id := proj["id"].(string)

	// Write a filled one-pager
	opReq := httptest.NewRequest(http.MethodGet, "/api/projects/"+id+"/one-pager", nil)
	opReq.Header.Set("Authorization", "Bearer "+token)
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, opReq)
	var op map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &op)
	md := op["markdown"].(string)
	// Replace focus section content by put
	md = strings.Replace(md, "当下唯一主线（越短越好）。", "Ship focus path", 1)
	md = strings.Replace(md, "你为什么做这个项目（用户主权；刷新不会改这里）。", "Users finish sessions with a cover update", 1)
	putBody, _ := json.Marshal(map[string]any{"markdown": md, "updated_at": int64(op["updated_at"].(float64))})
	req = httptest.NewRequest(http.MethodPut, "/api/projects/"+id+"/one-pager", bytes.NewReader(putBody))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("put %d %s", rr.Code, rr.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/projects/by-root?path="+repo, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("by-root %d %s", rr.Code, rr.Body.String())
	}
	var res map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &res)
	if res["id"] != id {
		t.Fatalf("id=%v", res["id"])
	}
	sum, _ := res["one_pager_summary"].(map[string]any)
	if sum == nil {
		t.Fatalf("missing summary: %v", res)
	}
	if sum["focus"] == "" && sum["north_star"] == "" {
		t.Fatalf("empty summary fields: %v", sum)
	}
}

// authContextForTest runs the real auth middleware and hands back the request
// context it built. It is how a test gets a principal without exporting the
// context key from internal/remote.
func authContextForTest(t *testing.T, s *Server, configure func(*http.Request)) context.Context {
	t.Helper()
	var ctx context.Context
	h := s.Auth.Middleware(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		ctx = r.Context()
	}))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	configure(req)
	h.ServeHTTP(httptest.NewRecorder(), req)
	if ctx == nil {
		t.Fatal("auth middleware stored no principal")
	}
	return ctx
}

// KIN-PROJECT-003: the work-instructions section travels with the rest of the
// project digest, and only for a caller who acts for the machine's holder.
func TestPrepareTaskCreateInjectsWorkInstructions(t *testing.T) {
	s, token := newTestServer(t)
	dir := t.TempDir()
	s.ProjectsDir = dir

	rel := filepath.Join("proj-work", "ONE_PAGER.md")
	abs := filepath.Join(dir, rel)
	if err := os.MkdirAll(filepath.Dir(abs), 0o700); err != nil {
		t.Fatal(err)
	}
	md := "# Demo\n\n## Current Focus\nship\n\n## 工作方式\n先跑 make test\n不要手改 generated/\n"
	if err := os.WriteFile(abs, []byte(md), 0o600); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UnixMilli()
	if err := s.Store.InsertProject(context.Background(), store.Project{
		ID:           "proj-work",
		Name:         "Demo",
		Mode:         store.ProjectModeShip,
		Status:       store.ProjectActive,
		OnePagerRel:  rel,
		CreatedAt:    now,
		UpdatedAt:    now,
		LastActiveAt: now,
	}, nil); err != nil {
		t.Fatal(err)
	}

	holderCtx := authContextForTest(t, s, func(req *http.Request) {
		req.Header.Set("Authorization", "Bearer "+token)
	})

	t.Run("KIN-PROJECT-003: the holder's task prompt carries the section", func(t *testing.T) {
		req := &task.CreateRequest{Prompt: "add a test", ProjectID: "proj-work"}
		PrepareTaskCreate(holderCtx, s.Store, dir, req)
		if !strings.Contains(req.Prompt, "How to work here:\n先跑 make test\n不要手改 generated/") {
			t.Fatalf("work instructions missing: %q", req.Prompt)
		}
		if req.UserPrompt != "add a test" {
			t.Fatalf("user prompt = %q", req.UserPrompt)
		}
	})

	t.Run("KIN-PROJECT-003: a member's task prompt does not carry it", func(t *testing.T) {
		s.Auth.SetSessionLookup(func(_ context.Context, session string) (remote.Principal, bool) {
			if session != "member-session" {
				return remote.Principal{}, false
			}
			return remote.Principal{Kind: remote.PrincipalUser, UserID: "user-member"}, true
		})
		memberCtx := authContextForTest(t, s, func(req *http.Request) {
			req.AddCookie(&http.Cookie{Name: remote.SessionCookieName, Value: "member-session"})
		})
		req := &task.CreateRequest{Prompt: "add a test", ProjectID: "proj-work"}
		PrepareTaskCreate(memberCtx, s.Store, dir, req)
		if req.Prompt != "add a test" {
			t.Fatalf("member prompt was rewritten: %q", req.Prompt)
		}
	})

	t.Run("KIN-PROJECT-003: a prompt that already carries project context is not injected twice", func(t *testing.T) {
		already := "[Project context — living cover digest; user owns goals]\n---\nadd a test"
		req := &task.CreateRequest{Prompt: already, ProjectID: "proj-work"}
		PrepareTaskCreate(holderCtx, s.Store, dir, req)
		if req.Prompt != already {
			t.Fatalf("prompt was injected twice: %q", req.Prompt)
		}
	})
}
