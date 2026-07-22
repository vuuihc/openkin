package task

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vuuihc/kin/internal/adapter"
	"github.com/vuuihc/kin/internal/store"
)

// holdForApprovalAdapter emits nothing until cancelled; captures TaskSpecs.
type holdForApprovalAdapter struct {
	mu    sync.Mutex
	specs []adapter.TaskSpec
	// per-start hold channels closed by test after inspecting approval
	started chan adapter.TaskSpec
}

func (a *holdForApprovalAdapter) Start(ctx context.Context, spec adapter.TaskSpec) (adapter.RunHandle, error) {
	a.mu.Lock()
	a.specs = append(a.specs, spec)
	a.mu.Unlock()
	if a.started != nil {
		select {
		case a.started <- spec:
		default:
		}
	}
	ch := make(chan adapter.Event)
	h := &fakeHandle{ch: ch, cancelCh: make(chan struct{})}
	go func() {
		defer close(ch)
		select {
		case <-h.cancelCh:
		case <-ctx.Done():
		case <-time.After(30 * time.Second):
		}
	}()
	return h, nil
}

func TestWorkerExecutionIDsDistinctAndRetried(t *testing.T) {
	// Two workers, second returns meta-only once so it retries → 3 starts total.
	metaPayload, _ := json.Marshal(map[string]any{
		"role":    "assistant",
		"content": []map[string]string{{"type": "text", "text": "I am a task worker; reply with findings only."}},
		"partial": false,
	})
	okPayload, _ := json.Marshal(map[string]any{
		"role":    "assistant",
		"content": []map[string]string{{"type": "text", "text": "real findings from worker"}},
		"partial": false,
	})
	// Result without a text body so chooseWorkerSummary falls back to the message
	// (mirrors TestWorkerRetryMessageUsesSessionHostSpeaker).
	resultDone := json.RawMessage(`{"is_error":false,"subtype":"success"}`)

	claude := &fakeAdapter{events: []adapter.Event{
		{Type: "task_started", Payload: json.RawMessage(`{"session_id":"w1"}`)},
		{Type: "message", Payload: okPayload},
		{Type: "result", Payload: resultDone},
	}}
	// First start: meta; second (retry): real answer.
	codexDyn := &seqAdapter{batches: [][]adapter.Event{
		{
			{Type: "task_started", Payload: json.RawMessage(`{"session_id":"c1"}`)},
			{Type: "message", Payload: metaPayload},
			{Type: "result", Payload: resultDone},
		},
		{
			{Type: "task_started", Payload: json.RawMessage(`{"session_id":"c2"}`)},
			{Type: "message", Payload: okPayload},
			{Type: "result", Payload: resultDone},
		},
	}}

	host := &fakeAdapter{events: successEvents()}
	e, _ := testEngine(t, 4, host)
	e.putAdapter("kin", host)
	e.putAdapter("claude-code", claude)
	e.putAdapter("codex", codexDyn)
	e.SetDefaultAgentFn(func() string { return "kin" })
	// Force multi-worker plan via @mentions.
	ctx := context.Background()
	task, err := e.Create(ctx, CreateRequest{
		Agent:  "kin",
		Cwd:    "/tmp",
		Prompt: "please @claude-code and @codex investigate",
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 5*time.Second)

	claude.mu.Lock()
	cs := append([]adapter.TaskSpec(nil), claude.specs...)
	claude.mu.Unlock()
	codexDyn.mu.Lock()
	xs := append([]adapter.TaskSpec(nil), codexDyn.specs...)
	codexDyn.mu.Unlock()

	if len(cs) < 1 {
		t.Fatalf("claude starts=%d", len(cs))
	}
	if len(xs) < 2 {
		t.Fatalf("codex starts=%d want >=2 (initial+retry)", len(xs))
	}

	ids := map[string]bool{}
	for _, sp := range append(cs, xs...) {
		if sp.ID != task.ID {
			t.Fatalf("parent task id rewritten: %q want %q", sp.ID, task.ID)
		}
		if sp.Execution.ID == "" {
			t.Fatalf("missing execution id on spec: %+v", sp.Execution)
		}
		if ids[sp.Execution.ID] {
			t.Fatalf("duplicate execution id %s", sp.Execution.ID)
		}
		ids[sp.Execution.ID] = true
		if sp.Execution.Step <= 0 {
			t.Fatalf("execution step unset: %+v", sp.Execution)
		}
		if sp.Execution.Agent == "" {
			t.Fatalf("execution agent unset: %+v", sp.Execution)
		}
	}
	if len(ids) < 3 {
		t.Fatalf("want >=3 distinct execution ids, got %d (%v)", len(ids), ids)
	}

	// Worker events carry execution_id.
	evs, err := e.Events(ctx, task.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	var sawExecMeta int
	for _, ev := range evs {
		var m map[string]any
		if err := json.Unmarshal(ev.Payload, &m); err != nil {
			continue
		}
		if eid, ok := m["execution_id"].(string); ok && eid != "" {
			if m["execution_agent"] == nil && m["speaker"] == nil {
				t.Fatalf("execution_id without agent/speaker: %v", m)
			}
			sawExecMeta++
		}
	}
	if sawExecMeta == 0 {
		t.Fatal("expected worker events stamped with execution_id")
	}
}

// seqAdapter returns a different event batch for each Start call.
type seqAdapter struct {
	mu      sync.Mutex
	specs   []adapter.TaskSpec
	batches [][]adapter.Event
	idx     int
}

func (a *seqAdapter) Start(ctx context.Context, spec adapter.TaskSpec) (adapter.RunHandle, error) {
	a.mu.Lock()
	a.specs = append(a.specs, spec)
	i := a.idx
	if i >= len(a.batches) {
		i = len(a.batches) - 1
	}
	batch := a.batches[i]
	a.idx++
	a.mu.Unlock()
	ch := make(chan adapter.Event, len(batch)+1)
	h := &fakeHandle{ch: ch, cancelCh: make(chan struct{})}
	go func() {
		defer close(ch)
		for _, ev := range batch {
			select {
			case <-h.cancelCh:
				return
			case ch <- ev:
			}
		}
	}()
	return h, nil
}

func TestRequestApprovalCarriesExecution(t *testing.T) {
	ad := &fakeAdapter{
		events: []adapter.Event{
			{Type: "task_started", Payload: json.RawMessage(`{"session_id":"s1"}`)},
		},
		runFor: 30 * time.Second,
	}
	e, _ := testEngine(t, 4, ad)
	ctx := context.Background()
	task, err := e.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: "/tmp", Prompt: "x"})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusRunning, 2*time.Second)

	a, err := e.RequestApproval(ctx, CreateApprovalRequest{
		TaskID:         task.ID,
		Kind:           "tool_use",
		Payload:        json.RawMessage(`{"tool_name":"Write"}`),
		ExecutionID:    "01EXECRUNTEST0000000001",
		ExecutionAgent: "codex",
		ExecutionStep:  2,
		ExecutionModel: "gpt-test",
	})
	if err != nil {
		t.Fatal(err)
	}
	if a.TaskID != task.ID {
		t.Fatalf("task_id=%s", a.TaskID)
	}
	if a.ExecutionID == nil || *a.ExecutionID != "01EXECRUNTEST0000000001" {
		t.Fatalf("execution_id=%v", a.ExecutionID)
	}
	if a.ExecutionAgent == nil || *a.ExecutionAgent != "codex" {
		t.Fatalf("execution_agent=%v", a.ExecutionAgent)
	}
	if a.ExecutionStep == nil || *a.ExecutionStep != 2 {
		t.Fatalf("execution_step=%v", a.ExecutionStep)
	}
	if a.ExecutionModel == nil || *a.ExecutionModel != "gpt-test" {
		t.Fatalf("execution_model=%v", a.ExecutionModel)
	}

	// Two workers / two approvals share parent task, different execution ids.
	b, err := e.RequestApproval(ctx, CreateApprovalRequest{
		TaskID:         task.ID,
		Kind:           "tool_use",
		Payload:        json.RawMessage(`{"tool_name":"Bash"}`),
		ExecutionID:    "01EXECRUNTEST0000000002",
		ExecutionAgent: "claude-code",
		ExecutionStep:  1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if b.TaskID != a.TaskID {
		t.Fatal("approvals must share parent task_id")
	}
	if b.ExecutionID == nil || *b.ExecutionID == *a.ExecutionID {
		t.Fatalf("execution ids must differ: %v vs %v", a.ExecutionID, b.ExecutionID)
	}

	// Historical-compatible: omit execution fields.
	c, err := e.RequestApproval(ctx, CreateApprovalRequest{
		TaskID:  task.ID,
		Kind:    "tool_use",
		Payload: json.RawMessage(`{}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if c.ExecutionID != nil || c.ExecutionAgent != nil {
		t.Fatalf("expected null execution on legacy request, got %+v", c)
	}

	// approval_requested event carries execution metadata when present.
	evs, _ := e.Events(ctx, task.ID, 0)
	var found bool
	for _, ev := range evs {
		if ev.Type != "approval_requested" {
			continue
		}
		var m map[string]any
		_ = json.Unmarshal(ev.Payload, &m)
		if m["approval_id"] == a.ID {
			if m["execution_id"] != "01EXECRUNTEST0000000001" {
				t.Fatalf("event execution_id=%v", m["execution_id"])
			}
			if m["execution_agent"] != "codex" {
				t.Fatalf("event execution_agent=%v", m["execution_agent"])
			}
			found = true
		}
	}
	if !found {
		t.Fatal("approval_requested event missing execution metadata")
	}
}

func TestStampWorkerExecutionMeta(t *testing.T) {
	got := stampWorker(json.RawMessage(`{"role":"assistant"}`), "codex", "gpt-x",
		adapter.ExecutionRef{ID: "exec-9", Step: 3, Agent: "codex", Model: "gpt-x"})
	var payload map[string]any
	if err := json.Unmarshal(got, &payload); err != nil {
		t.Fatal(err)
	}
	if payload["execution_id"] != "exec-9" {
		t.Fatalf("execution_id=%v", payload["execution_id"])
	}
	if int(payload["execution_step"].(float64)) != 3 {
		t.Fatalf("execution_step=%v", payload["execution_step"])
	}
	if payload["execution_agent"] != "codex" {
		t.Fatalf("execution_agent=%v", payload["execution_agent"])
	}
	if !strings.Contains(string(got), "execution_model") {
		t.Fatalf("missing execution_model in %s", got)
	}
}

func TestRequestApprovalRejectsPartialExecution(t *testing.T) {
	ad := &fakeAdapter{events: successEvents()}
	e, _ := testEngine(t, 2, ad)
	ctx := context.Background()
	task, err := e.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: "/tmp", Prompt: "hi"})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 3*time.Second)
	// Re-open task as running for approval API.
	running := StatusRunning
	if err := e.store.UpdateTask(ctx, task.ID, store.TaskPatch{Status: &running}); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name string
		req  CreateApprovalRequest
	}{
		{
			name: "agent without id",
			req: CreateApprovalRequest{
				TaskID: task.ID, Kind: "tool_use", Payload: json.RawMessage(`{}`),
				ExecutionAgent: "codex",
			},
		},
		{
			name: "step without id",
			req: CreateApprovalRequest{
				TaskID: task.ID, Kind: "tool_use", Payload: json.RawMessage(`{}`),
				ExecutionStep: 1,
			},
		},
		{
			name: "model without id",
			req: CreateApprovalRequest{
				TaskID: task.ID, Kind: "tool_use", Payload: json.RawMessage(`{}`),
				ExecutionModel: "gpt-x",
			},
		},
		{
			name: "id without agent",
			req: CreateApprovalRequest{
				TaskID: task.ID, Kind: "tool_use", Payload: json.RawMessage(`{}`),
				ExecutionID: "01EXECONLY0000000000001",
			},
		},
		{
			name: "worker id without positive step is still host-shaped (id+agent) — allowed",
			req: CreateApprovalRequest{
				TaskID: task.ID, Kind: "tool_use", Payload: json.RawMessage(`{}`),
				ExecutionID: "01EXECHOST0000000000001", ExecutionAgent: "claude-code",
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := e.RequestApproval(ctx, tc.req)
			wantErr := tc.name != "worker id without positive step is still host-shaped (id+agent) — allowed"
			if wantErr && err == nil {
				t.Fatal("expected error")
			}
			if !wantErr && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

func TestRequestApprovalHistoricalEmptyExecution(t *testing.T) {
	ad := &fakeAdapter{events: successEvents()}
	e, _ := testEngine(t, 2, ad)
	ctx := context.Background()
	task, err := e.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: "/tmp", Prompt: "hi"})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 3*time.Second)
	running := StatusRunning
	if err := e.store.UpdateTask(ctx, task.ID, store.TaskPatch{Status: &running}); err != nil {
		t.Fatal(err)
	}
	a, err := e.RequestApproval(ctx, CreateApprovalRequest{
		TaskID: task.ID, Kind: "tool_use", Payload: json.RawMessage(`{"tool_name":"Bash"}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if a.ExecutionID != nil || a.ExecutionAgent != nil || a.ExecutionStep != nil || a.ExecutionModel != nil {
		t.Fatalf("historical empty must not invent attribution: %+v", a)
	}
}

type errReader struct{}

func (errReader) Read([]byte) (int, error) { return 0, errors.New("entropy exhausted") }

func TestHostStartFailsWhenExecutionIDUnavailable(t *testing.T) {
	ad := &fakeAdapter{events: successEvents()}
	e, _ := testEngine(t, 2, ad)
	ctx := context.Background()

	// Allocate task id while entropy works, then break it before startOne.
	id, err := e.newID()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UnixMilli()
	if err := e.store.InsertTask(ctx, store.Task{
		ID: id, Title: "x", Agent: "claude-code", Cwd: "/tmp", Prompt: "p",
		Status: StatusQueued, CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	e.entropy = errReader{}
	e.mu.Lock()
	e.queue = append(e.queue, id)
	e.mu.Unlock()
	e.pump()

	got := waitStatus(t, e, id, StatusFailed, 3*time.Second)
	if got.Status != StatusFailed {
		t.Fatalf("status=%s", got.Status)
	}
	evs, err := e.Events(ctx, id, 0)
	if err != nil {
		t.Fatal(err)
	}
	var saw bool
	for _, ev := range evs {
		if ev.Type == "error" && strings.Contains(string(ev.Payload), "execution id") {
			saw = true
			break
		}
	}
	if !saw {
		t.Fatalf("expected execution id error event, events=%v", evs)
	}
}

func TestNormalizeExecutionAttribution(t *testing.T) {
	// Historical empty.
	id, agent, step, model, err := normalizeExecutionAttribution("", "", 0, "")
	if err != nil || id != "" || agent != "" || step != 0 || model != "" {
		t.Fatalf("empty: %q %q %d %q err=%v", id, agent, step, model, err)
	}
	// Partial without id.
	if _, _, _, _, err := normalizeExecutionAttribution("", "codex", 0, ""); err == nil {
		t.Fatal("agent without id")
	}
	if _, _, _, _, err := normalizeExecutionAttribution("", "", 2, ""); err == nil {
		t.Fatal("step without id")
	}
	if _, _, _, _, err := normalizeExecutionAttribution("", "", 0, "m"); err == nil {
		t.Fatal("model without id")
	}
	// id without agent.
	if _, _, _, _, err := normalizeExecutionAttribution("E1", "", 1, ""); err == nil {
		t.Fatal("id without agent")
	}
	// Host-shaped: id+agent, step 0.
	id, agent, step, model, err = normalizeExecutionAttribution("E1", "claude-code", 0, "sonnet")
	if err != nil || id != "E1" || agent != "claude-code" || step != 0 || model != "sonnet" {
		t.Fatalf("host: %q %q %d %q err=%v", id, agent, step, model, err)
	}
	// Worker-shaped: positive step.
	id, agent, step, model, err = normalizeExecutionAttribution("E2", "codex", 2, "gpt")
	if err != nil || step != 2 {
		t.Fatalf("worker: %q %q %d %q err=%v", id, agent, step, model, err)
	}
}
