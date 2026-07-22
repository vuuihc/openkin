package task

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vuuihc/kin/internal/adapter"
	"github.com/vuuihc/kin/internal/store"
)

// failTypesEventWriter fails AppendEvent for configured types, otherwise
// delegates to the real store. This is the narrow injected seam for M4 tests.
type failTypesEventWriter struct {
	inner     eventWriter
	mu        sync.Mutex
	failTypes map[string]error
	// failOnceTypes fail only the first matching append per type.
	failOnceTypes map[string]error
	// failNth maps type → after how many successful attempts of that type to fail.
	// 0 means fail the first attempt (same as failTypes with once semantics via failOnce).
	calls []string
}

func (w *failTypesEventWriter) AppendEvent(ctx context.Context, taskID, typ string, payload json.RawMessage) (store.Event, error) {
	w.mu.Lock()
	w.calls = append(w.calls, typ)
	if err, ok := w.failTypes[typ]; ok && err != nil {
		w.mu.Unlock()
		return store.Event{}, err
	}
	if err, ok := w.failOnceTypes[typ]; ok && err != nil {
		delete(w.failOnceTypes, typ)
		w.mu.Unlock()
		return store.Event{}, err
	}
	w.mu.Unlock()
	return w.inner.AppendEvent(ctx, taskID, typ, payload)
}

func (w *failTypesEventWriter) AppendUsageEvent(ctx context.Context, taskID, typ string, payload json.RawMessage, record store.UsageRecord) (store.Event, store.Task, error) {
	// Result events often persist via the usage accounting path.
	w.mu.Lock()
	w.calls = append(w.calls, typ+"+usage")
	if err, ok := w.failTypes[typ]; ok && err != nil {
		w.mu.Unlock()
		return store.Event{}, store.Task{}, err
	}
	if err, ok := w.failOnceTypes[typ]; ok && err != nil {
		delete(w.failOnceTypes, typ)
		w.mu.Unlock()
		return store.Event{}, store.Task{}, err
	}
	w.mu.Unlock()
	return w.inner.AppendUsageEvent(ctx, taskID, typ, payload, record)
}

func TestResultPersistFailurePreventsSuccess(t *testing.T) {
	ad := &fakeAdapter{events: successEvents()}
	e, st := testEngine(t, 4, ad)
	w := &failTypesEventWriter{
		inner:     storeEventWriter{st: st},
		failTypes: map[string]error{"result": errors.New("injected: result store down")},
	}
	e.setEventWriter(w)

	task, err := e.Create(context.Background(), CreateRequest{
		Agent: "claude-code", Cwd: "/tmp", Prompt: "do work",
	})
	if err != nil {
		t.Fatal(err)
	}
	final := waitStatus(t, e, task.ID, StatusFailed, 3*time.Second)
	if final.Status == StatusSucceeded {
		t.Fatalf("task must not succeed when final result cannot be persisted: %#v", final)
	}

	evs, err := e.Events(context.Background(), task.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, ev := range evs {
		if ev.Type == "result" {
			t.Fatalf("result must not be in store when append failed; events=%v", eventTypes(evs))
		}
	}
}

func TestUserVisibleMessagePersistFailurePreventsSuccess(t *testing.T) {
	// Orchestrated path emits a final summary message before result.
	// Fail that user-visible message and ensure the task does not succeed.
	host := &fakeAdapter{events: successEvents()}
	worker := &fakeAdapter{events: []adapter.Event{
		{Type: "task_started", Payload: json.RawMessage(`{"session_id":"w1"}`)},
		{Type: "message", Payload: json.RawMessage(`{"role":"assistant","content":[{"type":"text","text":"worker done"}],"partial":false}`)},
		{Type: "result", Payload: json.RawMessage(`{"is_error":false}`)},
	}}
	e, st := testEngine(t, 4, host)
	e.putAdapter("kin", host)
	e.putAdapter("claude-code", worker)
	e.SetDefaultAgentFn(func() string { return "kin" })

	// Custom writer that fails only summary-phase messages.
	sw := &selectiveFailWriter{inner: storeEventWriter{st: st}}
	e.setEventWriter(sw)

	task, err := e.Create(context.Background(), CreateRequest{
		Agent:  "kin",
		Cwd:    "/tmp",
		Prompt: "please @claude-code investigate",
	})
	if err != nil {
		t.Fatal(err)
	}
	final := waitStatus(t, e, task.ID, StatusFailed, 5*time.Second)
	if final.Status == StatusSucceeded {
		t.Fatalf("summary persist failure must not leave task succeeded: %#v", final)
	}
}

// selectiveFailWriter fails message appends whose payload has phase=summary.
type selectiveFailWriter struct {
	inner eventWriter
	mu    sync.Mutex
	calls []string
}

func (w *selectiveFailWriter) AppendEvent(ctx context.Context, taskID, typ string, payload json.RawMessage) (store.Event, error) {
	w.mu.Lock()
	w.calls = append(w.calls, typ)
	w.mu.Unlock()
	if typ == "message" {
		var m map[string]any
		if json.Unmarshal(payload, &m) == nil {
			if phase, _ := m["phase"].(string); phase == PhaseSummary {
				return store.Event{}, errors.New("injected: summary message store down")
			}
		}
	}
	return w.inner.AppendEvent(ctx, taskID, typ, payload)
}

func (w *selectiveFailWriter) AppendUsageEvent(ctx context.Context, taskID, typ string, payload json.RawMessage, record store.UsageRecord) (store.Event, store.Task, error) {
	return w.inner.AppendUsageEvent(ctx, taskID, typ, payload, record)
}

func TestPartialProgressPersistFailureDegradesButAllowsSuccess(t *testing.T) {
	// Fail only tool_use (disposable partial); result still lands → succeeded,
	// and a diagnostic appears once the store accepts writes again.
	ad := &fakeAdapter{events: []adapter.Event{
		{Type: "task_started", Payload: json.RawMessage(`{"session_id":"s1"}`)},
		{Type: "tool_use", Payload: json.RawMessage(`{"tool_use_id":"t1","name":"bash","input":{"command":"echo hi"}}`)},
		{Type: "message", Payload: json.RawMessage(`{"role":"assistant","content":[{"type":"text","text":"hi"}],"partial":false}`)},
		{Type: "result", Payload: json.RawMessage(`{"is_error":false,"tokens_in":1,"tokens_out":1}`)},
	}}
	e, st := testEngine(t, 4, ad)
	w := &failTypesEventWriter{
		inner:         storeEventWriter{st: st},
		failOnceTypes: map[string]error{"tool_use": errors.New("injected: tool_use store blip")},
	}
	e.setEventWriter(w)

	task, err := e.Create(context.Background(), CreateRequest{
		Agent: "claude-code", Cwd: "/tmp", Prompt: "tool then answer",
	})
	if err != nil {
		t.Fatal(err)
	}
	final := waitStatus(t, e, task.ID, StatusSucceeded, 3*time.Second)
	if final.Status != StatusSucceeded {
		t.Fatalf("disposable partial failure must not force fail: status=%s", final.Status)
	}

	evs, err := e.Events(context.Background(), task.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	var sawResult, sawDiagnostic bool
	for _, ev := range evs {
		if ev.Type == "result" {
			sawResult = true
		}
		if ev.Type == "raw_output" && strings.Contains(string(ev.Payload), "persistence degraded") {
			sawDiagnostic = true
		}
		if ev.Type == "tool_use" {
			t.Fatalf("failed tool_use must not be stored; payload=%s", ev.Payload)
		}
	}
	if !sawResult {
		t.Fatal("expected result to persist after store recovered")
	}
	if !sawDiagnostic {
		t.Fatalf("expected observable degradation diagnostic after recovery; types=%v", eventTypes(evs))
	}
}

func TestApprovalDecidedPersistFailureIsExplicit(t *testing.T) {
	// Decision is recorded in approvals table, but missing approval_decided
	// event must surface as an error rather than silent success.
	ad := &holdForApprovalAdapter{}
	e, st := testEngine(t, 4, ad)
	// Register as claude-code so approval path works if needed.
	_ = st

	task, err := e.Create(context.Background(), CreateRequest{
		Agent: "claude-code", Cwd: "/tmp", Prompt: "need approval",
	})
	if err != nil {
		t.Fatal(err)
	}
	// Wait until running so we can request approval.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		t1, _ := e.Get(context.Background(), task.ID)
		if t1.Status == StatusRunning || t1.Status == StatusWaitingApproval {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	a, err := e.RequestApproval(context.Background(), CreateApprovalRequest{
		TaskID:  task.ID,
		Kind:    "tool_use",
		Payload: json.RawMessage(`{"tool":"bash"}`),
	})
	if err != nil {
		t.Fatal(err)
	}

	w := &failTypesEventWriter{
		inner:     storeEventWriter{st: st},
		failTypes: map[string]error{"approval_decided": errors.New("injected: approval event store down")},
	}
	e.setEventWriter(w)

	_, err = e.Decide(context.Background(), a.ID, store.DecisionApproved, "web")
	if err == nil {
		t.Fatal("expected Decide to return error when approval_decided cannot be persisted")
	}
	if !strings.Contains(err.Error(), "approval_decided") && !strings.Contains(err.Error(), "persist") && !strings.Contains(err.Error(), "injected") {
		t.Fatalf("error should mention persistence failure: %v", err)
	}

	// Approval row itself is decided.
	got, err := st.GetApproval(context.Background(), a.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Decision != store.DecisionApproved {
		t.Fatalf("decision row should still be recorded: %#v", got)
	}
}

func TestIsCriticalEvent(t *testing.T) {
	cases := []struct {
		typ     string
		payload string
		want    bool
	}{
		{"result", `{"is_error":false}`, true},
		{"error", `{"message":"x"}`, true},
		{"approval_requested", `{}`, true},
		{"approval_decided", `{}`, true},
		{"tool_use", `{}`, false},
		{"raw_output", `{}`, false},
		{"usage", `{}`, false},
		{"message", `{"role":"user","text":"hi"}`, true},
		{"message", `{"role":"assistant","partial":true,"text":"…"}`, false},
		{"message", `{"role":"assistant","phase":"summary","visibility":{"user":true,"task":true}}`, true},
		{"message", `{"role":"assistant","visibility":{"user":false,"task":true}}`, false},
		{"message", `{"role":"assistant","source":"orchestrator","phase":"plan"}`, true},
	}
	for _, tc := range cases {
		got := isCriticalEvent(tc.typ, json.RawMessage(tc.payload))
		if got != tc.want {
			t.Fatalf("isCriticalEvent(%q, %s)=%v want %v", tc.typ, tc.payload, got, tc.want)
		}
	}
}

func eventTypes(evs []store.Event) []string {
	out := make([]string, len(evs))
	for i, ev := range evs {
		out[i] = fmt.Sprintf("%d:%s", ev.Seq, ev.Type)
	}
	return out
}
