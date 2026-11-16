package a2a

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
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

// a2aBlockingAdapter is the same shape as a2aAdapter but never finishes its turn
// on its own, which is the only state in which interrupt and queue differ. Cancel
// ends it the way a killed process would: an interrupt parks its follow-up until
// the turn it cut short is over, so an adapter that ignores Cancel would leave the
// test waiting for a turn that never ends.
type a2aBlockingAdapter struct{}
type a2aBlockingHandle struct {
	events chan adapter.Event
	once   sync.Once
}

func (h *a2aBlockingHandle) Events() <-chan adapter.Event { return h.events }
func (h *a2aBlockingHandle) Cancel() error {
	h.once.Do(func() { close(h.events) })
	return nil
}
func (a2aBlockingAdapter) Start(context.Context, adapter.TaskSpec) (adapter.RunHandle, error) {
	ch := make(chan adapter.Event, 1)
	ch <- adapter.Event{Type: "task_started", Payload: json.RawMessage(`{}`)}
	return &a2aBlockingHandle{events: ch}, nil
}

// A peer that could redirect a running task before this branch can still do it, and
// one that does not know the field keeps the queued behaviour: the flag is the whole
// difference between "answer this next" and "answer this when the turn ends", and it
// is the same switch MCP exposes.
func TestA2AFollowUpInterruptIsOptIn(t *testing.T) {
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	eng := task.NewEngineFromAdapters(st, map[string]adapter.Adapter{"claude-code": a2aBlockingAdapter{}}, task.NewBus(), 2)
	defer eng.Close()
	if err := eng.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	h := (&Server{Store: st, Engine: eng, Enabled: true, Version: "test"}).Handler()

	create := []byte(`{"idempotency_key":"mk","cwd":"/tmp","message":{"role":"user","parts":[{"kind":"text","text":"start"}]},"agent":"claude-code"}`)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/v1/tasks", bytes.NewReader(create)))
	if rr.Code != http.StatusAccepted && rr.Code != http.StatusOK {
		t.Fatalf("create status=%d body=%s", rr.Code, rr.Body.String())
	}
	var created struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &created)
	if created.ID == "" {
		t.Fatal("create returned no task id")
	}
	waitForA2AStatus(t, eng, created.ID, "running")

	post := func(key, text, interrupt string) *httptest.ResponseRecorder {
		body := []byte(`{"idempotency_key":"` + key + `","message":{"role":"user","parts":[{"kind":"text","text":"` + text + `"}]}` + interrupt + `}`)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/tasks/"+created.ID+":message", bytes.NewReader(body)))
		return rec
	}

	// Without the field: accepted, queued, and the task is still working on the
	// prompt it was given.
	if rec := post("q1", "queued one", ""); rec.Code != http.StatusAccepted {
		t.Fatalf("queued follow-up status=%d body=%s", rec.Code, rec.Body.String())
	}
	// The queue row is what makes this half discriminating. Reading the task's
	// prompt alone does not: an interrupting follow-up is *parked* and applied at
	// the turn boundary, so a route that interrupted unconditionally would still
	// answer "start" to a read taken straight after the POST -- the assertion
	// would pass for the wrong reason, and the only thing that would ever catch
	// it is a timing accident. A queued message has a durable row from the moment
	// the POST returns; an interrupt has only an in-memory park. So: the row, or
	// this test does not know the difference it claims to know.
	if queued, err := st.ListPendingPrompts(context.Background(), created.ID); err != nil {
		t.Fatal(err)
	} else if len(queued) != 1 || queued[0].Prompt != "queued one" {
		t.Fatalf("queue after a plain follow-up = %+v, want exactly the message that was sent", queued)
	}
	if got, err := eng.Get(context.Background(), created.ID); err != nil {
		t.Fatal(err)
	} else if got.Prompt != "start" {
		t.Fatalf("prompt after a queued follow-up = %q, want the turn in flight to be untouched", got.Prompt)
	}

	// With it: the running turn is cut short and this message is the one answered.
	if rec := post("i1", "answer this instead", `,"interrupt":true`); rec.Code != http.StatusAccepted {
		t.Fatalf("interrupting follow-up status=%d body=%s", rec.Code, rec.Body.String())
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		got, err := eng.Get(context.Background(), created.ID)
		if err != nil {
			t.Fatal(err)
		}
		// Containment, not equality: an interrupt hands the new turn the handoff
		// wrapper around the message, which is the engine's business, not this
		// route's. What this route decides is whether the message becomes the turn.
		if strings.Contains(got.Prompt, "answer this instead") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("prompt after an interrupting follow-up = %q, want the new message", got.Prompt)
		}
		time.Sleep(10 * time.Millisecond)
	}
	// And the interrupt queued nothing of its own: the message it carried became
	// the turn. The row still standing is the plain follow-up from above, which an
	// interrupt does not touch -- it cuts the turn short, it does not discard the
	// messages already waiting for one, so a route that queued *and* interrupted
	// would leave two rows here and be caught by the count.
	if queued, err := st.ListPendingPrompts(context.Background(), created.ID); err != nil {
		t.Fatal(err)
	} else if len(queued) != 1 || queued[0].Prompt != "queued one" {
		t.Fatalf("queue after an interrupting follow-up = %+v, want only the earlier queued message left waiting", queued)
	}
}

func waitForA2AStatus(t *testing.T, eng *task.Engine, id, want string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		got, err := eng.Get(context.Background(), id)
		if err != nil {
			t.Fatal(err)
		}
		if string(got.Status) == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("task status = %s, want %s", got.Status, want)
		}
		time.Sleep(10 * time.Millisecond)
	}
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
	tasks, err := st.ListTasks(context.Background(), store.ListTasksOpts{Scope: store.Unscoped(), Limit: 10})
	if err != nil || len(tasks) != 1 {
		t.Fatalf("tasks=%d err=%v", len(tasks), err)
	}
}
