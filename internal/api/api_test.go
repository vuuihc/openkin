package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
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
	eng := task.NewEngine(st, map[string]adapter.Adapter{"claude-code": ad}, task.NewBus(), 4)
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
	eng := task.NewEngine(st, map[string]adapter.Adapter{"claude-code": ad}, task.NewBus(), 4)
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
