package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/vuuihc/kin/internal/adapter"
	"github.com/vuuihc/kin/internal/remote"
	"github.com/vuuihc/kin/internal/store"
	"github.com/vuuihc/kin/internal/task"
)

type testAdapter struct {
	events []adapter.Event
}

type testHandle struct {
	ch       chan adapter.Event
	cancelCh chan struct{}
	canceled bool
}

func (h *testHandle) Events() <-chan adapter.Event { return h.ch }
func (h *testHandle) Cancel() error {
	if h.cancelCh == nil {
		return nil
	}
	if !h.canceled {
		h.canceled = true
		close(h.cancelCh)
	}
	return nil
}

func (a *testAdapter) Start(ctx context.Context, spec adapter.TaskSpec) (adapter.RunHandle, error) {
	ch := make(chan adapter.Event, 8)
	go func() {
		defer close(ch)
		for _, ev := range a.events {
			ch <- ev
		}
	}()
	return &testHandle{ch: ch, cancelCh: make(chan struct{})}, nil
}

func newTestServer(t *testing.T) (*Server, string) {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })

	const token = "aabbccdd00112233445566778899aabbccddeeff00112233445566778899aabb"
	ad := &testAdapter{events: []adapter.Event{
		{Type: "task_started", Payload: json.RawMessage(`{"session_id":"s","subtype":"init"}`)},
		{Type: "message", Payload: json.RawMessage(`{"role":"assistant","content":[{"type":"text","text":"ok"}],"partial":false}`)},
		{Type: "result", Payload: json.RawMessage(`{"cost_usd":0.02,"tokens_in":1,"tokens_out":2,"is_error":false}`)},
	}}
	eng := task.NewEngineFromAdapters(st, map[string]adapter.Adapter{"claude-code": ad}, task.NewBus(), 4)
	t.Cleanup(eng.Close)
	if err := eng.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}

	return &Server{
		Store:   st,
		Auth:    remote.NewAuth(token),
		Engine:  eng,
		Version: "test",
	}, token
}

func TestHealthAndTasks(t *testing.T) {
	s, token := newTestServer(t)
	h := s.Handler()

	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/health", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("health status %d", rr.Code)
	}

	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/tasks", nil))
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("tasks no auth: %d", rr.Code)
	}

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

func TestApprovalsAPI(t *testing.T) {
	s, token := newTestServer(t)
	// Use a holding adapter so we can request approval while running.
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	ad := &holdAPIAdapter{}
	eng := task.NewEngineFromAdapters(st, map[string]adapter.Adapter{"claude-code": ad}, task.NewBus(), 4)
	t.Cleanup(eng.Close)
	_ = eng.Recover(context.Background())
	s = &Server{Store: st, Auth: remote.NewAuth(token), Engine: eng, Version: "test"}
	h := s.Handler()

	// Create task.
	body := `{"agent":"claude-code","cwd":"/tmp","prompt":"hold"}`
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/tasks", bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", rr.Code, rr.Body.String())
	}
	var created store.Task
	_ = json.Unmarshal(rr.Body.Bytes(), &created)

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		tt, _ := eng.Get(context.Background(), created.ID)
		if tt.Status == "running" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	// Internal create approval.
	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/internal/approvals",
		bytes.NewBufferString(`{"task_id":"`+created.ID+`","kind":"tool_use","payload":{"tool_name":"Write","input":{"file_path":"a"}}}`))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = "127.0.0.1:12345"
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusCreated {
		t.Fatalf("internal create: %d %s", rr.Code, rr.Body.String())
	}
	var appr store.Approval
	_ = json.Unmarshal(rr.Body.Bytes(), &appr)

	// List pending.
	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/approvals?status=pending", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("list: %d", rr.Code)
	}
	var list []store.Approval
	_ = json.Unmarshal(rr.Body.Bytes(), &list)
	if len(list) != 1 || list[0].ID != appr.ID {
		t.Fatalf("list=%v", list)
	}
	if list[0].TaskTitle == "" {
		t.Fatal("expected task_title join")
	}

	// Decide approved.
	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/approvals/"+appr.ID+"/decision",
		bytes.NewBufferString(`{"decision":"approved"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("decide: %d %s", rr.Code, rr.Body.String())
	}

	// Follow-up while running interrupts and accepts the new guide prompt.
	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/tasks/"+created.ID+"/prompt",
		bytes.NewBufferString(`{"prompt":"more"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("follow-up while running: %d %s", rr.Code, rr.Body.String())
	}
}

type holdAPIAdapter struct{}

func (a *holdAPIAdapter) Start(ctx context.Context, spec adapter.TaskSpec) (adapter.RunHandle, error) {
	ch := make(chan adapter.Event, 4)
	h := &testHandle{ch: ch, cancelCh: make(chan struct{})}
	go func() {
		defer close(ch)
		ch <- adapter.Event{Type: "task_started", Payload: json.RawMessage(`{"session_id":"s","subtype":"init"}`)}
		select {
		case <-ctx.Done():
		case <-h.cancelCh:
		}
	}()
	return h, nil
}

func TestCreateAndGetTask(t *testing.T) {
	s, token := newTestServer(t)
	h := s.Handler()

	body := `{"agent":"claude-code","cwd":"/tmp","prompt":"hello world"}`
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/tasks", bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", rr.Code, rr.Body.String())
	}
	var created store.Task
	if err := json.Unmarshal(rr.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.ID == "" || created.Title != "hello world" {
		t.Fatalf("created=%+v", created)
	}

	// Wait for completion.
	deadline := time.Now().Add(2 * time.Second)
	var got store.Task
	for time.Now().Before(deadline) {
		rr = httptest.NewRecorder()
		req = httptest.NewRequest(http.MethodGet, "/api/tasks/"+created.ID, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("get: %d", rr.Code)
		}
		if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		if got.Status == "succeeded" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if got.Status != "succeeded" {
		t.Fatalf("status=%s", got.Status)
	}
	if got.CostUSD == nil || *got.CostUSD != 0.02 {
		t.Fatalf("cost=%v", got.CostUSD)
	}

	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/tasks/"+created.ID+"/events", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("events: %d %s", rr.Code, rr.Body.String())
	}
	var evs []store.Event
	if err := json.Unmarshal(rr.Body.Bytes(), &evs); err != nil {
		t.Fatal(err)
	}
	if len(evs) < 3 {
		t.Fatalf("events=%d", len(evs))
	}
}

func TestGzipOnTasks(t *testing.T) {
	s, token := newTestServer(t)
	h := s.Handler()

	req := httptest.NewRequest(http.MethodGet, "/api/tasks", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept-Encoding", "gzip")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
	if got := rr.Header().Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", got)
	}
}

func TestListAgentsExactlyOneDefault(t *testing.T) {
	s, token := newTestServer(t)
	// Provide a registry-backed list via ListAgents callback.
	s.ListAgents = func() []AgentInfo {
		return []AgentInfo{
			{ID: "claude-code", Name: "Claude Code", Available: true, Installed: true, Default: true, Kind: "cli", Capabilities: []string{"run"}},
			{ID: "codex", Name: "Codex", Available: true, Installed: true, Default: false, Kind: "cli", Capabilities: []string{"run"}},
		}
	}
	h := s.Handler()
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/agents", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
	var list []AgentInfo
	if err := json.NewDecoder(rr.Body).Decode(&list); err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 {
		t.Fatalf("len=%d", len(list))
	}
	var defaults int
	for _, a := range list {
		if a.Default {
			defaults++
		}
		if a.Kind == "" {
			t.Fatalf("missing kind on %s", a.ID)
		}
	}
	if defaults != 1 {
		t.Fatalf("defaults=%d", defaults)
	}
	if got := list[0].ModelListSource; got != "recommended" {
		t.Fatalf("claude model source=%q", got)
	}
	if got := list[0].Models; len(got) != 3 || got[0].ID != "opus" || got[1].ID != "sonnet" || got[2].ID != "haiku" {
		t.Fatalf("claude models=%+v", got)
	}
	if got := list[1].ModelListStatus; got != "default_only" || len(list[1].Models) != 0 {
		t.Fatalf("codex model list status=%q models=%+v", got, list[1].Models)
	}
}

func TestDeleteTask(t *testing.T) {
	s, token := newTestServer(t)
	h := s.Handler()

	body := `{"prompt":"delete me","cwd":"/tmp","agent":"claude-code"}`
	req := httptest.NewRequest(http.MethodPost, "/api/tasks", bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusCreated {
		t.Fatalf("create status %d body %s", rr.Code, rr.Body.String())
	}
	var created store.Task
	if err := json.Unmarshal(rr.Body.Bytes(), &created); err != nil {
		t.Fatalf("create decode: %v body %s", err, rr.Body.String())
	}
	if created.ID == "" {
		t.Fatal("empty task id")
	}

	// Wait for adapter to finish so Delete does not race the run loop.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		req = httptest.NewRequest(http.MethodGet, "/api/tasks/"+created.ID, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		rr = httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code == http.StatusOK {
			_ = json.Unmarshal(rr.Body.Bytes(), &created)
			if created.Status == "succeeded" || created.Status == "failed" || created.Status == "canceled" {
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
	}

	req = httptest.NewRequest(http.MethodDelete, "/api/tasks/"+created.ID, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusNoContent {
		t.Fatalf("delete status %d body %s", rr.Code, rr.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/tasks/"+created.ID, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusNotFound {
		t.Fatalf("get after delete: %d body %s", rr.Code, rr.Body.String())
	}

	req = httptest.NewRequest(http.MethodDelete, "/api/tasks/"+created.ID, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusNotFound {
		t.Fatalf("second delete: %d", rr.Code)
	}
}

func TestGenericCLIPermissionGate(t *testing.T) {
	s := &Server{}
	err := s.validateGenericCLIPermission(context.Background(), "gemini-cli", "default")
	if err == nil {
		t.Fatal("expected error for default mode")
	}
	if err := s.validateGenericCLIPermission(context.Background(), "gemini-cli", "yolo"); err != nil {
		t.Fatalf("yolo: %v", err)
	}
	if err := s.validateGenericCLIPermission(context.Background(), "gemini-cli", "accept_edits"); err != nil {
		t.Fatalf("accept_edits: %v", err)
	}
	if err := s.validateGenericCLIPermission(context.Background(), "claude-code", "default"); err != nil {
		t.Fatalf("native should pass: %v", err)
	}
	if err := s.validateGenericCLIPermission(context.Background(), "", "default"); err != nil {
		t.Fatalf("empty agent: %v", err)
	}
}

func TestAgentInfoInstallURLJSON(t *testing.T) {
	info := AgentInfo{ID: "cursor", Name: "Cursor", InstallURL: "https://cursor.com"}
	b, err := json.Marshal(info)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), `"install_url":"https://cursor.com"`) {
		t.Fatalf("json=%s", b)
	}
}


func TestUserQuestionsAPI(t *testing.T) {
	_, token := newTestServer(t)
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	ad := &holdAPIAdapter{}
	eng := task.NewEngineFromAdapters(st, map[string]adapter.Adapter{"claude-code": ad}, task.NewBus(), 4)
	t.Cleanup(eng.Close)
	_ = eng.Recover(context.Background())
	s := &Server{Store: st, Auth: remote.NewAuth(token), Engine: eng, Version: "test"}
	h := s.Handler()

	// Empty list is [] not null.
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/user-questions?status=pending", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("list empty: %d %s", rr.Code, rr.Body.String())
	}
	if rr.Body.String() != "[]\n" && rr.Body.String() != "[]" {
		// accept either with or without newline from encoder
		var list []store.UserQuestion
		if err := json.Unmarshal(rr.Body.Bytes(), &list); err != nil {
			t.Fatalf("list body=%s err=%v", rr.Body.String(), err)
		}
		if list == nil || len(list) != 0 {
			t.Fatalf("want empty slice, got %#v body=%s", list, rr.Body.String())
		}
	}

	// Create holding task.
	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/tasks",
		bytes.NewBufferString(`{"agent":"claude-code","cwd":"/tmp","prompt":"hold"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", rr.Code, rr.Body.String())
	}
	var created store.Task
	_ = json.Unmarshal(rr.Body.Bytes(), &created)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		tt, _ := eng.Get(context.Background(), created.ID)
		if tt.Status == "running" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	// Reject incomplete internal create.
	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/internal/user-questions",
		bytes.NewBufferString(`{"task_id":"`+created.ID+`","question":"only one?","options":[{"label":"A"}]}`))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = "127.0.0.1:12345"
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("want 400 for <2 options, got %d %s", rr.Code, rr.Body.String())
	}

	// Internal create.
	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/internal/user-questions",
		bytes.NewBufferString(`{"task_id":"`+created.ID+`","question":"Which auth?","header":"Auth","options":[{"label":"JWT"},{"label":"Session"}]}`))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = "127.0.0.1:12345"
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusCreated {
		t.Fatalf("internal create: %d %s", rr.Code, rr.Body.String())
	}
	var q store.UserQuestion
	_ = json.Unmarshal(rr.Body.Bytes(), &q)
	if q.Status != store.UQStatusPending {
		t.Fatalf("status=%s", q.Status)
	}

	// List pending with join.
	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/user-questions?status=pending", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("list: %d", rr.Code)
	}
	var list []store.UserQuestion
	_ = json.Unmarshal(rr.Body.Bytes(), &list)
	if len(list) != 1 || list[0].ID != q.ID {
		t.Fatalf("list=%v", list)
	}
	if list[0].TaskTitle == "" {
		t.Fatal("expected task_title join")
	}

	// Concurrent wait + answer.
	waitDone := make(chan store.UserQuestion, 1)
	waitErr := make(chan error, 1)
	go func() {
		rrw := httptest.NewRecorder()
		reqw := httptest.NewRequest(http.MethodGet, "/internal/user-questions/"+q.ID+"/wait?timeout=5", nil)
		reqw.Header.Set("Authorization", "Bearer "+token)
		reqw.RemoteAddr = "127.0.0.1:12345"
		h.ServeHTTP(rrw, reqw)
		if rrw.Code != http.StatusOK {
			waitErr <- fmt.Errorf("status %d: %s", rrw.Code, rrw.Body.String())
			return
		}
		var got store.UserQuestion
		_ = json.Unmarshal(rrw.Body.Bytes(), &got)
		waitDone <- got
	}()
	time.Sleep(50 * time.Millisecond)

	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/user-questions/"+q.ID+"/answer",
		bytes.NewBufferString(`{"selected":["JWT"]}`))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("answer: %d %s", rr.Code, rr.Body.String())
	}

	select {
	case err := <-waitErr:
		t.Fatalf("wait: %v", err)
	case got := <-waitDone:
		if got.Status != store.UQStatusAnswered {
			t.Fatalf("wait status=%s", got.Status)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("wait timed out")
	}

	// Second answer → 409.
	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/user-questions/"+q.ID+"/answer",
		bytes.NewBufferString(`{"selected":["Session"]}`))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusConflict {
		t.Fatalf("second answer: %d %s", rr.Code, rr.Body.String())
	}

	// Wait with short timeout on unanswered question returns pending.
	q2, err := eng.RequestUserQuestion(context.Background(), task.CreateUserQuestionRequest{
		TaskID: created.ID, Question: "Still?",
		Options: []task.UserQuestionOption{{Label: "Y"}, {Label: "N"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/internal/user-questions/"+q2.ID+"/wait?timeout=1", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.RemoteAddr = "127.0.0.1:12345"
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("wait pending: %d %s", rr.Code, rr.Body.String())
	}
	var pending store.UserQuestion
	_ = json.Unmarshal(rr.Body.Bytes(), &pending)
	if pending.Status != store.UQStatusPending {
		t.Fatalf("status=%s want pending", pending.Status)
	}
}

