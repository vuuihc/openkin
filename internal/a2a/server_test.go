package a2a

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/task"
)

type a2aAdapter struct{}
type a2aHandle struct{ events chan adapter.Event }

func (h *a2aHandle) Events() <-chan adapter.Event { return h.events }
func (h *a2aHandle) Cancel() error                { return nil }
func (a2aAdapter) Start(context.Context, adapter.TaskSpec) (adapter.RunHandle, error) {
	ch := make(chan adapter.Event, 2)
	ch <- adapter.Event{Type: "task_started", Payload: json.RawMessage(`{}`)}
	ch <- adapter.Event{Type: "result", Payload: json.RawMessage(`{"is_error":false}`)}
	close(ch)
	return &a2aHandle{events: ch}, nil
}

func TestA2AIdempotencyAndCard(t *testing.T) {
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	eng := task.NewEngineFromAdapters(st, map[string]adapter.Adapter{"claude-code": a2aAdapter{}}, task.NewBus(), 2)
	defer eng.Close()
	if err := eng.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	h := (&Server{Store: st, Engine: eng, Enabled: true, Version: "test"}).Handler()
	req := httptest.NewRequest(http.MethodGet, "/.well-known/agent-card.json", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("card status=%d", rr.Code)
	}

	body := []byte(`{"idempotency_key":"same","cwd":"/tmp","message":{"role":"user","parts":[{"kind":"text","text":"hello"}]},"agent":"claude-code"}`)
	var first, second struct {
		ID string `json:"id"`
	}
	for i := 0; i < 2; i++ {
		req = httptest.NewRequest(http.MethodPost, "/v1/tasks", bytes.NewReader(body))
		rr = httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusAccepted && rr.Code != http.StatusOK {
			t.Fatalf("create status=%d body=%s", rr.Code, rr.Body.String())
		}
		if i == 0 {
			_ = json.Unmarshal(rr.Body.Bytes(), &first)
		} else {
			_ = json.Unmarshal(rr.Body.Bytes(), &second)
		}
	}
	if first.ID == "" || first.ID != second.ID {
		t.Fatalf("idempotency ids=%q/%q", first.ID, second.ID)
	}
	time.Sleep(20 * time.Millisecond)
	tasks, err := st.ListTasks(context.Background(), store.ListTasksOpts{Limit: 10})
	if err != nil || len(tasks) != 1 {
		t.Fatalf("tasks=%d err=%v", len(tasks), err)
	}
}
