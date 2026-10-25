package task

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/store"
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

// TestAnExpiryDoesNotOverwriteADecisionThatLandedFirst is the race a long poll
// meets: the TTL fires in the same instant a person answers. The expiry loses,
// and — the part that matters to the machine waiting on it — the answer comes
// back instead of a conflict, which reads as a failed wait and a denied tool
// call for a question somebody approved.
func TestAnExpiryDoesNotOverwriteADecisionThatLandedFirst(t *testing.T) {
	ctx := context.Background()
	e, _ := testEngine(t, 4, &fakeAdapter{runFor: 10 * time.Second})

	task, err := e.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: "/tmp", Prompt: "ask first"})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusRunning, 2*time.Second)

	a, err := e.RequestApproval(ctx, CreateApprovalRequest{TaskID: task.ID, Kind: "tool_use"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.Decide(ctx, a.ID, store.DecisionApproved, "web"); err != nil {
		t.Fatal(err)
	}

	// What the TTL path does when it arrives second.
	got, err := e.expireApproval(ctx, a.ID)
	if err != nil {
		t.Fatalf("expiring a question that was already answered: %v", err)
	}
	if got.Decision != store.DecisionApproved {
		t.Fatalf("decision = %q, want the answer a person gave", got.Decision)
	}
	if got.DecidedVia == nil || *got.DecidedVia != "web" {
		t.Fatalf("via = %v, want the person's decision left as it was", got.DecidedVia)
	}
}

func TestFollowUpRequiresTerminalSession(t *testing.T) {
	ctx := context.Background()

	// Running: interrupt then re-queue with the new guide prompt. Cutting a live
	// turn short is opt-in (interrupt: true) since a prompt sent to a busy task
	// waits in its queue by default.
	hang := &hangThenOKAdapter{}
	e2, st := testEngine(t, 4, hang)
	running, err := e2.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: "/tmp", Prompt: "x"})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e2, running.ID, StatusRunning, 2*time.Second)
	_, err = e2.FollowUpWith(ctx, running.ID, FollowUpRequest{Prompt: "more guidance", Interrupt: true})
	if err != nil {
		t.Fatalf("running follow-up (interrupt) should be allowed, got %v", err)
	}
	// Eventually the interrupted turn yields a new run that finishes.
	done := waitStatus(t, e2, running.ID, StatusSucceeded, 3*time.Second)
	if done.Status != StatusSucceeded {
		t.Fatalf("status=%s", done.Status)
	}
	evs, _ := e2.Events(ctx, running.ID, 0)
	var sawInterrupt bool
	for _, ev := range evs {
		if ev.Type != "message" {
			continue
		}
		var m map[string]any
		_ = json.Unmarshal(ev.Payload, &m)
		if m["source"] == "interrupt" {
			sawInterrupt = true
			break
		}
	}
	if !sawInterrupt {
		t.Fatal("expected interrupt user message event")
	}

	// No session_ref: still allowed (context injection / handoff path).
	now := store.NowMilli()
	id := "01NOSESS000000000000000001"
	if err := st.InsertTask(ctx, store.Task{
		ID: id, Title: "t", Agent: "claude-code", Cwd: "/tmp", Prompt: "p",
		Status: StatusSucceeded, CreatedAt: now, FinishedAt: &now,
	}); err != nil {
		t.Fatal(err)
	}
	tNoSess, err := e2.FollowUp(ctx, id, "more")
	if err != nil {
		t.Fatalf("no-session follow-up should be allowed, got %v", err)
	}
	if tNoSess.Status != StatusQueued && tNoSess.Status != StatusRunning && tNoSess.Status != StatusSucceeded {
		t.Fatalf("unexpected status %s", tNoSess.Status)
	}
}

func TestFollowUpInterruptRequeues(t *testing.T) {
	ctx := context.Background()
	// First shot hangs; after cancel, second Start should succeed quickly.
	hangThenOK := &hangThenOKAdapter{}
	e, _ := testEngine(t, 4, hangThenOK)

	t1, err := e.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: "/tmp", Prompt: "first"})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, t1.ID, StatusRunning, 2*time.Second)

	_, err = e.FollowUpWith(ctx, t1.ID, FollowUpRequest{Prompt: "stop and do Y instead", Interrupt: true})
	if err != nil {
		t.Fatal(err)
	}
	done := waitStatus(t, e, t1.ID, StatusSucceeded, 3*time.Second)
	if done.Prompt == "" {
		t.Fatal("expected prompt after interrupt")
	}
	if hangThenOK.starts < 2 {
		t.Fatalf("expected second start after interrupt, starts=%d", hangThenOK.starts)
	}
	// Steer cancel must not persist a red "canceled" error bubble.
	evs, err := e.Events(ctx, t1.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, ev := range evs {
		if ev.Type != "error" {
			continue
		}
		var m map[string]any
		_ = json.Unmarshal(ev.Payload, &m)
		msg, _ := m["message"].(string)
		if errorPayloadIsCancel(ev.Payload) || strings.EqualFold(msg, "canceled") {
			t.Fatalf("steer interrupt must not persist cancel error event: %s", string(ev.Payload))
		}
	}
}

// hangThenOKAdapter first Start hangs until canceled; subsequent Starts succeed.
type hangThenOKAdapter struct {
	mu     sync.Mutex
	starts int
}

func (a *hangThenOKAdapter) Start(ctx context.Context, spec adapter.TaskSpec) (adapter.RunHandle, error) {
	a.mu.Lock()
	a.starts++
	n := a.starts
	a.mu.Unlock()
	ch := make(chan adapter.Event, 8)
	h := &fakeHandle{ch: ch, cancelCh: make(chan struct{})}
	go func() {
		defer close(ch)
		ch <- adapter.Event{Type: "task_started", Payload: json.RawMessage(`{"session_id":"s1","subtype":"init"}`)}
		if n == 1 {
			select {
			case <-h.cancelCh:
				// Mirror kinagent: abort emits a cancel error before result.
				ch <- adapter.Event{Type: "error", Payload: json.RawMessage(`{"message":"canceled"}`)}
				ch <- adapter.Event{Type: "result", Payload: json.RawMessage(`{"is_error":true}`)}
				return
			case <-time.After(5 * time.Second):
				return
			}
		}
		ch <- adapter.Event{Type: "message", Payload: json.RawMessage(`{"role":"assistant","content":[{"type":"text","text":"ok"}],"partial":false}`)}
		ch <- adapter.Event{Type: "result", Payload: json.RawMessage(`{"cost_usd":0.01,"total_cost_usd":0.01,"tokens_in":10,"tokens_out":5,"is_error":false}`)}
	}()
	return h, nil
}

func TestHandoffSwitchesAgent(t *testing.T) {
	ctx := context.Background()
	adA := &fakeAdapter{events: successEvents()}
	adB := &fakeAdapter{events: successEvents()}
	// Seed with claude only via helper, then swap adapters map... better construct engine with both.
	e, _ := testEngine(t, 4, adA)
	e.putAdapter("codex", adB)

	t1, err := e.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: "/tmp", Prompt: "first"})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, t1.ID, StatusSucceeded, 2*time.Second)

	t2, err := e.FollowUpWith(ctx, t1.ID, FollowUpRequest{Prompt: "continue", Agent: "codex"})
	if err != nil {
		t.Fatal(err)
	}
	if t2.Agent != "codex" {
		t.Fatalf("agent=%s want codex", t2.Agent)
	}
	if t2.SessionRef != nil && *t2.SessionRef != "" {
		t.Fatalf("session_ref should clear on handoff, got %v", t2.SessionRef)
	}
	_ = waitStatus(t, e, t1.ID, StatusSucceeded, 2*time.Second)
}

func TestCreatePicksDefaultAgent(t *testing.T) {
	ctx := context.Background()
	ad := &fakeAdapter{events: successEvents()}
	e, _ := testEngine(t, 4, ad)
	t1, err := e.Create(ctx, CreateRequest{Cwd: "/tmp", Prompt: "no agent field"})
	if err != nil {
		t.Fatal(err)
	}
	if t1.Agent != "claude-code" {
		t.Fatalf("agent=%s want claude-code", t1.Agent)
	}
	_ = waitStatus(t, e, t1.ID, StatusSucceeded, 2*time.Second)
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

func TestFollowUpPlainDoesNotReorchestrate(t *testing.T) {
	ctx := context.Background()
	// First turn: multi-@ plan host on kin with workers.
	kinAd := &fakeAdapter{events: successEvents()}
	claudeAd := &fakeAdapter{events: successEvents()}
	e, _ := testEngine(t, 4, kinAd)
	e.putAdapter("kin", kinAd)
	e.putAdapter("claude-code", claudeAd)
	// Prefer kin as main.
	e.SetDefaultAgentFn(func() string { return "kin" })

	t1, err := e.Create(ctx, CreateRequest{
		Agent:  "kin",
		Cwd:    "/tmp",
		Prompt: "调研 X，@claude 你去做实验",
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, t1.ID, StatusSucceeded, 3*time.Second)

	// Second turn: no @ — must stay single-agent kin, not re-parse prior @claude from context.
	t2, err := e.FollowUp(ctx, t1.ID, "根据刚才结果直接改代码，不要再委派")
	if err != nil {
		t.Fatal(err)
	}
	// Prompt may be wrapped with handoff context, but shouldOrchestrate must be false.
	if plan, ok := e.shouldOrchestrate(t2); ok {
		t.Fatalf("plain follow-up should not orchestrate, plan=%+v prompt=%q", plan, t2.Prompt)
	}
	// And the stored run prompt's user turn has no worker steps.
	if p := ParseDelegatePlan(UserTurnPrompt(t2.Prompt), AvailableSet(e.AgentIDs())); p.HasSubAgents() {
		t.Fatalf("user turn still has sub-agents: %+v", p.Steps)
	}
}

func TestFollowUpWithMentionStillOrchestrates(t *testing.T) {
	ctx := context.Background()
	kinAd := &fakeAdapter{events: successEvents()}
	claudeAd := &fakeAdapter{events: successEvents()}
	e, _ := testEngine(t, 4, kinAd)
	e.putAdapter("kin", kinAd)
	e.putAdapter("claude-code", claudeAd)
	e.SetDefaultAgentFn(func() string { return "kin" })

	t1, err := e.Create(ctx, CreateRequest{Agent: "kin", Cwd: "/tmp", Prompt: "hello"})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, t1.ID, StatusSucceeded, 2*time.Second)

	t2, err := e.FollowUp(ctx, t1.ID, "@claude 修一下测试")
	if err != nil {
		t.Fatal(err)
	}
	if plan, ok := e.shouldOrchestrate(t2); !ok || !plan.HasSubAgents() {
		t.Fatalf("expected orchestrate on explicit @, ok=%v plan=%+v prompt=%q", ok, plan, t2.Prompt)
	}
}

func TestFollowUpOrchestrateGetsPriorContext(t *testing.T) {
	ctx := context.Background()
	// Capture the brief the worker receives.
	var mu sync.Mutex
	var brief string
	kinAd := &fakeAdapter{events: successEvents()}
	claudeAd := &capturingAdapter{
		onStart: func(spec adapter.TaskSpec) {
			mu.Lock()
			brief = spec.Prompt
			mu.Unlock()
		},
		events: successEvents(),
	}
	e, _ := testEngine(t, 4, kinAd)
	e.putAdapter("kin", kinAd)
	e.putAdapter("claude-code", claudeAd)
	e.SetDefaultAgentFn(func() string { return "kin" })

	t1, err := e.Create(ctx, CreateRequest{Agent: "kin", Cwd: "/tmp", Prompt: "先让 codex 做，但它不支持这个模型"})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, t1.ID, StatusSucceeded, 2*time.Second)

	_, err = e.FollowUp(ctx, t1.ID, "@claude 来干吧")
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, t1.ID, StatusSucceeded, 3*time.Second)

	mu.Lock()
	got := brief
	mu.Unlock()
	if got == "" {
		t.Fatal("worker never started")
	}
	if !strings.Contains(got, "Conversation so far:") && !strings.Contains(got, "prior context") && !strings.Contains(got, "不支持") {
		// Accept either session context section or the original user text in overview/assignment.
		t.Fatalf("worker brief missing prior conversation: %q", got)
	}
	if !strings.Contains(got, "来干吧") && !strings.Contains(got, "Complete the assigned") {
		// assignment should reference the live turn
		t.Fatalf("worker brief missing current assignment: %q", got)
	}
}

// capturingAdapter records the TaskSpec on Start.
type capturingAdapter struct {
	onStart func(adapter.TaskSpec)
	events  []adapter.Event
}

func (a *capturingAdapter) Start(ctx context.Context, spec adapter.TaskSpec) (adapter.RunHandle, error) {
	if a.onStart != nil {
		a.onStart(spec)
	}
	ch := make(chan adapter.Event, 16)
	go func() {
		defer close(ch)
		for _, ev := range a.events {
			ch <- ev
		}
	}()
	return &fakeHandle{ch: ch, cancelCh: make(chan struct{})}, nil
}

// gateAdapter's first Start hangs until the test opens the gate, then ends the
// turn on its own. That is what lets a test end a turn at a chosen instant
// rather than waiting for a cancel.
type gateAdapter struct {
	mu      sync.Mutex
	starts  int
	release chan struct{}
}

func (a *gateAdapter) Start(_ context.Context, _ adapter.TaskSpec) (adapter.RunHandle, error) {
	a.mu.Lock()
	a.starts++
	n := a.starts
	a.mu.Unlock()
	ch := make(chan adapter.Event, 8)
	h := &fakeHandle{ch: ch, cancelCh: make(chan struct{})}
	go func() {
		defer close(ch)
		ch <- adapter.Event{Type: "task_started", Payload: json.RawMessage(`{"session_id":"s1","subtype":"init"}`)}
		if n == 1 {
			<-a.release
		}
		ch <- adapter.Event{Type: "message", Payload: json.RawMessage(`{"role":"assistant","content":[{"type":"text","text":"ok"}],"partial":false}`)}
		ch <- adapter.Event{Type: "result", Payload: json.RawMessage(`{"cost_usd":0.01,"total_cost_usd":0.01,"tokens_in":10,"tokens_out":5,"is_error":false}`)}
	}()
	return h, nil
}

// heldGuideWriter holds the first user-guide write open, so the turn can end
// while that write is still in flight -- the window in which the interrupt's two
// halves used to be observable apart. Later writes pass straight through, which
// is what makes the difference visible: a delivery that believes nobody wrote
// the message yet writes a second copy.
type heldGuideWriter struct {
	inner   eventWriter
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (w *heldGuideWriter) AppendEvent(ctx context.Context, taskID, typ string, payload json.RawMessage) (store.Event, error) {
	if typ == "message" && bytes.Contains(payload, []byte(`"source":"interrupt"`)) {
		w.once.Do(func() {
			close(w.entered)
			<-w.release
		})
	}
	return w.inner.AppendEvent(ctx, taskID, typ, payload)
}

func (w *heldGuideWriter) AppendUsageEvent(ctx context.Context, taskID, typ string, payload json.RawMessage, record store.UsageRecord) (store.Event, store.Task, error) {
	return w.inner.AppendUsageEvent(ctx, taskID, typ, payload, record)
}

// A turn can end on its own while the interrupt is still writing the user's
// message. The delivery then has to know the write happened, or it writes the
// message again: two copies of one prompt in the transcript, and a checkpoint
// anchored on whichever copy the delivery wrote rather than the one the user was
// looking at.
func TestInterruptDeliversOneCopyOfTheGuideWhenTheTurnEndsUnderIt(t *testing.T) {
	ctx := context.Background()
	gate := &gateAdapter{release: make(chan struct{})}
	e, _ := testEngine(t, 4, gate)
	writer := &heldGuideWriter{
		inner:   e.eventWriter(),
		entered: make(chan struct{}),
		release: make(chan struct{}),
	}
	e.setEventWriter(writer)

	t1, err := e.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: "/tmp", Prompt: "first"})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, t1.ID, StatusRunning, 2*time.Second)

	interrupted := make(chan error, 1)
	go func() {
		_, err := e.FollowUpWith(ctx, t1.ID, FollowUpRequest{Prompt: "stop and do Y", Interrupt: true})
		interrupted <- err
	}()

	<-writer.entered
	// Both halves of an interrupt -- writing the user's message, and publishing
	// the entry that carries its seq -- belong to one critical section, and a
	// delivery reads that entry under the same lock. Getting in here while the
	// write is open means a delivery can get in too, and the zero it would find
	// means "nobody wrote it yet": the message gets written a second time beside
	// the first. Finding no entry at all is no better -- the turn could end right
	// here, and the guide would never be delivered.
	if e.mu.TryLock() {
		pf, held := e.pendingFollowUp[t1.ID]
		e.mu.Unlock()
		if held {
			t.Fatalf("pending follow-up readable mid-write, userSeq=%d", pf.userSeq)
		}
		t.Fatal("no pending follow-up readable mid-write: a turn ending here drops the guide")
	}
	close(gate.release)   // the turn ends while the guide write is open
	close(writer.release) // and the write finishes
	if err := <-interrupted; err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, t1.ID, StatusSucceeded, 3*time.Second)

	evs, err := e.Events(ctx, t1.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	copies := 0
	for _, ev := range evs {
		if ev.Type != "message" {
			continue
		}
		var m map[string]any
		_ = json.Unmarshal(ev.Payload, &m)
		if m["source"] == "interrupt" {
			copies++
		}
	}
	if copies != 1 {
		t.Fatalf("user copies of the interrupt message = %d, want 1", copies)
	}
}
