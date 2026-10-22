package node

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/remote/worker"
	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/task"
)

// approvalWire is one control channel with both halves of a cross-device
// approval attached to it: the Hub's Approvals on the end that owns the turn,
// and the Node's ApprovalRelay on the end that runs it.
//
// Neither half can check this by itself. What has to line up is which id each
// direction is keyed by — the machine makes one up for the question, the Hub
// assigns one to the row a person answers, and the outcome comes back under the
// first of them — and the only place that agreement is observable is here.
type approvalWire struct {
	turns     *Turns
	approvals *Approvals
	relay     *ApprovalRelay
	conn      *testConn

	mu       sync.Mutex
	handled  []string
	problems []error
}

// newApprovalWire joins the two halves the way a control channel does: what the
// machine sends is routed by the connection that owns it, and what the Hub sends
// is handed to the machine the way the connection's read loop hands it to the
// executor.
func newApprovalWire(t *testing.T, inbox ApprovalAuthority) *approvalWire {
	t.Helper()
	turns := NewTurns()
	conn := newTestConn("device-1")
	wire := &approvalWire{
		turns:     turns,
		approvals: &Approvals{Turns: turns, Engine: inbox, Poll: time.Millisecond},
		conn:      conn,
	}
	wire.relay = &ApprovalRelay{Executor: &Executor{}}

	done := make(chan struct{})
	t.Cleanup(func() { close(done) })
	go wire.deliver(done)

	wire.relay.SetSender(func(ctx context.Context, frame worker.Frame) error {
		if frame.Kind == "approval.request" {
			return wire.approvals.Route(ctx, conn, frame)
		}
		return turns.RouteFrame(ctx, conn, frame)
	})
	return wire
}

// deliver is the machine's read loop: every frame the Hub puts on the channel is
// handled as it arrives, not when the test gets around to it. A decision landing
// here while the agent is still walking over to wait for it is exactly the
// ordering this makes reproducible.
func (w *approvalWire) deliver(done <-chan struct{}) {
	var seen int
	for {
		frames := w.conn.sent()
		for ; seen < len(frames); seen++ {
			frame := frames[seen]
			err := w.relay.Handle(context.Background(), frame)
			w.mu.Lock()
			if err != nil {
				w.problems = append(w.problems, err)
			} else {
				w.handled = append(w.handled, frame.Kind)
			}
			w.mu.Unlock()
		}
		select {
		case <-done:
			return
		case <-time.After(time.Millisecond):
		}
	}
}

// await waits until the machine has handled a frame of that kind, so a test can
// act on an ordering instead of racing it.
func (w *approvalWire) await(t *testing.T, kind string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		w.mu.Lock()
		for _, handled := range w.handled {
			if handled == kind {
				w.mu.Unlock()
				return
			}
		}
		w.mu.Unlock()
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("the machine never handled a %s frame; frames = %+v", kind, w.conn.sent())
}

// clean fails the test if the machine refused a frame the Hub sent, which would
// mean the two halves disagree about the protocol rather than about an id.
func (w *approvalWire) clean(t *testing.T) {
	t.Helper()
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.problems) != 0 {
		t.Fatalf("the machine refused %v", w.problems)
	}
}

// awaitQuestion waits for the Hub to have recorded a question, and returns it.
func awaitQuestion(t *testing.T, inbox *fakeInbox) []task.CreateApprovalRequest {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if asked := inbox.questions(); len(asked) > 0 {
			return asked
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("the hub never recorded the device's question")
	return nil
}

// TestAQuestionCrossesBothHalvesUnderTheHubsId is the exchange end to end on one
// wire: the machine asks, the Hub answers the request with the id of the row it
// created, the answer comes back under the id the machine made up, and the
// machine releases the question once its agent has read the outcome — while the
// answer itself stays readable under that id.
func TestAQuestionCrossesBothHalvesUnderTheHubsId(t *testing.T) {
	inbox := newFakeInbox()
	wire := newApprovalWire(t, inbox)
	if _, err := wire.turns.Open("turn-1", "task-1", wire.conn, "studio"); err != nil {
		t.Fatal(err)
	}
	// The machine is running that turn for its Hub, which is the only reason a
	// question of its travels at all.
	if err := wire.relay.Executor.track(&execution{turnID: "turn-1"}); err != nil {
		t.Fatal(err)
	}

	type answer struct {
		id  string
		err error
	}
	asked := make(chan answer, 1)
	go func() {
		id, err := wire.relay.Ask(context.Background(), ask("turn-1"))
		asked <- answer{id: id, err: err}
	}()

	questions := awaitQuestion(t, inbox)
	if questions[0].TaskID != "task-1" || questions[0].ExecutionID != "turn-1" {
		t.Fatalf("the hub recorded %+v", questions[0])
	}
	got := <-asked
	// The agent is handed the Hub's row, not the id this machine invented: that
	// id is what the console shows and what the decision is recorded against.
	if got.err != nil || got.id != "apr-1" {
		t.Fatalf("ask returned (%q, %v), want the hub's approval id", got.id, got.err)
	}
	if !wire.relay.Waiting(got.id) {
		t.Fatal("the question the agent is waiting on is not the one this machine forwarded")
	}

	// A person answers in the Hub's console.
	inbox.decision <- store.DecisionApproved

	decision, err := wire.relay.Decision(context.Background(), got.id)
	if err != nil || decision != store.DecisionApproved {
		t.Fatalf("decision = (%q, %v)", decision, err)
	}
	if wire.relay.Pending() != 0 {
		t.Fatalf("the answered question is still open: pending=%d", wire.relay.Pending())
	}
	// Answered once, answered always: the agent's client long-polls, and a second
	// wait for a question this machine already has the answer to gets that answer
	// rather than "not a question this machine asked".
	again, err := wire.relay.Decision(context.Background(), got.id)
	if again != decision || err != nil {
		t.Fatalf("the second wait heard (%q, %v), want the same answer", again, err)
	}
	wire.clean(t)
}

// TestADecisionThatArrivesBeforeTheWaitIsNotLost is the ordering the two halves
// cannot coordinate: the answer comes down the socket while the agent's own wait
// is still one HTTP round trip behind. It has to be waiting when that call
// arrives, rather than having been thrown away as a question nobody asked.
func TestADecisionThatArrivesBeforeTheWaitIsNotLost(t *testing.T) {
	inbox := newFakeInbox()
	wire := newApprovalWire(t, inbox)
	if _, err := wire.turns.Open("turn-1", "task-1", wire.conn, "studio"); err != nil {
		t.Fatal(err)
	}
	if err := wire.relay.Executor.track(&execution{turnID: "turn-1"}); err != nil {
		t.Fatal(err)
	}

	asked := make(chan string, 1)
	go func() {
		id, err := wire.relay.Ask(context.Background(), ask("turn-1"))
		if err != nil {
			asked <- ""
			return
		}
		asked <- id
	}()
	awaitQuestion(t, inbox)
	id := <-asked
	if id == "" {
		t.Fatal("the question never reached the hub")
	}

	// Decided and delivered before the agent asks for the outcome.
	inbox.decision <- store.DecisionDenied
	wire.await(t, "approval.decision")

	decision, err := wire.relay.Decision(context.Background(), id)
	if err != nil || decision != store.DecisionDenied {
		t.Fatalf("decision = (%q, %v), want the answer that already arrived", decision, err)
	}
	wire.clean(t)
}
