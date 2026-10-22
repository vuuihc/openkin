package node

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/remote/worker"
	"github.com/vuuihc/openkin/internal/task"
)

// hubLink is the Hub's end of a control channel in a test: it records what the
// machine sent, and hands frames back the way the connection's read loop would.
type hubLink struct {
	mu     sync.Mutex
	frames []worker.Frame
}

func (l *hubLink) send(_ context.Context, frame worker.Frame) error {
	l.mu.Lock()
	l.frames = append(l.frames, frame)
	l.mu.Unlock()
	return nil
}

// next waits for the next frame of that kind.
func (l *hubLink) next(t *testing.T, kind string) worker.Frame {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		l.mu.Lock()
		for _, frame := range l.frames {
			if frame.Kind == kind {
				l.mu.Unlock()
				return frame
			}
		}
		l.mu.Unlock()
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("the machine never sent a %s frame", kind)
	return worker.Frame{}
}

// ask builds the request an agent's permission call turns into.
func ask(executionID string) task.CreateApprovalRequest {
	return task.CreateApprovalRequest{
		TaskID:         "task-1",
		Kind:           "tool_use",
		Payload:        []byte(`{"tool":"Bash"}`),
		ExecutionID:    executionID,
		ExecutionAgent: "claude-code",
	}
}

// TestAQuestionTravelsAndTheAnswerComesBack is the Node's half of the exchange:
// the question goes up with the turn it belongs to, the Hub's id comes back
// first, and the decision arrives later on the same channel.
func TestAQuestionTravelsAndTheAnswerComesBack(t *testing.T) {
	link := &hubLink{}
	relay := &ApprovalRelay{}
	relay.SetSender(link.send)

	type result struct {
		id  string
		err error
	}
	asked := make(chan result, 1)
	go func() {
		id, err := relay.Ask(context.Background(), ask("turn-1"))
		asked <- result{id: id, err: err}
	}()

	request, err := Decode[worker.ApprovalRequest](link.next(t, "approval.request"))
	if err != nil {
		t.Fatal(err)
	}
	if request.TurnID != "turn-1" || request.Agent != "claude-code" || request.RequestID == "" {
		t.Fatalf("request = %+v", request)
	}

	// The hub takes it: the agent learns the row's id before anybody decides.
	status, err := worker.NewFrame("approval.status", worker.ApprovalStatus{
		RequestID: request.RequestID, ApprovalID: "apr-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := relay.Handle(context.Background(), status); err != nil {
		t.Fatal(err)
	}
	got := <-asked
	if got.err != nil || got.id != "apr-1" {
		t.Fatalf("ask returned (%q, %v), want the hub's approval id", got.id, got.err)
	}

	// The wait comes in by the hub's id, not the one this machine made up.
	waited := make(chan result, 1)
	go func() {
		decision, err := relay.Decision(context.Background(), "apr-1")
		waited <- result{id: decision, err: err}
	}()
	decisionFrame, err := worker.NewFrame("approval.decision", worker.ApprovalDecision{
		RequestID: request.RequestID, Decision: worker.ApprovalDenied,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := relay.Handle(context.Background(), decisionFrame); err != nil {
		t.Fatal(err)
	}
	if got := <-waited; got.err != nil || got.id != worker.ApprovalDenied {
		t.Fatalf("decision = (%q, %v)", got.id, got.err)
	}
	if relay.Pending() != 0 {
		t.Fatalf("%d questions are still open after one was answered", relay.Pending())
	}
}

// TestARefusedQuestionFailsTheAgentCall makes a Hub that will not ask anybody
// look like a failure to the agent, not like a wait. The agent's tool call is
// what has to end.
func TestARefusedQuestionFailsTheAgentCall(t *testing.T) {
	link := &hubLink{}
	relay := &ApprovalRelay{}
	relay.SetSender(link.send)

	asked := make(chan error, 1)
	go func() {
		_, err := relay.Ask(context.Background(), ask("turn-1"))
		asked <- err
	}()
	request, err := Decode[worker.ApprovalRequest](link.next(t, "approval.request"))
	if err != nil {
		t.Fatal(err)
	}
	status, err := worker.NewFrame("approval.status", worker.ApprovalStatus{
		RequestID: request.RequestID, Error: "this hub is not running that turn",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := relay.Handle(context.Background(), status); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-asked:
		if err == nil || !strings.Contains(err.Error(), "not running that turn") {
			t.Fatalf("err = %v, want the hub's reason", err)
		}
	case <-time.After(time.Second):
		t.Fatal("a refused question left the agent waiting")
	}
	if relay.Pending() != 0 {
		t.Fatal("a refused question was left open")
	}
}

// TestAQuestionDiesWithTheConnection is the convergence rule for approvals on
// this side: the answer can no longer arrive, so the agent has to hear that
// rather than wait for a decision that has nowhere to land.
func TestAQuestionDiesWithTheConnection(t *testing.T) {
	for _, tc := range []struct {
		name string
		// at is where the connection ends: before the hub took the question, or
		// after it did and while the agent was waiting for the answer.
		at string
	}{
		{name: "before the hub answered", at: "asking"},
		{name: "while waiting for the decision", at: "waiting"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			link := &hubLink{}
			relay := &ApprovalRelay{}
			relay.SetSender(link.send)

			failed := make(chan error, 1)
			go func() {
				id, err := relay.Ask(context.Background(), ask("turn-1"))
				if err != nil {
					failed <- err
					return
				}
				_, err = relay.Decision(context.Background(), id)
				failed <- err
			}()
			request, err := Decode[worker.ApprovalRequest](link.next(t, "approval.request"))
			if err != nil {
				t.Fatal(err)
			}
			if tc.at == "waiting" {
				status, err := worker.NewFrame("approval.status", worker.ApprovalStatus{
					RequestID: request.RequestID, ApprovalID: "apr-1",
				})
				if err != nil {
					t.Fatal(err)
				}
				if err := relay.Handle(context.Background(), status); err != nil {
					t.Fatal(err)
				}
				// Give the first half of the goroutine time to reach the wait, so
				// this case tests the wait and not the ask.
				deadline := time.Now().Add(time.Second)
				for relay.Pending() != 1 && time.Now().Before(deadline) {
					time.Sleep(time.Millisecond)
				}
			}

			relay.SetSender(nil)

			select {
			case err := <-failed:
				if err == nil {
					t.Fatal("the question survived the connection")
				}
			case <-time.After(2 * time.Second):
				t.Fatal("the agent was left waiting on a connection that is gone")
			}
			if relay.Pending() != 0 {
				t.Fatalf("%d questions outlived the connection", relay.Pending())
			}
		})
	}
}

// TestOwnsSeparatesDispatchedWorkFromThisMachinesOwn — only a turn this machine
// took from its Hub has an inbox somewhere else.
func TestOwnsSeparatesDispatchedWorkFromThisMachinesOwn(t *testing.T) {
	executor := &Executor{}
	relay := &ApprovalRelay{Executor: executor}
	if relay.Owns("turn-local") {
		t.Fatal("a turn this machine is not running was claimed as the hub's")
	}
	if err := executor.track(&execution{turnID: "turn-dispatched"}); err != nil {
		t.Fatal(err)
	}
	if !relay.Owns("turn-dispatched") {
		t.Fatal("a dispatched turn was not recognized")
	}
	if relay.Owns("") {
		t.Fatal("an empty execution was claimed")
	}
	// A daemon that is nobody's Node has no relay at all, and that is the
	// executor being absent rather than a special case here.
	(&ApprovalRelay{}).SetSender(nil)
}

// TestAFrameAboutAQuestionNobodyAskedIsRefused keeps a hub that has lost track
// from looking like it answered something.
func TestAFrameAboutAQuestionNobodyAskedIsRefused(t *testing.T) {
	relay := &ApprovalRelay{}
	status, err := worker.NewFrame("approval.status", worker.ApprovalStatus{
		RequestID: "req-ghost", ApprovalID: "apr-ghost",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := relay.Handle(context.Background(), status); err == nil {
		t.Fatal("a status for an unknown request was accepted")
	}
	decision, err := worker.NewFrame("approval.decision", worker.ApprovalDecision{
		RequestID: "req-ghost", Decision: worker.ApprovalExpired,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := relay.Handle(context.Background(), decision); err == nil {
		t.Fatal("a decision for an unknown request was accepted")
	}
}
