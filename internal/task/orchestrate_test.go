package task

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"

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
	got := stampWorker(json.RawMessage(`{"role":"assistant"}`), "codex", "gpt-5.5-codex", adapter.ExecutionRef{ID: "exec-1", Step: 2, Agent: "codex", Model: "gpt-5.5-codex"})
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
