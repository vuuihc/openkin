package task

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/provider"
	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/workspace"
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
	onStart  func(adapter.TaskSpec)
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

type overlappingRunAdapter struct {
	mu            sync.Mutex
	starts        int
	firstRelease  chan struct{}
	secondRelease chan struct{}
}

type nonCancelingHandle struct {
	ch <-chan adapter.Event
}

func (h *nonCancelingHandle) Events() <-chan adapter.Event { return h.ch }
func (h *nonCancelingHandle) Cancel() error                { return nil }

func (a *overlappingRunAdapter) Start(context.Context, adapter.TaskSpec) (adapter.RunHandle, error) {
	a.mu.Lock()
	a.starts++
	start := a.starts
	release := a.firstRelease
	if start > 1 {
		release = a.secondRelease
	}
	a.mu.Unlock()

	ch := make(chan adapter.Event, 4)
	go func() {
		defer close(ch)
		ch <- adapter.Event{Type: "task_started", Payload: json.RawMessage(`{"session_id":"overlap"}`)}
		<-release
		text := "new-result"
		if start == 1 {
			text = "old-late-result"
		}
		payload, _ := json.Marshal(map[string]any{
			"role": "assistant", "content": []map[string]string{{"type": "text", "text": text}},
		})
		ch <- adapter.Event{Type: "message", Payload: payload}
		ch <- adapter.Event{Type: "result", Payload: json.RawMessage(`{"is_error":false}`)}
	}()
	return &nonCancelingHandle{ch: ch}, nil
}

type blockingRunEventWriter struct {
	inner   eventWriter
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (w *blockingRunEventWriter) AppendEvent(
	ctx context.Context,
	taskID, typ string,
	payload json.RawMessage,
) (store.Event, error) {
	if typ == "message" && strings.Contains(string(payload), "old-late-result") {
		w.once.Do(func() {
			close(w.entered)
			<-w.release
		})
	}
	return w.inner.AppendEvent(ctx, taskID, typ, payload)
}

func (w *blockingRunEventWriter) AppendUsageEvent(
	ctx context.Context,
	taskID, typ string,
	payload json.RawMessage,
	record store.UsageRecord,
) (store.Event, store.Task, error) {
	return w.inner.AppendUsageEvent(ctx, taskID, typ, payload, record)
}

func (a *fakeAdapter) Start(ctx context.Context, spec adapter.TaskSpec) (adapter.RunHandle, error) {
	a.mu.Lock()
	a.started++
	a.lastSpec = spec
	a.specs = append(a.specs, spec)
	onStart := a.onStart
	a.mu.Unlock()
	if onStart != nil {
		onStart(spec)
	}
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
	e := NewEngineFromAdapters(st, adapters, bus, max)
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
	events, _ := e.store.ListEvents(context.Background(), id, 0)
	t.Fatalf("timeout waiting for status %s, got %s; events=%+v", want, task.Status, events)
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

func TestMalformedResultCannotCompleteSuccessfully(t *testing.T) {
	ad := &fakeAdapter{events: []adapter.Event{
		{Type: "result", Payload: json.RawMessage(`{"is_error":`)},
	}}
	e, _ := testEngine(t, 1, ad)

	task, err := e.Create(context.Background(), CreateRequest{
		Agent:  "claude-code",
		Cwd:    t.TempDir(),
		Prompt: "test malformed result",
	})
	if err != nil {
		t.Fatal(err)
	}
	final := waitStatus(t, e, task.ID, StatusFailed, 2*time.Second)
	if final.Status != StatusFailed {
		t.Fatalf("status=%q want failed", final.Status)
	}
}

func TestUsageEventDoesNotDoubleCountResult(t *testing.T) {
	ad := &fakeAdapter{events: []adapter.Event{
		{Type: "usage", Payload: json.RawMessage(`{"source":"codex","input_tokens":100,"output_tokens":10,"cache_read_tokens":80,"cache_read_reported":true,"input_semantics":"total_includes_cache"}`)},
		{Type: "result", Payload: json.RawMessage(`{"tokens_in":100,"tokens_out":10,"is_error":false}`)},
	}}
	e, st := testEngine(t, 4, ad)

	task, err := e.Create(context.Background(), CreateRequest{
		Agent: "claude-code", Cwd: "/tmp", Prompt: "measure",
	})
	if err != nil {
		t.Fatal(err)
	}
	final := waitStatus(t, e, task.ID, StatusSucceeded, 2*time.Second)
	if final.TokensIn != 100 || final.TokensOut != 10 {
		t.Fatalf("tokens = %d/%d, want 100/10", final.TokensIn, final.TokensOut)
	}
	records, err := st.ListUsageRecords(context.Background(), task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 {
		t.Fatalf("usage records = %d, want 1", len(records))
	}
}

func TestMultipleUsageEventsIgnoreCumulativeResult(t *testing.T) {
	ad := &fakeAdapter{events: []adapter.Event{
		{Type: "usage", Payload: json.RawMessage(`{"source":"kin","prompt_tokens":50,"completion_tokens":5,"cached_tokens":20,"cache_read_reported":true}`)},
		{Type: "usage", Payload: json.RawMessage(`{"source":"kin","prompt_tokens":60,"completion_tokens":6,"cached_tokens":30,"cache_read_reported":true}`)},
		{Type: "result", Payload: json.RawMessage(`{"tokens_in":110,"tokens_out":11,"cached_tokens":50,"is_error":false}`)},
	}}
	e, st := testEngine(t, 4, ad)

	task, err := e.Create(context.Background(), CreateRequest{
		Agent: "claude-code", Cwd: "/tmp", Prompt: "two rounds",
	})
	if err != nil {
		t.Fatal(err)
	}
	final := waitStatus(t, e, task.ID, StatusSucceeded, 2*time.Second)
	if final.TokensIn != 110 || final.TokensOut != 11 {
		t.Fatalf("tokens = %d/%d, want 110/11", final.TokensIn, final.TokensOut)
	}
	records, err := st.ListUsageRecords(context.Background(), task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 2 {
		t.Fatalf("usage records = %d, want 2", len(records))
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

func TestCancelWhileAdapterStartIsBlockedStaysCanceled(t *testing.T) {
	gate := make(chan struct{})
	ad := &fakeAdapter{events: successEvents(), gate: gate}
	e, _ := testEngine(t, 1, ad)

	task, err := e.Create(context.Background(), CreateRequest{
		Agent: "claude-code", Cwd: t.TempDir(), Prompt: "start slowly",
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusRunning, 2*time.Second)
	deadline := time.Now().Add(2 * time.Second)
	for {
		ad.mu.Lock()
		started := ad.started
		ad.mu.Unlock()
		if started > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("adapter start was not entered")
		}
		time.Sleep(10 * time.Millisecond)
	}

	canceled, err := e.Cancel(context.Background(), task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if canceled.Status != StatusCanceled {
		t.Fatalf("status=%s", canceled.Status)
	}
	close(gate)
	time.Sleep(100 * time.Millisecond)
	got, err := e.Get(context.Background(), task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != StatusCanceled {
		t.Fatalf("status after adapter start=%s want canceled", got.Status)
	}
}

func TestNewQueueAttemptClearsStaleCancellation(t *testing.T) {
	gate := make(chan struct{})
	ad := &fakeAdapter{events: successEvents(), gate: gate}
	e, st := testEngine(t, 1, ad)
	task := store.Task{
		ID: "01STALECANCEL000000000001", Title: "retry", Agent: "claude-code",
		Cwd: t.TempDir(), Prompt: "continue", Status: StatusQueued,
		CreatedAt: store.NowMilli(),
	}
	if err := st.InsertTask(context.Background(), task); err != nil {
		t.Fatal(err)
	}
	e.mu.Lock()
	e.canceled[task.ID] = true
	e.queue = append(e.queue, task.ID)
	e.mu.Unlock()
	e.pump()
	_ = waitStatus(t, e, task.ID, StatusRunning, 2*time.Second)
	e.mu.Lock()
	stale := e.canceled[task.ID]
	e.mu.Unlock()
	if stale {
		t.Fatal("new queue attempt retained stale cancellation")
	}
	close(gate)
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 2*time.Second)
}

func TestRetiredRunCannotOverwriteRunningRetry(t *testing.T) {
	ad := &overlappingRunAdapter{
		firstRelease:  make(chan struct{}),
		secondRelease: make(chan struct{}),
	}
	e, st := testEngine(t, 2, ad)
	writer := &blockingRunEventWriter{
		inner:   storeEventWriter{st: st},
		entered: make(chan struct{}),
		release: make(chan struct{}),
	}
	e.setEventWriter(writer)
	ctx := context.Background()
	task, err := e.Create(ctx, CreateRequest{
		Agent: "claude-code", Cwd: t.TempDir(), Prompt: "first",
		WorkspaceMode: workspace.ModeShared,
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusRunning, 2*time.Second)
	close(ad.firstRelease)
	select {
	case <-writer.entered:
	case <-time.After(2 * time.Second):
		t.Fatal("old run event did not reach blocked writer")
	}
	cancelResult := make(chan error, 1)
	go func() {
		_, err := e.Cancel(ctx, task.ID)
		cancelResult <- err
	}()
	select {
	case err := <-cancelResult:
		t.Fatalf("cancel crossed an in-flight owner-checked event write: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	close(writer.release)
	if err := <-cancelResult; err != nil {
		t.Fatal(err)
	}
	restoreFiles := false
	if _, err := e.Retry(ctx, task.ID, RetryRequest{RestoreFiles: &restoreFiles}); err != nil {
		t.Fatal(err)
	}
	retried := waitStatus(t, e, task.ID, StatusRunning, 2*time.Second)
	if retried.EventEpoch != 1 {
		t.Fatalf("retry epoch=%d want 1", retried.EventEpoch)
	}

	time.Sleep(100 * time.Millisecond)
	stillRunning, err := e.Get(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stillRunning.Status != StatusRunning || stillRunning.EventEpoch != 1 {
		t.Fatalf("retired run changed retry state: %+v", stillRunning)
	}
	events, err := st.ListEvents(ctx, task.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, event := range events {
		if strings.Contains(string(event.Payload), "old-late-result") {
			t.Fatalf("retired run event leaked into retry epoch: %s", event.Payload)
		}
	}

	close(ad.secondRelease)
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 2*time.Second)
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
	e := NewEngineFromAdapters(st, map[string]adapter.Adapter{"claude-code": ad}, NewBus(), 4)
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

func TestExplicitAgentIsSingleRunSpeaker(t *testing.T) {
	ad := &fakeAdapter{events: successEvents()}
	e, _ := testEngine(t, 4, ad)
	task, err := e.Create(context.Background(), CreateRequest{
		Agent: "claude-code", Cwd: "/tmp", Prompt: "say hi",
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 2*time.Second)
	evs, err := e.Events(context.Background(), task.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	var sawAssistant bool
	for _, ev := range evs {
		if ev.Type != "message" {
			continue
		}
		var m map[string]any
		_ = json.Unmarshal(ev.Payload, &m)
		if m["role"] == "assistant" || m["speaker"] == "claude-code" {
			if sp, _ := m["speaker"].(string); sp != "" && sp != "claude-code" {
				t.Fatalf("speaker=%v want claude-code payload=%s", m["speaker"], string(ev.Payload))
			}
			sawAssistant = true
		}
	}
	if !sawAssistant {
		t.Fatal("no assistant message")
	}
}

func TestLegacyResultPayloadStillParsed(t *testing.T) {
	// successEvents already uses legacy session_id / cost fields.
	ad := &fakeAdapter{events: successEvents()}
	e, _ := testEngine(t, 4, ad)
	task, err := e.Create(context.Background(), CreateRequest{
		Agent: "claude-code", Cwd: "/tmp", Prompt: "hi",
	})
	if err != nil {
		t.Fatal(err)
	}
	final := waitStatus(t, e, task.ID, StatusSucceeded, 2*time.Second)
	if final.SessionRef == nil || *final.SessionRef != "s1" {
		t.Fatalf("session_ref=%v", final.SessionRef)
	}
}

func TestPriceTableEstimatesMissingProviderCost(t *testing.T) {
	// Usage without cost_usd: engine should estimate from price_table and mark cost_source.
	ad := &fakeAdapter{events: []adapter.Event{
		{Type: "usage", Payload: json.RawMessage(`{"source":"kin","model":"gpt-5-codex","prompt_tokens":1000000,"completion_tokens":1000000,"cache_read_reported":false}`)},
		{Type: "result", Payload: json.RawMessage(`{"model":"gpt-5-codex","tokens_in":1000000,"tokens_out":1000000,"is_error":false}`)},
	}}
	e, st := testEngine(t, 4, ad)
	if err := st.SetSetting(context.Background(), store.KeyPriceTable, store.DefaultPriceTableJSON); err != nil {
		t.Fatal(err)
	}

	task, err := e.Create(context.Background(), CreateRequest{
		Agent: "claude-code", Cwd: "/tmp", Prompt: "estimate me",
	})
	if err != nil {
		t.Fatal(err)
	}
	final := waitStatus(t, e, task.ID, StatusSucceeded, 2*time.Second)
	if final.CostUSD == nil {
		t.Fatal("expected estimated cost_usd")
	}
	// Default table: gpt-5-codex in=1.25 out=10 → 1.25+10 = 11.25 for 1M/1M
	want, ok := store.DefaultPriceTable().ComputeCost("gpt-5-codex", 1_000_000, 1_000_000)
	if !ok {
		t.Fatal("default price table missing gpt-5-codex")
	}
	if *final.CostUSD < want-0.0001 || *final.CostUSD > want+0.0001 {
		t.Fatalf("cost=%v want %v", *final.CostUSD, want)
	}
	records, err := st.ListUsageRecords(context.Background(), task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 {
		t.Fatalf("records=%d", len(records))
	}
	if records[0].CostSource != store.CostSourcePriceTable {
		t.Fatalf("cost_source=%q want price_table", records[0].CostSource)
	}
	if records[0].CostUSD == nil {
		t.Fatal("record cost nil")
	}
}

func TestPriceTableUsesCodexDefaultWhenModelMissing(t *testing.T) {
	ad := &fakeAdapter{events: []adapter.Event{
		// No model in payload; agent id is stamped by engine as speaker.
		{Type: "usage", Payload: json.RawMessage(`{"source":"codex","input_tokens":1000000,"output_tokens":0,"input_semantics":"total_includes_cache"}`)},
		{Type: "result", Payload: json.RawMessage(`{"tokens_in":1000000,"tokens_out":0,"is_error":false}`)},
	}}
	st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	if err := st.SetSetting(context.Background(), store.KeyPriceTable, store.DefaultPriceTableJSON); err != nil {
		t.Fatal(err)
	}
	bus := NewBus()
	e := NewEngineFromAdapters(st, map[string]adapter.Adapter{"codex": ad}, bus, 4)
	t.Cleanup(e.Close)
	if err := e.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}

	task, err := e.Create(context.Background(), CreateRequest{
		Agent: "codex", Cwd: "/tmp", Prompt: "no model pin",
	})
	if err != nil {
		t.Fatal(err)
	}
	final := waitStatus(t, e, task.ID, StatusSucceeded, 2*time.Second)
	if final.CostUSD == nil {
		t.Fatal("expected codex default model price estimate")
	}
	records, err := st.ListUsageRecords(context.Background(), task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 {
		t.Fatalf("records=%d", len(records))
	}
	if records[0].CostSource != store.CostSourcePriceTable {
		t.Fatalf("cost_source=%q", records[0].CostSource)
	}
	if records[0].Model == nil || *records[0].Model != "gpt-5-codex" {
		t.Fatalf("model=%v want gpt-5-codex", records[0].Model)
	}
}

type fakeWorkspaceRuntime struct {
	mu                      sync.Mutex
	prepares                []prepareCall
	cleanups                []string
	captures                []captureCall
	restores                []restoreCall
	treeRestores            []restoreCall
	prepareForks            []prepareForkCall
	prepare                 func(ctx context.Context, taskID, cwd string, requested workspace.RequestedMode) (workspace.Metadata, error)
	capture                 func(ctx context.Context, meta workspace.Metadata, taskID string, eventSeq int) (workspace.Checkpoint, error)
	restore                 func(ctx context.Context, meta workspace.Metadata, taskID string, cp workspace.Checkpoint) error
	prepareFork             func(ctx context.Context, newTaskID string, source workspace.Metadata, cp workspace.Checkpoint) (workspace.Metadata, error)
	failPrep                error
	failCapture             error
	failRestore             error
	failFork                error
	currentBranch           string
	failBranch              error
	detached                bool
	fastForwardMeta         workspace.Metadata
	fastForwardTargetBranch string
	fastForwardCalls        int
	finalizeInspection      *workspace.FinalizeInspection
	finalizeStarted         chan struct{}
	finalizeRelease         chan struct{}
	finalizeOnce            sync.Once
	integrationTarget       string
	ancestorResult          bool
	ancestorErr             error
	releaseMeta             workspace.Metadata
	releaseErr              error
}

type prepareCall struct {
	TaskID    string
	Cwd       string
	Requested workspace.RequestedMode
}

type captureCall struct {
	TaskID   string
	EventSeq int
	Meta     workspace.Metadata
}

type restoreCall struct {
	TaskID string
	Meta   workspace.Metadata
	CP     workspace.Checkpoint
}

type prepareForkCall struct {
	NewTaskID string
	Source    workspace.Metadata
	CP        workspace.Checkpoint
}

func (f *fakeWorkspaceRuntime) ResolveSource(ctx context.Context, cwd string) (workspace.SourceMetadata, error) {
	targetBranch, err := f.CurrentBranch(ctx, cwd)
	if err != nil {
		return workspace.SourceMetadata{}, err
	}
	return workspace.SourceMetadata{
		Cwd:          cwd,
		SourceRoot:   cwd,
		Scope:        ".",
		TargetBranch: targetBranch,
		HeadOID:      "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
	}, nil
}

func (f *fakeWorkspaceRuntime) CurrentBranch(ctx context.Context, cwd string) (string, error) {
	if f.failBranch != nil {
		return "", f.failBranch
	}
	if f.detached {
		return "", nil
	}
	if f.currentBranch != "" {
		return f.currentBranch, nil
	}
	return "main", nil
}

func (f *fakeWorkspaceRuntime) Prepare(ctx context.Context, taskID, cwd string, requested workspace.RequestedMode) (workspace.Metadata, error) {
	f.mu.Lock()
	f.prepares = append(f.prepares, prepareCall{TaskID: taskID, Cwd: cwd, Requested: requested})
	f.mu.Unlock()
	if f.failPrep != nil {
		return workspace.Metadata{}, f.failPrep
	}
	if f.prepare != nil {
		return f.prepare(ctx, taskID, cwd, requested)
	}
	root := filepath.Join(cwd, "wt-"+taskID)
	cwdPath := filepath.Join(root, "sub")
	_ = os.MkdirAll(cwdPath, 0o755)
	return workspace.Metadata{
		Mode:       workspace.ResolvedWorktree,
		SourceRoot: cwd,
		Root:       root,
		Cwd:        cwdPath,
		Scope:      "sub",
		BaseOID:    "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
		Branch:     "kin/task/" + strings.ToLower(taskID),
	}, nil
}

func (f *fakeWorkspaceRuntime) CleanupPrepared(ctx context.Context, taskID string, meta workspace.Metadata) error {
	f.mu.Lock()
	f.cleanups = append(f.cleanups, taskID)
	f.mu.Unlock()
	return nil
}

func (f *fakeWorkspaceRuntime) Capture(ctx context.Context, meta workspace.Metadata, taskID string, eventSeq int) (workspace.Checkpoint, error) {
	f.mu.Lock()
	f.captures = append(f.captures, captureCall{TaskID: taskID, EventSeq: eventSeq, Meta: meta})
	f.mu.Unlock()
	if f.failCapture != nil {
		return workspace.Checkpoint{}, f.failCapture
	}
	if f.capture != nil {
		return f.capture(ctx, meta, taskID, eventSeq)
	}
	return workspace.Checkpoint{
		TaskID:    taskID,
		EventSeq:  eventSeq,
		HeadOID:   "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		TreeOID:   "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		SizeBytes: 42,
		CreatedAt: 99,
	}, nil
}

func (f *fakeWorkspaceRuntime) Restore(ctx context.Context, meta workspace.Metadata, taskID string, cp workspace.Checkpoint) error {
	f.mu.Lock()
	f.restores = append(f.restores, restoreCall{TaskID: taskID, Meta: meta, CP: cp})
	f.mu.Unlock()
	if f.failRestore != nil {
		return f.failRestore
	}
	if f.restore != nil {
		return f.restore(ctx, meta, taskID, cp)
	}
	return nil
}

func (f *fakeWorkspaceRuntime) RestoreTreeOntoCurrent(ctx context.Context, meta workspace.Metadata, taskID string, cp workspace.Checkpoint) error {
	f.mu.Lock()
	f.treeRestores = append(f.treeRestores, restoreCall{TaskID: taskID, Meta: meta, CP: cp})
	f.mu.Unlock()
	if f.failRestore != nil {
		return f.failRestore
	}
	if f.restore != nil {
		return f.restore(ctx, meta, taskID, cp)
	}
	return nil
}

func (f *fakeWorkspaceRuntime) PrepareFork(ctx context.Context, newTaskID string, source workspace.Metadata, cp workspace.Checkpoint) (workspace.Metadata, error) {
	f.mu.Lock()
	f.prepareForks = append(f.prepareForks, prepareForkCall{NewTaskID: newTaskID, Source: source, CP: cp})
	f.mu.Unlock()
	if f.failFork != nil {
		return workspace.Metadata{}, f.failFork
	}
	if f.prepareFork != nil {
		return f.prepareFork(ctx, newTaskID, source, cp)
	}
	root := filepath.Join(source.SourceRoot, "fork-"+newTaskID)
	cwdPath := filepath.Join(root, source.Scope)
	_ = os.MkdirAll(cwdPath, 0o755)
	return workspace.Metadata{
		Mode:         workspace.ResolvedWorktree,
		Generation:   1,
		SourceRoot:   source.SourceRoot,
		Root:         root,
		Cwd:          cwdPath,
		Scope:        source.Scope,
		BaseOID:      source.BaseOID,
		Branch:       "kin/task/" + strings.ToLower(newTaskID),
		TargetBranch: source.TargetBranch,
	}, nil
}

func (f *fakeWorkspaceRuntime) PrepareGeneration(ctx context.Context, taskID string, generation int, source workspace.SourceMetadata) (workspace.Metadata, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failPrep != nil {
		return workspace.Metadata{}, f.failPrep
	}
	root := filepath.Join(source.SourceRoot, taskID+"-g"+fmt.Sprint(generation))
	cwdPath := filepath.Join(root, source.Scope)
	_ = os.MkdirAll(cwdPath, 0o755)
	return workspace.Metadata{
		Mode:         workspace.ResolvedWorktree,
		Generation:   generation,
		SourceRoot:   source.SourceRoot,
		Root:         root,
		Cwd:          cwdPath,
		Scope:        source.Scope,
		BaseOID:      source.HeadOID,
		Branch:       "kin/task/" + strings.ToLower(taskID) + "/g" + fmt.Sprint(generation),
		TargetBranch: source.TargetBranch,
	}, nil
}

func (f *fakeWorkspaceRuntime) InspectGeneration(ctx context.Context, meta workspace.Metadata) (workspace.Inspection, error) {
	return workspace.Inspection{
		Exists: meta.Root != "",
		Branch: meta.Branch,
		Path:   meta.Root,
	}, nil
}

func (f *fakeWorkspaceRuntime) CapturePrepared(ctx context.Context, meta workspace.Metadata, taskID string) (workspace.Checkpoint, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failCapture != nil {
		return workspace.Checkpoint{}, f.failCapture
	}
	return workspace.Checkpoint{
		TaskID:    taskID,
		HeadOID:   "prepared-head",
		TreeOID:   "prepared-tree",
		SizeBytes: 100,
		CreatedAt: time.Now().UnixMilli(),
	}, nil
}

func (f *fakeWorkspaceRuntime) InspectFinalizable(ctx context.Context, meta workspace.Metadata) (workspace.FinalizeInspection, error) {
	if f.finalizeStarted != nil {
		f.finalizeOnce.Do(func() { close(f.finalizeStarted) })
	}
	if f.finalizeRelease != nil {
		select {
		case <-f.finalizeRelease:
		case <-ctx.Done():
			return workspace.FinalizeInspection{}, ctx.Err()
		}
	}
	if f.finalizeInspection != nil {
		return *f.finalizeInspection, nil
	}
	return workspace.FinalizeInspection{
		HeadOID: meta.BaseOID,
		TreeOID: "tree-oid",
	}, nil
}

func (f *fakeWorkspaceRuntime) InspectIntegrationTarget(ctx context.Context, meta workspace.Metadata, targetBranch string) (string, error) {
	if f.integrationTarget != "" {
		return f.integrationTarget, nil
	}
	return meta.BaseOID, nil
}

func (f *fakeWorkspaceRuntime) IsAncestor(
	context.Context, workspace.Metadata, string, string,
) (bool, error) {
	return f.ancestorResult, f.ancestorErr
}

func (f *fakeWorkspaceRuntime) FastForward(ctx context.Context, meta workspace.Metadata, targetBranch, expectedSourceOID, finalHeadOID string) (string, error) {
	f.mu.Lock()
	f.fastForwardMeta = meta
	f.fastForwardTargetBranch = targetBranch
	f.fastForwardCalls++
	f.mu.Unlock()
	return finalHeadOID, nil
}

func (f *fakeWorkspaceRuntime) FinalizeFastForward(ctx context.Context, meta workspace.Metadata, targetBranch string) (string, error) {
	return meta.BaseOID, nil
}

func (f *fakeWorkspaceRuntime) Release(ctx context.Context, meta workspace.Metadata) error {
	f.mu.Lock()
	f.releaseMeta = meta
	err := f.releaseErr
	f.mu.Unlock()
	return err
}

func (f *fakeWorkspaceRuntime) ReleaseAndPrune(ctx context.Context, meta workspace.Metadata, taskID string) error {
	return f.Release(ctx, meta)
}

func TestCreateWorkspaceModePassedAndPersisted(t *testing.T) {
	ad := &fakeAdapter{events: successEvents()}
	e, _ := testEngine(t, 4, ad)
	rt := &fakeWorkspaceRuntime{}
	e.SetWorkspaceRuntime(rt)

	cwd := t.TempDir()
	task, err := e.Create(context.Background(), CreateRequest{
		Agent: "claude-code", Cwd: cwd, Prompt: "hi", WorkspaceMode: workspace.ModeWorktree,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(rt.prepares) != 1 {
		t.Fatalf("prepares=%d", len(rt.prepares))
	}
	if rt.prepares[0].Requested != workspace.ModeWorktree || rt.prepares[0].Cwd != cwd {
		t.Fatalf("%+v", rt.prepares[0])
	}
	if rt.prepares[0].TaskID != task.ID {
		t.Fatalf("task id mismatch")
	}
	if task.WorkspaceMode != string(workspace.ResolvedWorktree) {
		t.Fatalf("mode=%s", task.WorkspaceMode)
	}
	if task.ExecutionCwd == "" || task.WorkspaceBranch == "" {
		t.Fatalf("%+v", task)
	}
	got, err := e.Get(context.Background(), task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.ExecutionCwd != task.ExecutionCwd {
		t.Fatalf("persisted exec cwd=%q", got.ExecutionCwd)
	}
	ws, err := e.store.GetCurrentWorkspace(context.Background(), task.ID)
	if err != nil {
		t.Fatalf("get eager workspace generation: %v", err)
	}
	if ws.Generation != 1 || ws.PhysicalRoot != task.WorkspaceRoot ||
		(ws.State != store.WorkspaceReady && ws.State != store.WorkspaceActive) {
		t.Fatalf("eager workspace=%+v", ws)
	}
	userSeq := e.latestUserMessageSeq(context.Background(), task.ID)
	turn, err := e.store.GetTurnWorkspace(context.Background(), task.ID, userSeq)
	if err != nil {
		t.Fatal(err)
	}
	if turn.WorkspaceID == nil || *turn.WorkspaceID != ws.ID || turn.Access != string(adapter.AccessWritable) {
		t.Fatalf("eager turn binding=%+v", turn)
	}
	cp, err := e.store.GetCheckpointForWorkspace(context.Background(), task.ID, userSeq, ws.ID)
	if err != nil {
		t.Fatalf("get eager checkpoint: %v", err)
	}
	if cp.WorkspaceID != ws.ID {
		t.Fatalf("checkpoint workspace=%q want %q", cp.WorkspaceID, ws.ID)
	}

	final := waitStatus(t, e, task.ID, StatusSucceeded, 2*time.Second)
	_ = final
	ad.mu.Lock()
	spec := ad.lastSpec
	ad.mu.Unlock()
	if spec.Cwd != task.EffectiveCwd() {
		t.Fatalf("adapter cwd=%q want %q", spec.Cwd, task.EffectiveCwd())
	}
	ws, err = e.store.GetCurrentWorkspace(context.Background(), task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if ws.RequestedExecutionID != spec.Execution.ID {
		t.Fatalf(
			"workspace execution=%q want %q",
			ws.RequestedExecutionID,
			spec.Execution.ID,
		)
	}
	if spec.RunMeta.WorkspaceExecutionID != spec.Execution.ID {
		t.Fatalf(
			"run workspace execution=%q want %q",
			spec.RunMeta.WorkspaceExecutionID,
			spec.Execution.ID,
		)
	}
}

func TestStartOnePreservesInitialLazyWorkspace(t *testing.T) {
	ad := &fakeAdapter{events: successEvents()}
	e, st := testEngine(t, 1, ad)
	e.SetWorkspaceRuntime(&fakeWorkspaceRuntime{})
	cwd := t.TempDir()
	task := store.Task{
		ID:                  "01LAZYINITIAL0000000000001",
		Title:               "lazy",
		Agent:               "claude-code",
		Cwd:                 cwd,
		Prompt:              "inspect only",
		Status:              StatusQueued,
		CreatedAt:           store.NowMilli(),
		WorkspaceMode:       string(workspace.ResolvedWorktree),
		WorkspacePolicy:     string(store.WorkspacePolicyAuto),
		WorkspaceSourceRoot: cwd,
		WorkspaceRoot:       cwd,
		ExecutionCwd:        cwd,
		WorkspaceScope:      ".",
	}
	if err := st.InsertTask(context.Background(), task); err != nil {
		t.Fatal(err)
	}

	e.mu.Lock()
	e.active = 1
	e.mu.Unlock()
	e.setActiveRun(task.ID, "lazy-run")
	e.startOne(task.ID, "lazy-run")

	if _, err := st.GetCurrentWorkspace(context.Background(), task.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("initial lazy turn allocated a workspace: %v", err)
	}
	ad.mu.Lock()
	spec := ad.lastSpec
	ad.mu.Unlock()
	if spec.Cwd != cwd {
		t.Fatalf("adapter cwd=%q want source %q", spec.Cwd, cwd)
	}
	if spec.RunMeta.WorkspaceAccess != adapter.AccessSourceReadOnly {
		t.Fatalf("workspace access=%q want source_read_only", spec.RunMeta.WorkspaceAccess)
	}
	if spec.RunMeta.WorkspaceExecutionID != spec.Execution.ID {
		t.Fatalf(
			"lazy workspace execution=%q want %q",
			spec.RunMeta.WorkspaceExecutionID,
			spec.Execution.ID,
		)
	}
}

func TestCreateEagerWorkspaceRejectsDetachedSource(t *testing.T) {
	ad := &fakeAdapter{events: successEvents()}
	e, _ := testEngine(t, 1, ad)
	e.SetWorkspaceRuntime(&fakeWorkspaceRuntime{detached: true})

	_, err := e.Create(context.Background(), CreateRequest{
		Agent:         "claude-code",
		Cwd:           t.TempDir(),
		Prompt:        "edit",
		WorkspaceMode: workspace.ModeWorktree,
	})
	if err == nil || !strings.Contains(err.Error(), "detached HEAD") {
		t.Fatalf("error=%v want detached HEAD rejection", err)
	}
}

func TestCreateNilWorkspaceRuntimeShared(t *testing.T) {
	ad := &fakeAdapter{events: successEvents()}
	e, _ := testEngine(t, 4, ad)
	// no SetWorkspaceRuntime
	cwd := t.TempDir()
	task, err := e.Create(context.Background(), CreateRequest{
		Agent: "claude-code", Cwd: cwd, Prompt: "hi",
	})
	if err != nil {
		t.Fatal(err)
	}
	if task.WorkspaceMode != string(workspace.ResolvedShared) {
		t.Fatalf("mode=%s", task.WorkspaceMode)
	}
	if task.EffectiveCwd() != cwd {
		t.Fatalf("effective=%s", task.EffectiveCwd())
	}
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 2*time.Second)
	ad.mu.Lock()
	spec := ad.lastSpec
	ad.mu.Unlock()
	if spec.Cwd != cwd {
		t.Fatalf("adapter cwd=%q", spec.Cwd)
	}
}

func TestCreatePrepareFailureNoTask(t *testing.T) {
	ad := &fakeAdapter{events: successEvents()}
	e, st := testEngine(t, 4, ad)
	rt := &fakeWorkspaceRuntime{failPrep: workspace.ErrNotGit}
	e.SetWorkspaceRuntime(rt)
	_, err := e.Create(context.Background(), CreateRequest{
		Agent: "claude-code", Cwd: "/tmp", Prompt: "hi", WorkspaceMode: workspace.ModeWorktree,
	})
	if !errors.Is(err, workspace.ErrNotGit) {
		t.Fatalf("err=%v", err)
	}
	tasks, err := st.ListTasks(context.Background(), store.ListTasksOpts{})
	if err != nil {
		t.Fatal(err)
	}
	if len(tasks) != 0 {
		t.Fatalf("tasks inserted: %d", len(tasks))
	}
	if ad.started != 0 {
		t.Fatalf("adapter started=%d", ad.started)
	}
}

func TestCreateInsertFailureCleansWorktree(t *testing.T) {
	// Use a closed store to force InsertTask failure after prepare succeeds.
	ad := &fakeAdapter{events: successEvents()}
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	e := NewEngineFromAdapters(st, map[string]adapter.Adapter{"claude-code": ad}, NewBus(), 1)
	rt := &fakeWorkspaceRuntime{}
	e.SetWorkspaceRuntime(rt)
	st.Close() // force insert failures

	_, err = e.Create(context.Background(), CreateRequest{
		Agent: "claude-code", Cwd: "/tmp", Prompt: "hi", WorkspaceMode: workspace.ModeAuto,
	})
	if err == nil {
		t.Fatal("expected insert error")
	}
	// allow cleanup call
	time.Sleep(20 * time.Millisecond)
	rt.mu.Lock()
	n := len(rt.cleanups)
	rt.mu.Unlock()
	if n != 1 {
		t.Fatalf("cleanups=%d", n)
	}
}
