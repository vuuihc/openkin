package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/vuuihc/kin/internal/provider"
	"github.com/vuuihc/kin/internal/store"
	"github.com/vuuihc/kin/internal/task"
)

type stubChatClient struct {
	content string
	err     error
}

func (c *stubChatClient) Chat(ctx context.Context, req provider.ChatRequest) (*provider.ChatResponse, error) {
	if c.err != nil {
		return nil, c.err
	}
	return &provider.ChatResponse{Content: c.content}, nil
}

func (c *stubChatClient) Kind() string         { return "stub" }
func (c *stubChatClient) ModelDefault() string { return "stub-model" }

func setupProjectTask(t *testing.T) (*Server, string, string, string, string) {
	t.Helper()
	s, token := newTestServer(t)
	projectsDir := t.TempDir()
	s.ProjectsDir = projectsDir
	h := s.Handler()

	repo := filepath.Join(t.TempDir(), "repo")
	if err := os.MkdirAll(repo, 0o700); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]any{"path": repo, "name": "RecycleDemo", "mode": "ship"})
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
	projectID := proj["id"].(string)

	// Create a task linked to project via engine (bypasses inject for control).
	tk, err := s.Engine.Create(context.Background(), task.CreateRequest{
		Agent:     "claude-code",
		Cwd:       repo,
		Prompt:    "implement recycle",
		ProjectID: projectID,
	})
	if err != nil {
		t.Fatal(err)
	}
	return s, token, projectID, tk.ID, repo
}

func TestRecycleGenerateAcceptIgnoreConflict(t *testing.T) {
	s, token, projectID, taskID, _ := setupProjectTask(t)
	h := s.Handler()

	modelJSON := `{
  "summary": "Built recycle path",
  "suggestions": [
    {"target":"conclusions","text":"Manual wrap-up writes cover via review","reason":"durable outcome","confidence":"high","evidence":[{"kind":"task","id":"` + taskID + `","label":"task"}]},
    {"target":"next","text":"Wire Task UI card","reason":"next step","confidence":"medium"},
    {"target":"focus","text":"Ship wrap-up review UX","reason":"focus shift","confidence":"medium"},
    {"target":"north_star","text":"should be dropped","reason":"x","confidence":"low"}
  ]
}`
	s.ProviderResolve = func(ctx context.Context) (provider.Client, provider.Config, error) {
		return &stubChatClient{content: modelJSON}, provider.Config{}, nil
	}

	// Generate
	req := httptest.NewRequest(http.MethodPost, "/api/tasks/"+taskID+"/recycle", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusCreated {
		t.Fatalf("generate %d %s", rr.Code, rr.Body.String())
	}
	var rec store.ProjectRecycle
	if err := json.Unmarshal(rr.Body.Bytes(), &rec); err != nil {
		t.Fatal(err)
	}
	if rec.ProjectID != projectID || rec.Status != store.RecycleStatusPending {
		t.Fatalf("rec=%+v", rec)
	}
	// north_star dropped; focus separate; ordinary <=3
	var focus, ordinary int
	for _, sug := range rec.Suggestions {
		if sug.Target == store.RecycleTargetFocus {
			focus++
		} else {
			ordinary++
		}
		if sug.Target == "north_star" {
			t.Fatal("north_star should not appear")
		}
	}
	if focus != 1 || ordinary < 1 || ordinary > 3 {
		t.Fatalf("focus=%d ordinary=%d sug=%+v", focus, ordinary, rec.Suggestions)
	}

	// GET recycle
	req = httptest.NewRequest(http.MethodGet, "/api/tasks/"+taskID+"/recycle", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("get %d %s", rr.Code, rr.Body.String())
	}

	// Accept first ordinary suggestion
	idx := 0
	for i, sug := range rec.Suggestions {
		if sug.Target != store.RecycleTargetFocus {
			idx = i
			break
		}
	}
	acceptBody, _ := json.Marshal(map[string]any{
		"final_text":           rec.Suggestions[idx].Text,
		"one_pager_updated_at": rec.BaseOnePagerUpdatedAt,
	})
	req = httptest.NewRequest(http.MethodPost, "/api/recycles/"+rec.ID+"/suggestions/"+itoa(idx)+"/accept", bytes.NewReader(acceptBody))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("accept %d %s", rr.Code, rr.Body.String())
	}
	var acceptRes map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &acceptRes)
	md, _ := acceptRes["markdown"].(string)
	if !strings.Contains(md, rec.Suggestions[idx].Text) {
		t.Fatalf("markdown missing accepted text: %s", md)
	}

	// Idempotent accept
	req = httptest.NewRequest(http.MethodPost, "/api/recycles/"+rec.ID+"/suggestions/"+itoa(idx)+"/accept", bytes.NewReader(acceptBody))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("idempotent accept %d %s", rr.Code, rr.Body.String())
	}

	// Conflict: stale version for another pending suggestion
	other := -1
	for i, sug := range rec.Suggestions {
		if i != idx && sug.Status == store.SuggestionPending || (i != idx && sug.Target != "") {
			// re-fetch rec
			break
		}
	}
	// Reload recycle for remaining pending
	req = httptest.NewRequest(http.MethodGet, "/api/tasks/"+taskID+"/recycle", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	_ = json.Unmarshal(rr.Body.Bytes(), &rec)
	for i, sug := range rec.Suggestions {
		if sug.Status == store.SuggestionPending {
			other = i
			break
		}
	}
	if other < 0 {
		t.Fatal("expected another pending suggestion")
	}
	// Stale base version
	staleBody, _ := json.Marshal(map[string]any{
		"final_text":           rec.Suggestions[other].Text,
		"one_pager_updated_at": int64(1),
	})
	req = httptest.NewRequest(http.MethodPost, "/api/recycles/"+rec.ID+"/suggestions/"+itoa(other)+"/accept", bytes.NewReader(staleBody))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusConflict {
		t.Fatalf("want 409 got %d %s", rr.Code, rr.Body.String())
	}

	// Ignore remaining with correct flow: ignore doesn't need version
	req = httptest.NewRequest(http.MethodPost, "/api/recycles/"+rec.ID+"/suggestions/"+itoa(other)+"/ignore", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("ignore %d %s", rr.Code, rr.Body.String())
	}

	// Invalid model output
	s.ProviderResolve = func(ctx context.Context) (provider.Client, provider.Config, error) {
		return &stubChatClient{content: "not-json"}, provider.Config{}, nil
	}
	req = httptest.NewRequest(http.MethodPost, "/api/tasks/"+taskID+"/recycle", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusBadGateway {
		t.Fatalf("want 502 for bad json got %d %s", rr.Code, rr.Body.String())
	}

	// Empty suggestions still creates batch
	s.ProviderResolve = func(ctx context.Context) (provider.Client, provider.Config, error) {
		return &stubChatClient{content: `{"summary":"nothing durable","suggestions":[]}`}, provider.Config{}, nil
	}
	req = httptest.NewRequest(http.MethodPost, "/api/tasks/"+taskID+"/recycle", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusCreated {
		t.Fatalf("empty generate %d %s", rr.Code, rr.Body.String())
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &rec)
	if rec.Status != store.RecycleStatusResolved {
		t.Fatalf("empty should resolve: %+v", rec)
	}

	// List project recycles
	req = httptest.NewRequest(http.MethodGet, "/api/projects/"+projectID+"/recycles", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("list %d %s", rr.Code, rr.Body.String())
	}
}

func TestCreateTaskInjectsProjectContext(t *testing.T) {
	s, token, _, _, repo := setupProjectTask(t)
	// Fill one-pager a bit
	// Find project by root to get id
	h := s.Handler()
	req := httptest.NewRequest(http.MethodGet, "/api/projects/by-root?path="+repo, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	var found map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &found)
	id := found["id"].(string)

	// Update one-pager focus
	req = httptest.NewRequest(http.MethodGet, "/api/projects/"+id+"/one-pager", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	var op map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &op)
	md := strings.Replace(op["markdown"].(string), "当下唯一主线（越短越好）。", "Context inject focus", 1)
	putBody, _ := json.Marshal(map[string]any{"markdown": md, "updated_at": int64(op["updated_at"].(float64))})
	req = httptest.NewRequest(http.MethodPut, "/api/projects/"+id+"/one-pager", bytes.NewReader(putBody))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	body, _ := json.Marshal(map[string]any{
		"agent":  "claude-code",
		"cwd":    repo,
		"prompt": "user goal only",
	})
	req = httptest.NewRequest(http.MethodPost, "/api/tasks", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusCreated {
		t.Fatalf("create %d %s", rr.Code, rr.Body.String())
	}
	var tk map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &tk)
	if tk["project_id"] != id {
		t.Fatalf("project_id=%v want %s", tk["project_id"], id)
	}
	prompt, _ := tk["prompt"].(string)
	if !strings.Contains(prompt, "Project: RecycleDemo") || !strings.Contains(prompt, "user goal only") {
		t.Fatalf("prompt missing inject: %q", prompt)
	}
	if !strings.Contains(prompt, "Context inject focus") {
		t.Fatalf("prompt missing focus: %q", prompt)
	}
}

func itoa(i int) string {
	return strconv.Itoa(i)
}
