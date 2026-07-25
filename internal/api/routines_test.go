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

type noopAdapter struct{}

func (noopAdapter) Start(ctx context.Context, spec adapter.TaskSpec) (adapter.RunHandle, error) {
	return noopHandle{}, nil
}

type noopHandle struct{}

func (noopHandle) Events() <-chan adapter.Event {
	ch := make(chan adapter.Event)
	close(ch)
	return ch
}
func (noopHandle) Cancel() error { return nil }

func newRoutinesTestServer(t *testing.T) (*Server, *store.Store) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	auth := remote.NewAuth("test-token")
	eng := task.NewEngineFromAdapters(st, map[string]adapter.Adapter{"kin": noopAdapter{}}, task.NewBus(), 2)
	t.Cleanup(eng.Close)
	s := &Server{Store: st, Auth: auth, Engine: eng, Version: "test"}
	return s, st
}

func TestRoutinesCRUDAndRunNow(t *testing.T) {
	s, _ := newRoutinesTestServer(t)
	h := s.Handler()

	body := `{"cwd":"/tmp/p","prompt":"check PRs","interval_secs":3600,"title":"PRs","agent":"kin"}`
	req := httptest.NewRequest(http.MethodPost, "/api/routines", bytes.NewReader([]byte(body)))
	req.Header.Set("Authorization", "Bearer test-token")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", rr.Code, rr.Body.String())
	}
	var created store.Routine
	if err := json.Unmarshal(rr.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.ID == "" || created.Title != "PRs" {
		t.Fatalf("created=%+v", created)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/routines", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("list status=%d", rr.Code)
	}

	// Pause
	req = httptest.NewRequest(http.MethodPatch, "/api/routines/"+created.ID, bytes.NewReader([]byte(`{"enabled":false}`)))
	req.Header.Set("Authorization", "Bearer test-token")
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("patch status=%d body=%s", rr.Code, rr.Body.String())
	}
	var patched store.Routine
	_ = json.Unmarshal(rr.Body.Bytes(), &patched)
	if patched.Enabled {
		t.Fatal("expected disabled")
	}

	// run-now
	req = httptest.NewRequest(http.MethodPost, "/api/routines/"+created.ID+"/run-now", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusCreated {
		t.Fatalf("run-now status=%d body=%s", rr.Code, rr.Body.String())
	}
	var run store.Task
	if err := json.Unmarshal(rr.Body.Bytes(), &run); err != nil {
		t.Fatal(err)
	}
	if run.RoutineID != created.ID {
		t.Fatalf("run routine_id=%q", run.RoutineID)
	}

	// delete
	req = httptest.NewRequest(http.MethodDelete, "/api/routines/"+created.ID, nil)
	req.Header.Set("Authorization", "Bearer test-token")
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusNoContent {
		t.Fatalf("delete status=%d", rr.Code)
	}

	// unread count endpoint
	req = httptest.NewRequest(http.MethodGet, "/api/routines/unread-count", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("unread status=%d body=%s", rr.Code, rr.Body.String())
	}
	_ = time.Second // silence unused in case
}

func TestMarkRoutineRunReadClearsUnread(t *testing.T) {
	s, st := newRoutinesTestServer(t)
	h := s.Handler()
	ctx := context.Background()
	now := time.Now().UnixMilli()

	if err := st.InsertRoutine(ctx, store.Routine{
		ID: "r1", Cwd: t.TempDir(), Agent: "kin", Prompt: "p",
		IntervalSecs: 60, Enabled: true, NextDueAt: now, CreatedAt: now, Title: "T",
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.InsertTask(ctx, store.Task{
		ID: "task-unread", Title: "run", Agent: "kin", Cwd: "/tmp", Prompt: "p",
		Status: "succeeded", CreatedAt: now, RoutineID: "r1",
		RoutineUnread: true, RoutineNoteworthy: true, RoutineTLDR: "hi",
	}); err != nil {
		t.Fatal(err)
	}

	// unread count = 1
	req := httptest.NewRequest(http.MethodGet, "/api/routines/unread-count", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("unread status=%d body=%s", rr.Code, rr.Body.String())
	}
	var count struct {
		Count int `json:"count"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &count)
	if count.Count != 1 {
		t.Fatalf("count=%d want 1", count.Count)
	}

	// mark read
	req = httptest.NewRequest(http.MethodPost, "/api/routines/runs/task-unread/read", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("mark-read status=%d body=%s", rr.Code, rr.Body.String())
	}
	var task store.Task
	if err := json.Unmarshal(rr.Body.Bytes(), &task); err != nil {
		t.Fatal(err)
	}
	if task.RoutineUnread {
		t.Fatalf("response still unread: %+v", task)
	}
	// JSON must include routine_unread:false (not omitempty-elided)
	if !bytes.Contains(rr.Body.Bytes(), []byte(`"routine_unread":false`)) {
		t.Fatalf("body missing routine_unread false: %s", rr.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/routines/unread-count", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	_ = json.Unmarshal(rr.Body.Bytes(), &count)
	if count.Count != 0 {
		t.Fatalf("count after mark=%d want 0", count.Count)
	}
}
