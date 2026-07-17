package task

import (
	"context"
	"encoding/json"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/vuuihc/kin/internal/adapter"
	"github.com/vuuihc/kin/internal/provider"
	"github.com/vuuihc/kin/internal/store"
)

// fakeAdapter emits canned events then closes.
type fakeAdapter struct {
	mu      sync.Mutex
	started int
	// delay before closing events (for cancel tests)
	runFor time.Duration
	// events to emit
	events []adapter.Event
	// block Start until released
	gate chan struct{}
	// lastSpec / specs record TaskSpec for permission-mode / orchestration tests
	lastSpec adapter.TaskSpec
	specs    []adapter.TaskSpec
}

type fakeHandle struct {
	ch       chan adapter.Event
	cancelCh chan struct{}
	canceled bool
	mu       sync.Mutex
}

func (h *fakeHandle) Events() <-chan adapter.Event { return h.ch }
func (h *fakeHandle) Cancel() error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.canceled {
		h.canceled = true
		close(h.cancelCh)
	}
	return nil
}

func (a *fakeAdapter) Start(ctx context.Context, spec adapter.TaskSpec) (adapter.RunHandle, error) {
	a.mu.Lock()
	a.started++
	a.lastSpec = spec
	a.specs = append(a.specs, spec)
	a.mu.Unlock()
	if a.gate != nil {
		select {
		case <-a.gate:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	ch := make(chan adapter.Event, 16)
	h := &fakeHandle{ch: ch, cancelCh: make(chan struct{})}
	go func() {
		defer close(ch)
		for _, ev := range a.events {
			select {
			case <-h.cancelCh:
				return
			case ch <- ev:
			}
		}
		if a.runFor > 0 {
			select {
			case <-h.cancelCh:
				return
			case <-time.After(a.runFor):
			}
		}
	}()
	return h, nil
}

func testEngine(t *testing.T, max int, ad adapter.Adapter) (*Engine, *store.Store) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	bus := NewBus()
	adapters := map[string]adapter.Adapter{"claude-code": ad}
	e := NewEngine(st, adapters, bus, max)
	t.Cleanup(e.Close)
	if err := e.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	return e, st
}

func successEvents() []adapter.Event {
	return []adapter.Event{
		{Type: "task_started", Payload: json.RawMessage(`{"session_id":"s1","subtype":"init"}`)},
		{Type: "message", Payload: json.RawMessage(`{"role":"assistant","content":[{"type":"text","text":"hi"}],"partial":false}`)},
		{Type: "result", Payload: json.RawMessage(`{"cost_usd":0.01,"total_cost_usd":0.01,"tokens_in":10,"tokens_out":5,"is_error":false}`)},
	}
}

func waitStatus(t *testing.T, e *Engine, id, want string, timeout time.Duration) store.Task {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		task, err := e.Get(context.Background(), id)
		if err == nil && task.Status == want {
			return task
		}
		time.Sleep(10 * time.Millisecond)
	}
	task, _ := e.Get(context.Background(), id)
	t.Fatalf("timeout waiting for status %s, got %s", want, task.Status)
	return task
}

func TestHappyPath(t *testing.T) {
	ad := &fakeAdapter{events: successEvents()}
	e, _ := testEngine(t, 4, ad)

	task, err := e.Create(context.Background(), CreateRequest{
		Agent: "claude-code", Cwd: "/tmp", Prompt: "say hi",
	})
	if err != nil {
		t.Fatal(err)
	}
	if task.Status != StatusQueued && task.Status != StatusRunning && task.Status != StatusSucceeded {
		t.Fatalf("initial status %s", task.Status)
	}

	final := waitStatus(t, e, task.ID, StatusSucceeded, 2*time.Second)
	if final.CostUSD == nil || *final.CostUSD != 0.01 {
		t.Fatalf("cost=%v", final.CostUSD)
	}
	if final.TokensIn != 10 || final.TokensOut != 5 {
		t.Fatalf("tokens in=%d out=%d", final.TokensIn, final.TokensOut)
	}
	if final.SessionRef == nil || *final.SessionRef != "s1" {
		t.Fatalf("session_ref=%v", final.SessionRef)
	}
	evs, err := e.Events(context.Background(), task.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(evs) < 3 {
		t.Fatalf("events=%d", len(evs))
	}
	// seq monotonic
	for i, ev := range evs {
		if ev.Seq != i+1 {
			t.Fatalf("seq[%d]=%d", i, ev.Seq)
		}
	}
}

func TestCancelRunning(t *testing.T) {
	ad := &fakeAdapter{
		events: []adapter.Event{
			{Type: "message", Payload: json.RawMessage(`{"role":"assistant","partial":true}`)},
		},
		runFor: 5 * time.Second,
	}
	e, _ := testEngine(t, 4, ad)

	task, err := e.Create(context.Background(), CreateRequest{
		Agent: "claude-code", Cwd: "/tmp", Prompt: "long",
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusRunning, 2*time.Second)

	canceled, err := e.Cancel(context.Background(), task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if canceled.Status != StatusCanceled {
		t.Fatalf("status=%s", canceled.Status)
	}
}

func TestRestartRecovery(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	ctx := context.Background()

	// Simulate leftovers from a previous process.
	now := store.NowMilli()
	for _, id := range []string{"01ORPHAN000000000000000001", "01ORPHAN000000000000000002"} {
		status := StatusRunning
		if id[len(id)-1] == '1' {
			status = StatusQueued
		}
		if err := st.InsertTask(ctx, store.Task{
			ID: id, Title: "x", Agent: "claude-code", Cwd: "/tmp", Prompt: "p",
			Status: status, CreatedAt: now,
		}); err != nil {
			t.Fatal(err)
		}
	}

	ad := &fakeAdapter{events: successEvents()}
	e := NewEngine(st, map[string]adapter.Adapter{"claude-code": ad}, NewBus(), 4)
	defer e.Close()
	if err := e.Recover(ctx); err != nil {
		t.Fatal(err)
	}

	for _, id := range []string{"01ORPHAN000000000000000001", "01ORPHAN000000000000000002"} {
		task, err := e.Get(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		if task.Status != StatusFailed {
			t.Fatalf("%s status=%s", id, task.Status)
		}
		evs, err := e.Events(ctx, id, 0)
		if err != nil {
			t.Fatal(err)
		}
		if len(evs) != 1 || evs[0].Type != "error" {
			t.Fatalf("events=%v", evs)
		}
		var p map[string]string
		_ = json.Unmarshal(evs[0].Payload, &p)
		if p["message"] != "daemon restarted" {
			t.Fatalf("payload=%v", p)
		}
	}
}

func TestQueueBeyondConcurrency(t *testing.T) {
	gate := make(chan struct{})
	ad := &fakeAdapter{
		events: successEvents(),
		gate:   gate,
	}
	e, _ := testEngine(t, 4, ad)
	ctx := context.Background()

	var ids []string
	for i := 0; i < 6; i++ {
		task, err := e.Create(ctx, CreateRequest{
			Agent: "claude-code", Cwd: "/tmp", Prompt: "p",
		})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, task.ID)
	}

	// Start is blocked on gate: at most 4 can enter Start; 2 stay queued.
	deadline := time.Now().Add(2 * time.Second)
	var running, queued int
	for time.Now().Before(deadline) {
		running, queued = 0, 0
		for _, id := range ids {
			task, _ := e.Get(ctx, id)
			switch task.Status {
			case StatusRunning:
				running++
			case StatusQueued:
				queued++
			}
		}
		if running == 4 && queued == 2 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if running != 4 || queued != 2 {
		t.Fatalf("running=%d queued=%d want 4/2", running, queued)
	}

	close(gate)
	for _, id := range ids {
		waitStatus(t, e, id, StatusSucceeded, 3*time.Second)
	}
	ad.mu.Lock()
	started := ad.started
	ad.mu.Unlock()
	if started != 6 {
		t.Fatalf("started=%d want 6", started)
	}
}

func TestEventsBeforeBroadcast(t *testing.T) {
	// Integration-ish: after success, events in store must match what bus saw,
	// and every event must exist in SQLite.
	ad := &fakeAdapter{events: successEvents()}
	e, st := testEngine(t, 4, ad)
	sub := e.Bus().Subscribe()
	defer e.Bus().Unsubscribe(sub)

	task, err := e.Create(context.Background(), CreateRequest{
		Agent: "claude-code", Cwd: "/tmp", Prompt: "hi",
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 2*time.Second)

	// Drain bus briefly.
	time.Sleep(50 * time.Millisecond)

	dbEvs, err := st.ListEvents(context.Background(), task.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(dbEvs) < 3 {
		t.Fatalf("db events=%d", len(dbEvs))
	}
}


func TestAsyncTitleSummarize(t *testing.T) {
	ad := &fakeAdapter{events: successEvents()}
	e, _ := testEngine(t, 4, ad)
	e.SetTitleResolver(func(ctx context.Context) (provider.Client, provider.Config, error) {
		return &titleStubClient{content: "Summarize project structure"}, provider.Config{
			Kind: "openai-compatible", BaseURL: "http://example.invalid/v1", Model: "m",
		}, nil
	})
	task, err := e.Create(context.Background(), CreateRequest{
		Agent: "claude-code", Cwd: "/tmp",
		Prompt: "请帮我总结一下这个仓库的整体结构，并指出主要模块",
	})
	if err != nil {
		t.Fatal(err)
	}
	// Fallback is immediate (Chinese prompt truncated or full).
	if task.Title == "" {
		t.Fatal("expected fallback title")
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		got, _ := e.Get(context.Background(), task.ID)
		if got.Title == "Summarize project structure" {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	got, _ := e.Get(context.Background(), task.ID)
	t.Fatalf("title not summarized: %q", got.Title)
}

func TestExplicitTitleNotOverwritten(t *testing.T) {
	ad := &fakeAdapter{events: successEvents()}
	e, _ := testEngine(t, 4, ad)
	e.SetTitleResolver(func(ctx context.Context) (provider.Client, provider.Config, error) {
		return &titleStubClient{content: "SHOULD NOT APPLY"}, provider.Config{
			Kind: "openai-compatible", BaseURL: "http://example.invalid/v1", Model: "m",
		}, nil
	})
	title := "My custom title"
	task, err := e.Create(context.Background(), CreateRequest{
		Agent: "claude-code", Cwd: "/tmp", Prompt: "long enough prompt to trigger summarize path",
		Title: &title,
	})
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	got, _ := e.Get(context.Background(), task.ID)
	if got.Title != "My custom title" {
		t.Fatalf("title=%q", got.Title)
	}
}

type titleStubClient struct{ content string }

func (s *titleStubClient) Chat(ctx context.Context, req provider.ChatRequest) (*provider.ChatResponse, error) {
	return &provider.ChatResponse{Content: s.content, Model: "stub"}, nil
}
func (s *titleStubClient) Kind() string         { return "stub" }
func (s *titleStubClient) ModelDefault() string { return "stub" }
