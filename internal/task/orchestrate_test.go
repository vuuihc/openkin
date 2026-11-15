package task

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/store"
)

func TestForwardWorkerEventsRecordsUsageLedger(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	const taskID = "01WORKERUSAGE0000000000001"
	if err := st.InsertTask(context.Background(), store.Task{
		ID: taskID, Title: "usage", Agent: "kin", Cwd: "/tmp", Prompt: "p",
		Status: StatusRunning, CreatedAt: store.NowMilli(),
	}); err != nil {
		t.Fatal(err)
	}
	engine := NewEngine(st, nil, NewBus(), 1)
	engine.setActiveRun(taskID, "turn-1")
	ch := make(chan adapter.Event, 2)
	ch <- adapter.Event{Type: "usage", Payload: json.RawMessage(`{
		"agent":"codex","model":"gpt-5-codex",
		"input_tokens":12,"output_tokens":3
	}`)}
	ch <- adapter.Event{Type: "result", Payload: json.RawMessage(`{"is_error":false,"result":"done"}`)}
	close(ch)

	_, failed, _ := engine.forwardWorkerEvents(
		context.Background(),
		taskID,
		"turn-1",
		"codex",
		"gpt-5-codex",
		adapter.ExecutionRef{ID: "exec-1", Agent: "codex"},
		&fakeHandle{ch: ch, cancelCh: make(chan struct{})},
	)
	if failed {
		t.Fatal("worker unexpectedly failed")
	}
	records, err := st.ListUsageRecords(context.Background(), taskID)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 || records[0].InputTokens == nil || *records[0].InputTokens != 12 {
		t.Fatalf("usage records=%+v", records)
	}
	got, err := st.GetTask(context.Background(), taskID)
	if err != nil {
		t.Fatal(err)
	}
	if got.TokensIn != 12 || got.TokensOut != 3 {
		t.Fatalf("task usage=%d/%d", got.TokensIn, got.TokensOut)
	}
}

func TestStampAgentModel(t *testing.T) {
	tests := []struct {
		name       string
		raw        json.RawMessage
		selected   string
		wantModel  string
		wantAbsent bool
	}{
		{
			name:      "selected model is added",
			raw:       json.RawMessage(`{"role":"assistant"}`),
			selected:  "openai/gpt-5.5",
			wantModel: "openai/gpt-5.5",
		},
		{
			name:      "adapter reported model wins",
			raw:       json.RawMessage(`{"role":"assistant","model":"claude-opus-4-1"}`),
			selected:  "opus",
			wantModel: "claude-opus-4-1",
		},
		{
			name:       "empty model is omitted",
			raw:        json.RawMessage(`{"role":"assistant"}`),
			selected:   "",
			wantAbsent: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := stampSpeaker(tt.raw, "kin", tt.selected, adapter.ExecutionRef{})
			var payload map[string]any
			if err := json.Unmarshal(got, &payload); err != nil {
				t.Fatalf("unmarshal stamped payload: %v", err)
			}
			model, exists := payload["model"]
			if tt.wantAbsent {
				if exists {
					t.Fatalf("model unexpectedly present: %#v", model)
				}
				return
			}
			if model != tt.wantModel {
				t.Fatalf("model=%#v want %q", model, tt.wantModel)
			}
		})
	}
}

func TestStampWorkerModel(t *testing.T) {
	got := stampWorker(json.RawMessage(`{"role":"assistant"}`), "codex", "gpt-5.5-codex", adapter.ExecutionRef{ID: "exec-1", Step: 2, Agent: "codex", Model: "gpt-5.5-codex"}, "")
	var payload map[string]any
	if err := json.Unmarshal(got, &payload); err != nil {
		t.Fatalf("unmarshal stamped payload: %v", err)
	}
	if payload["model"] != "gpt-5.5-codex" {
		t.Fatalf("model=%#v want gpt-5.5-codex", payload["model"])
	}
	visibility, _ := payload["visibility"].(map[string]any)
	if visibility["user"] != false || visibility["task"] != true {
		t.Fatalf("visibility=%#v want task-only", visibility)
	}
}

func TestEffectiveStepModel(t *testing.T) {
	opus := "opus"
	claudeOpus := "claude-opus-4-8"
	cases := []struct {
		name string
		task store.Task
		step DelegateStep
		want string
	}{
		{
			name: "explicit step model normalized for worker agent",
			task: store.Task{Agent: "claude-code", Model: &opus},
			step: DelegateStep{Agent: "claude-code", Model: "haiku"},
			want: "claude-haiku-4-5",
		},
		{
			name: "cross-agent bare @kin does not inherit host opus",
			task: store.Task{Agent: "claude-code", Model: &opus},
			step: DelegateStep{Agent: "kin", Model: ""},
			want: "",
		},
		{
			name: "cross-agent bare @codex does not inherit host model",
			task: store.Task{Agent: "kin", Model: &claudeOpus},
			step: DelegateStep{Agent: "codex", Model: ""},
			want: "",
		},
		{
			name: "same-agent without step model may use host model",
			task: store.Task{Agent: "claude-code", Model: &opus},
			step: DelegateStep{Agent: "claude-code", Model: ""},
			want: "opus",
		},
		{
			name: "explicit @kin[full-id] kept",
			task: store.Task{Agent: "claude-code", Model: &opus},
			step: DelegateStep{Agent: "kin", Model: "provider/my-model"},
			want: "provider/my-model",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := effectiveStepModel(tc.task, tc.step)
			if got != tc.want {
				t.Fatalf("effectiveStepModel=%q want %q", got, tc.want)
			}
		})
	}
}

// No worker event claims a place in the host's chat column, whatever its type.
//
// Flipping these to user-facing is the tempting way to make a subagent panel
// easier to build -- the console's chat projection reads exactly this bit -- and
// it would print the subagent's commands as the host's own. The panel gets its
// data from the same event stream instead (plan §3.6).
//
// The events go through the forwarding loop the orchestrator runs, not through the
// stamping helper: the mistake this guards against is at the call site, and a test
// that calls the helper itself stays green while the loop stops stamping, or stamps
// workers as user-facing, and every worker event lands in the host's column.
func TestNoWorkerEventClaimsTheHostsChatColumn(t *testing.T) {
	ctx := context.Background()
	const taskID = "01WORKERVISIBILITY000000001"
	st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if err := st.InsertTask(ctx, store.Task{
		ID: taskID, Title: "visibility", Agent: "kin", Cwd: "/tmp", Prompt: "p",
		Status: StatusRunning, CreatedAt: store.NowMilli(),
	}); err != nil {
		t.Fatal(err)
	}
	engine := NewEngine(st, nil, NewBus(), 1)
	engine.setActiveRun(taskID, "turn-1")

	cases := []struct{ name, typ, payload string }{
		{"message", "message", `{"role":"assistant","content":[{"type":"text","text":"hi"}],"partial":false}`},
		{"tool_use", "tool_use", `{"name":"Bash","tool_name":"Bash","input":{"command":"ls"},"status":"running"}`},
		{"tool_result", "tool_result", `{"name":"Bash","tool_name":"Bash","output":"ok","ok":true,"status":"done"}`},
		{"raw_output", "raw_output", `{"text":"cli noise"}`},
		{"result", "result", `{"is_error":false,"result":"done"}`},
	}
	ch := make(chan adapter.Event, len(cases))
	for _, tc := range cases {
		ch <- adapter.Event{Type: tc.typ, Payload: json.RawMessage(tc.payload)}
	}
	close(ch)
	if _, failed, _ := engine.forwardWorkerEvents(
		ctx, taskID, "turn-1", "codex", "gpt-5.5-codex",
		adapter.ExecutionRef{ID: "exec-1", Step: 2, Agent: "codex", Model: "gpt-5.5-codex"},
		&fakeHandle{ch: ch, cancelCh: make(chan struct{})},
	); failed {
		t.Fatal("worker unexpectedly failed")
	}

	events, err := st.ListEvents(ctx, taskID, 0)
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, ev := range events {
		var payload map[string]any
		if err := json.Unmarshal(ev.Payload, &payload); err != nil {
			t.Fatalf("unmarshal %s payload: %v", ev.Type, err)
		}
		if ev.Type == "message" && payload["role"] == "user" {
			continue // the host's own turn, replayed, not a worker event
		}
		visibility, _ := payload["visibility"].(map[string]any)
		if visibility["user"] != false || visibility["task"] != true {
			t.Fatalf("%s landed with visibility=%#v, want task-only: a worker event in the host's chat column reads as the host's own work",
				ev.Type, visibility)
		}
		// The join key the panel needs has to survive whatever the payload was.
		step, _ := payload["execution_step"].(float64)
		if payload["execution_id"] != "exec-1" || int(step) != 2 {
			t.Fatalf("execution meta missing from %s: %#v", ev.Type, payload)
		}
		seen[ev.Type] = true
	}
	for _, tc := range cases {
		if !seen[tc.typ] {
			t.Fatalf("%s never reached the transcript, so nothing above checked it", tc.name)
		}
	}
}

// A worker's events carry the turn they belong to, not only the adapter
// attempt. The plan table stores the turn id per step, and a retry starts a
// new attempt under the same step: without this field the panel cannot join
// its plan to the stream, and the mistake is invisible -- the rows still draw,
// they just never line up.
func TestStampWorkerCarriesTheRunExecutionID(t *testing.T) {
	raw := stampWorker(
		json.RawMessage(`{"role":"assistant","text":"hi"}`),
		"claude", "sonnet",
		adapter.ExecutionRef{ID: "attempt-1", Step: 2, Agent: "claude"},
		"turn-1",
	)
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatal(err)
	}
	if payload["execution_id"] != "attempt-1" {
		t.Fatalf("execution_id=%#v want the adapter attempt", payload["execution_id"])
	}
	if payload["run_execution_id"] != "turn-1" {
		t.Fatalf("run_execution_id=%#v want turn-1", payload["run_execution_id"])
	}
	// The host's own stamp has no separate run: its execution id is the turn.
	host := stampAgent(json.RawMessage(`{"role":"assistant"}`), "kin", "m", false, adapter.ExecutionRef{ID: "turn-1"})
	payload = nil
	if err := json.Unmarshal(host, &payload); err != nil {
		t.Fatal(err)
	}
	if _, exists := payload["run_execution_id"]; exists {
		t.Fatal("a host event must not claim a worker run id")
	}
}

func waitWorkerStep(t *testing.T, st *store.Store, taskID, agent, status string, timeout time.Duration) store.WorkerStep {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		steps, err := st.ListWorkerSteps(context.Background(), taskID, "")
		if err != nil {
			t.Fatal(err)
		}
		for _, step := range steps {
			if step.Agent == agent && step.Status == status {
				return step
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("no %s step in status %q: %+v", agent, status, steps)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// Stopping one worker must not stop the turn. The stopped step reads canceled,
// the other worker finishes, the task succeeds, and the pending card the dead
// process left behind is resolved instead of asking for an answer nobody can
// use.
func TestCancelWorkerStepStopsOnlyThatWorker(t *testing.T) {
	ctx := context.Background()
	host := &fakeAdapter{events: successEvents()}
	started := adapter.Event{Type: "task_started", Payload: json.RawMessage(`{"session_id":"s1"}`)}
	claude := &fakeAdapter{events: []adapter.Event{started}, runFor: time.Hour}
	codex := &fakeAdapter{events: successEvents()}

	e, st := testEngine(t, 4, host)
	e.putAdapter("kin", host)
	e.putAdapter("claude-code", claude)
	e.putAdapter("codex", codex)
	e.SetDefaultAgentFn(func() string { return "kin" })

	task, err := e.Create(ctx, CreateRequest{
		Agent: "kin", Cwd: "/tmp",
		Prompt: "@claude-code investigate the flake @codex review the fix",
	})
	if err != nil {
		t.Fatal(err)
	}
	step := waitWorkerStep(t, st, task.ID, "claude-code", "running", 3*time.Second)

	// The card the stopped worker is waiting on, attributed the way its adapter
	// would attribute it: the attempt's execution id and the 1-based step.
	var execRef adapter.ExecutionRef
	if err := json.Unmarshal([]byte(step.ExecutionRef), &execRef); err != nil {
		t.Fatalf("decode step execution ref: %v", err)
	}
	if execRef.ID == "" {
		t.Fatal("the running step recorded no adapter execution id")
	}
	if _, err := e.RequestApproval(ctx, CreateApprovalRequest{
		TaskID:         task.ID,
		Kind:           "tool_use",
		ExecutionID:    execRef.ID,
		ExecutionAgent: "claude-code",
		ExecutionStep:  step.StepIndex + 1,
	}); err != nil {
		t.Fatalf("request approval: %v", err)
	}

	if err := e.CancelWorkerStep(ctx, task.ID, step.ExecutionID, step.StepIndex); err != nil {
		t.Fatalf("cancel worker step: %v", err)
	}

	finished := waitStatus(t, e, task.ID, StatusSucceeded, 3*time.Second)
	if finished.Status != StatusSucceeded {
		t.Fatalf("task status=%q want succeeded", finished.Status)
	}

	canceled := waitWorkerStep(t, st, task.ID, "claude-code", StatusCanceled, time.Second)
	if canceled.Error != "" {
		t.Fatalf("canceled step carries an error: %q", canceled.Error)
	}
	if canceled.ResultSummary != "" {
		t.Fatalf("canceled step carries findings: %q", canceled.ResultSummary)
	}
	reviewed := waitWorkerStep(t, st, task.ID, "codex", "succeeded", time.Second)
	if reviewed.StepIndex == canceled.StepIndex {
		t.Fatal("the two workers share a step index")
	}

	pending, err := st.ListPendingForTask(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 0 {
		t.Fatalf("a stopped worker's approval is still pending: %+v", pending)
	}

	// The events that belong to the stopped step still name the turn, which is
	// what lets the panel join them after the attempt id stops being current.
	events, err := st.ListEvents(ctx, task.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	// The summary has to say the answer is partial: a turn that lost one of its
	// two workers and reads as complete is the one thing the reader cannot
	// check after the fact.
	sawPartialNote := false
	for _, ev := range events {
		if strings.Contains(string(ev.Payload), "worker was stopped") {
			sawPartialNote = true
			break
		}
	}
	if !sawPartialNote {
		t.Fatal("the summary does not mention the stopped worker")
	}
	sawWorkerEvent := false
	for _, ev := range events {
		// Approvals carry their own execution attribution (written by the
		// approval path, not the worker stream), so the run stamp is not theirs.
		if ev.Type == "approval_requested" || ev.Type == "approval_decided" {
			continue
		}
		var payload map[string]any
		if err := json.Unmarshal(ev.Payload, &payload); err != nil {
			continue
		}
		if payload["run_execution_id"] != step.ExecutionID {
			continue
		}
		sawWorkerEvent = true
		if payload["execution_id"] == step.ExecutionID {
			t.Fatalf("%s event: attempt id equals the run id, so this proves nothing", ev.Type)
		}
	}
	if !sawWorkerEvent {
		t.Fatal("no event from the stopped worker was stored")
	}
}

// A plan whose only worker was stopped has nothing to report. Calling that
// turn succeeded would tell the reader -- and anything watching the task
// status -- that work was delivered when they ended it.
func TestStoppingEveryWorkerEndsTheTaskCanceled(t *testing.T) {
	ctx := context.Background()
	host := &fakeAdapter{events: successEvents()}
	started := adapter.Event{Type: "task_started", Payload: json.RawMessage(`{"session_id":"s1"}`)}
	claude := &fakeAdapter{events: []adapter.Event{started}, runFor: time.Hour}

	e, st := testEngine(t, 4, host)
	e.putAdapter("kin", host)
	e.putAdapter("claude-code", claude)
	e.SetDefaultAgentFn(func() string { return "kin" })

	task, err := e.Create(ctx, CreateRequest{
		Agent: "kin", Cwd: "/tmp",
		Prompt: "@claude-code investigate the flake",
	})
	if err != nil {
		t.Fatal(err)
	}
	step := waitWorkerStep(t, st, task.ID, "claude-code", "running", 3*time.Second)
	if err := e.CancelWorkerStep(ctx, task.ID, step.ExecutionID, step.StepIndex); err != nil {
		t.Fatalf("cancel worker step: %v", err)
	}

	finished := waitStatus(t, e, task.ID, StatusCanceled, 3*time.Second)
	if finished.Status != StatusCanceled {
		t.Fatalf("task status=%q want canceled", finished.Status)
	}
	events, err := st.ListEvents(ctx, task.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	sawSummary := false
	for _, ev := range events {
		if strings.Contains(string(ev.Payload), "The only worker was stopped") {
			sawSummary = true
			break
		}
	}
	if !sawSummary {
		t.Fatal("the turn ended without saying the worker was stopped")
	}
}

// A stop the panel retries, or a second device sends, must not hand the step
// back to the retry paths. The second call succeeds because the step is
// already doing what was asked, and the mark that keeps the worker's own
// goroutine from reading the kill as a crash stays in place.
func TestCancelWorkerStepTwiceKeepsTheStepStopped(t *testing.T) {
	ctx := context.Background()
	e, st := testEngine(t, 1, &fakeAdapter{events: successEvents()})
	const taskID = "01CANCELIDEMPOTENT000000001"
	const runID = "run-1"
	if err := st.InsertTask(ctx, store.Task{
		ID: taskID, Title: "stop", Agent: "kin", Cwd: "/tmp", Prompt: "stop it",
		Status: StatusRunning, CreatedAt: store.NowMilli(),
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.InsertWorkerPlan(ctx, []store.WorkerStep{{
		TaskID: taskID, ExecutionID: runID, StepIndex: 0,
		Agent: "claude-code", Status: "running", Attempt: 1,
		CreatedAt: store.NowMilli(),
	}}); err != nil {
		t.Fatal(err)
	}
	e.setActiveRun(taskID, runID)
	handle := &fakeHandle{ch: make(chan adapter.Event), cancelCh: make(chan struct{})}
	if !e.registerWorkerStepHandle(taskID, runID, 0, handle) {
		t.Fatal("the step handle was refused")
	}

	if err := e.CancelWorkerStep(ctx, taskID, runID, 0); err != nil {
		t.Fatalf("first cancel: %v", err)
	}
	if !e.workerStepCanceled(taskID, runID, 0) {
		t.Fatal("the step is not marked stopped after the cancel")
	}
	// The row is already canceled now; the second request must neither fail nor
	// drop the mark.
	if err := e.CancelWorkerStep(ctx, taskID, runID, 0); err != nil {
		t.Fatalf("second cancel: %v", err)
	}
	if !e.workerStepCanceled(taskID, runID, 0) {
		t.Fatal("the second cancel dropped the stop mark")
	}
	steps, err := st.ListWorkerSteps(ctx, taskID, runID)
	if err != nil {
		t.Fatal(err)
	}
	if len(steps) != 1 || steps[0].Status != StatusCanceled {
		t.Fatalf("steps=%+v want one canceled row", steps)
	}

	// A retry that starts after the stop is refused and killed on arrival; the
	// step it would have resurrected stays canceled.
	retry := &fakeHandle{ch: make(chan adapter.Event), cancelCh: make(chan struct{})}
	if e.registerWorkerStepHandle(taskID, runID, 0, retry) {
		t.Fatal("a stopped step accepted a new attempt")
	}
	if !retry.canceled {
		t.Fatal("the refused attempt was left running")
	}
}

// A row another path already made terminal, with the process still registered,
// is the other way the status write can find nothing to change. The process is
// killed either way, so the cancel is a success and the mark has to survive:
// dropping it here is what would let the worker's own goroutine read the kill
// as a crash and start the step again.
func TestCancelWorkerStepKeepsTheMarkWhenTheRowIsAlreadyTerminal(t *testing.T) {
	ctx := context.Background()
	e, st := testEngine(t, 1, &fakeAdapter{events: successEvents()})
	const taskID = "01CANCELTERMINALROW00000001"
	const runID = "run-terminal"
	if err := st.InsertTask(ctx, store.Task{
		ID: taskID, Title: "stop", Agent: "kin", Cwd: "/tmp", Prompt: "stop it",
		Status: StatusRunning, CreatedAt: store.NowMilli(),
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.InsertWorkerPlan(ctx, []store.WorkerStep{{
		TaskID: taskID, ExecutionID: runID, StepIndex: 0,
		Agent: "claude-code", Status: StatusCanceled, Attempt: 1,
		CreatedAt: store.NowMilli(),
	}}); err != nil {
		t.Fatal(err)
	}
	e.setActiveRun(taskID, runID)
	if !e.registerWorkerStepHandle(taskID, runID, 0, &fakeHandle{
		ch: make(chan adapter.Event), cancelCh: make(chan struct{}),
	}) {
		t.Fatal("the step handle was refused")
	}

	if err := e.CancelWorkerStep(ctx, taskID, runID, 0); err != nil {
		t.Fatalf("cancel with a terminal row: %v", err)
	}
	if !e.workerStepCanceled(taskID, runID, 0) {
		t.Fatal("the cancel dropped the stop mark when the row was already terminal")
	}
}

// A worker that already answered is not cancellable. The row the caller is
// looking at is stale, and the honest answer is a conflict, not a rewrite of a
// finished step.
func TestCancelWorkerStepRefusesWhenTheSkillIsOver(t *testing.T) {
	ctx := context.Background()
	host := &fakeAdapter{events: successEvents()}
	claude := &fakeAdapter{events: successEvents()}
	e, st := testEngine(t, 4, host)
	e.putAdapter("kin", host)
	e.putAdapter("claude-code", claude)
	e.SetDefaultAgentFn(func() string { return "kin" })

	task, err := e.Create(ctx, CreateRequest{Agent: "kin", Cwd: "/tmp", Prompt: "@claude-code review it"})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 3*time.Second)
	step := waitWorkerStep(t, st, task.ID, "claude-code", "succeeded", time.Second)
	err = e.CancelWorkerStep(ctx, task.ID, step.ExecutionID, step.StepIndex)
	if !errors.Is(err, ErrWorkerStepNotRunning) {
		t.Fatalf("cancel finished step err=%v want ErrWorkerStepNotRunning", err)
	}
}
