package task

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/vuuihc/kin/internal/adapter"
	"github.com/vuuihc/kin/internal/store"
)

func TestWaitingApprovalTransition(t *testing.T) {
	ad := &fakeAdapter{
		events: []adapter.Event{
			{Type: "task_started", Payload: json.RawMessage(`{"session_id":"s1","subtype":"init"}`)},
		},
		runFor: 10 * time.Second,
	}
	e, _ := testEngine(t, 4, ad)
	ctx := context.Background()

	task, err := e.Create(ctx, CreateRequest{
		Agent: "claude-code", Cwd: "/tmp", Prompt: "write file",
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusRunning, 2*time.Second)

	a, err := e.RequestApproval(ctx, CreateApprovalRequest{
		TaskID:  task.ID,
		Kind:    "tool_use",
		Payload: json.RawMessage(`{"tool_name":"Write","input":{"file_path":"/tmp/x","content":"hi"}}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if a.Decision != store.DecisionPending {
		t.Fatalf("decision=%s", a.Decision)
	}

	got := waitStatus(t, e, task.ID, StatusWaitingApproval, 2*time.Second)
	if got.Status != StatusWaitingApproval {
		t.Fatalf("status=%s", got.Status)
	}

	evs, err := e.Events(ctx, task.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	var sawReq bool
	for _, ev := range evs {
		if ev.Type == "approval_requested" {
			sawReq = true
		}
	}
	if !sawReq {
		t.Fatal("missing approval_requested event")
	}

	decided, err := e.Decide(ctx, a.ID, store.DecisionApproved, "web")
	if err != nil {
		t.Fatal(err)
	}
	if decided.Decision != store.DecisionApproved {
		t.Fatalf("decision=%s", decided.Decision)
	}
	if decided.DecidedVia == nil || *decided.DecidedVia != "web" {
		t.Fatalf("via=%v", decided.DecidedVia)
	}

	running := waitStatus(t, e, task.ID, StatusRunning, 2*time.Second)
	if running.Status != StatusRunning {
		t.Fatalf("after approve status=%s", running.Status)
	}

	evs, _ = e.Events(ctx, task.ID, 0)
	var sawDec bool
	for _, ev := range evs {
		if ev.Type == "approval_decided" {
			sawDec = true
		}
	}
	if !sawDec {
		t.Fatal("missing approval_decided event")
	}
}

func TestApprovalExpiry(t *testing.T) {
	ad := &fakeAdapter{
		events: []adapter.Event{
			{Type: "task_started", Payload: json.RawMessage(`{"session_id":"s1","subtype":"init"}`)},
		},
		runFor: 30 * time.Second,
	}
	e, _ := testEngine(t, 4, ad)
	ctx := context.Background()

	base := time.Now()
	now := base
	e.SetClock(func() time.Time { return now })
	e.SetApprovalTTL(100 * time.Millisecond)

	task, err := e.Create(ctx, CreateRequest{
		Agent: "claude-code", Cwd: "/tmp", Prompt: "p",
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusRunning, 2*time.Second)

	a, err := e.RequestApproval(ctx, CreateApprovalRequest{
		TaskID:  task.ID,
		Kind:    "tool_use",
		Payload: json.RawMessage(`{"tool_name":"Bash","input":{"command":"rm -rf /"}}`),
	})
	if err != nil {
		t.Fatal(err)
	}

	now = base.Add(200 * time.Millisecond)
	n, err := e.ExpireStale(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("expired count=%d", n)
	}

	got, err := e.GetApproval(ctx, a.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Decision != store.DecisionExpired {
		t.Fatalf("decision=%s want expired", got.Decision)
	}
	if got.DecidedVia == nil || *got.DecidedVia != "timeout" {
		t.Fatalf("via=%v", got.DecidedVia)
	}

	// Wait path also expires.
	a2, err := e.RequestApproval(ctx, CreateApprovalRequest{
		TaskID:  task.ID,
		Kind:    "tool_use",
		Payload: json.RawMessage(`{"tool_name":"Bash","input":{"command":"echo"}}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	createdAt := a2.CreatedAt
	now = time.UnixMilli(createdAt).Add(200 * time.Millisecond)

	waited, err := e.WaitApproval(ctx, a2.ID, 50*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	if waited.Decision != store.DecisionExpired {
		t.Fatalf("wait decision=%s", waited.Decision)
	}
}

func TestFollowUpRequiresTerminalSession(t *testing.T) {
	ctx := context.Background()

	// Non-terminal reject.
	hang := &fakeAdapter{
		events: []adapter.Event{{Type: "task_started", Payload: json.RawMessage(`{"session_id":"x"}`)}},
		runFor: 5 * time.Second,
	}
	e2, st := testEngine(t, 4, hang)
	running, err := e2.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: "/tmp", Prompt: "x"})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e2, running.ID, StatusRunning, 2*time.Second)
	_, err = e2.FollowUp(ctx, running.ID, "more")
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("want conflict, got %v", err)
	}

	// No session_ref.
	now := store.NowMilli()
	id := "01NOSESS000000000000000001"
	if err := st.InsertTask(ctx, store.Task{
		ID: id, Title: "t", Agent: "claude-code", Cwd: "/tmp", Prompt: "p",
		Status: StatusSucceeded, CreatedAt: now, FinishedAt: &now,
	}); err != nil {
		t.Fatal(err)
	}
	_, err = e2.FollowUp(ctx, id, "more")
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("want conflict for no session, got %v", err)
	}
}

func TestFollowUpAccumulates(t *testing.T) {
	ctx := context.Background()
	multi := &multiShotAdapter{shots: [][]adapter.Event{successEvents(), successEvents()}}
	e, _ := testEngine(t, 4, multi)

	t1, err := e.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: "/tmp", Prompt: "first"})
	if err != nil {
		t.Fatal(err)
	}
	done := waitStatus(t, e, t1.ID, StatusSucceeded, 2*time.Second)
	cost1 := 0.0
	if done.CostUSD != nil {
		cost1 = *done.CostUSD
	}
	evs1, _ := e.Events(ctx, t1.ID, 0)

	t2, err := e.FollowUp(ctx, t1.ID, "second")
	if err != nil {
		t.Fatal(err)
	}
	if t2.ID != t1.ID {
		t.Fatalf("id changed: %s vs %s", t2.ID, t1.ID)
	}
	done2 := waitStatus(t, e, t1.ID, StatusSucceeded, 2*time.Second)
	if done2.CostUSD == nil || *done2.CostUSD <= cost1 {
		t.Fatalf("cost should accumulate: before=%v after=%v", cost1, done2.CostUSD)
	}
	evs2, _ := e.Events(ctx, t1.ID, 0)
	if len(evs2) <= len(evs1) {
		t.Fatalf("events should grow: %d → %d", len(evs1), len(evs2))
	}
	for i := 1; i < len(evs2); i++ {
		if evs2[i].Seq <= evs2[i-1].Seq {
			t.Fatalf("seq not increasing: %d then %d", evs2[i-1].Seq, evs2[i].Seq)
		}
	}
	// Tokens accumulate too.
	if done2.TokensIn < done.TokensIn*2 {
		t.Fatalf("tokens_in should accumulate: first=%d final=%d", done.TokensIn, done2.TokensIn)
	}
}

// multiShotAdapter returns a different event sequence on each Start.
type multiShotAdapter struct {
	mu    sync.Mutex
	n     int
	shots [][]adapter.Event
}

func (a *multiShotAdapter) Start(ctx context.Context, spec adapter.TaskSpec) (adapter.RunHandle, error) {
	a.mu.Lock()
	i := a.n
	a.n++
	a.mu.Unlock()
	evs := successEvents()
	if i < len(a.shots) {
		evs = a.shots[i]
	}
	ch := make(chan adapter.Event, 16)
	go func() {
		defer close(ch)
		for _, ev := range evs {
			ch <- ev
		}
	}()
	return &fakeHandle{ch: ch, cancelCh: make(chan struct{})}, nil
}
