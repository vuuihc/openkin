package node

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/vuuihc/openkin/internal/remote/worker"
	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/task"
)

// fakeInbox is the engine's approval inbox, with the things a cross-device
// approval uses it for: taking a question, waiting for an answer, reading one
// back, and settling one nobody answered.
type fakeInbox struct {
	mu       sync.Mutex
	asked    []task.CreateApprovalRequest
	rows     map[string]store.Approval
	refuse   error
	waitErr  error
	decision chan string
}

func newFakeInbox() *fakeInbox {
	return &fakeInbox{rows: make(map[string]store.Approval), decision: make(chan string, 8)}
}

func (f *fakeInbox) RequestApproval(_ context.Context, req task.CreateApprovalRequest) (store.Approval, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.refuse != nil {
		return store.Approval{}, f.refuse
	}
	f.asked = append(f.asked, req)
	id := "apr-" + itoa(len(f.asked))
	row := store.Approval{ID: id, TaskID: req.TaskID, Kind: req.Kind, Decision: store.DecisionPending}
	f.rows[id] = row
	return row, nil
}

func (f *fakeInbox) WaitApproval(ctx context.Context, id string, _ time.Duration) (store.Approval, error) {
	f.mu.Lock()
	row, ok := f.rows[id]
	waitErr := f.waitErr
	f.mu.Unlock()
	if waitErr != nil {
		return store.Approval{}, waitErr
	}
	if !ok {
		return store.Approval{}, store.ErrNotFound
	}
	if row.Decision != store.DecisionPending {
		return row, nil
	}
	select {
	case decision := <-f.decision:
		f.mu.Lock()
		row = f.rows[id]
		row.Decision = decision
		f.rows[id] = row
		f.mu.Unlock()
		return row, nil
	case <-ctx.Done():
		return store.Approval{}, ctx.Err()
	}
}

// GetApproval reads a row back, the way the engine does after a wait that failed.
func (f *fakeInbox) GetApproval(_ context.Context, id string) (store.Approval, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	row, ok := f.rows[id]
	if !ok {
		return store.Approval{}, store.ErrNotFound
	}
	return row, nil
}

func (f *fakeInbox) Decide(_ context.Context, id, decision, via string) (store.Approval, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	row, ok := f.rows[id]
	if !ok {
		return store.Approval{}, store.ErrNotFound
	}
	if row.Decision != store.DecisionPending {
		return store.Approval{}, task.ErrAlreadyDecided
	}
	row.Decision = decision
	viaCopy := via
	row.DecidedVia = &viaCopy
	f.rows[id] = row
	return row, nil
}

// decided reports the recorded outcome, for assertions.
func (f *fakeInbox) decided(id string) (string, string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	row := f.rows[id]
	if row.DecidedVia == nil {
		return row.Decision, ""
	}
	return row.Decision, *row.DecidedVia
}

// setWaitErr makes the next waits fail, the way a store that is unavailable
// does.
func (f *fakeInbox) setWaitErr(err error) {
	f.mu.Lock()
	f.waitErr = err
	f.mu.Unlock()
}

// drop removes a row, the way a question that is over stops existing.
func (f *fakeInbox) drop(id string) {
	f.mu.Lock()
	delete(f.rows, id)
	f.mu.Unlock()
}

func (f *fakeInbox) questions() []task.CreateApprovalRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]task.CreateApprovalRequest(nil), f.asked...)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var digits []byte
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	return string(digits)
}

// approvalRequestFrame is one device asking for permission inside a turn.
func approvalRequestFrame(t *testing.T, requestID, turnID string) worker.Frame {
	t.Helper()
	frame, err := worker.NewFrame("approval.request", worker.ApprovalRequest{
		RequestID: requestID,
		TurnID:    turnID,
		Kind:      "tool_use",
		Payload:   []byte(`{"tool":"Bash","input":{"command":"ls"}}`),
		Agent:     "claude-code",
	})
	if err != nil {
		t.Fatal(err)
	}
	return frame
}

// framesOfKind picks the frames of one kind out of what a connection was sent.
func framesOfKind(frames []worker.Frame, kind string) []worker.Frame {
	var out []worker.Frame
	for _, frame := range frames {
		if frame.Kind == kind {
			out = append(out, frame)
		}
	}
	return out
}

// waitForKind waits for a frame of that kind to appear on the connection.
func waitForKind(t *testing.T, conn *testConn, kind string) worker.Frame {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if frames := framesOfKind(conn.sent(), kind); len(frames) > 0 {
			return frames[len(frames)-1]
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("no %s frame arrived; frames = %+v", kind, conn.sent())
	return worker.Frame{}
}

// openTurn registers a turn the way a dispatch does, and returns the connection
// it is bound to.
func openTurn(t *testing.T, turns *Turns, turnID, taskID, deviceID string) *testConn {
	t.Helper()
	conn := newTestConn(deviceID)
	if _, err := turns.Open(turnID, taskID, conn, "studio"); err != nil {
		t.Fatal(err)
	}
	return conn
}

// TestAQuestionFromADeviceBecomesAnApprovalOnItsTurnsTask is the whole point of
// the mechanism: an agent blocked on another machine shows up in the Hub's
// inbox, against the task that machine is running, and the answer goes back down
// the socket the question came up.
func TestAQuestionFromADeviceBecomesAnApprovalOnItsTurnsTask(t *testing.T) {
	turns := NewTurns()
	inbox := newFakeInbox()
	approvals := &Approvals{Turns: turns, Engine: inbox, Poll: time.Millisecond}
	conn := openTurn(t, turns, "turn-1", "task-1", "device-1")

	if err := approvals.Route(context.Background(), conn, approvalRequestFrame(t, "req-1", "turn-1")); err != nil {
		t.Fatal(err)
	}

	asked := inbox.questions()
	if len(asked) != 1 {
		t.Fatalf("the hub asked %d questions, want 1", len(asked))
	}
	if asked[0].TaskID != "task-1" {
		t.Fatalf("the approval is for task %q, want the turn's task task-1", asked[0].TaskID)
	}
	if asked[0].ExecutionID != "turn-1" || asked[0].ExecutionAgent != "claude-code" {
		t.Fatalf("attribution = %+v", asked[0])
	}

	statusFrame := waitForKind(t, conn, "approval.status")
	status, err := Decode[worker.ApprovalStatus](statusFrame)
	if err != nil {
		t.Fatal(err)
	}
	if status.ApprovalID != "apr-1" || status.Error != "" {
		t.Fatalf("status = %+v", status)
	}

	// The person answers.
	inbox.decision <- store.DecisionApproved

	decisionFrame := waitForKind(t, conn, "approval.decision")
	decision, err := Decode[worker.ApprovalDecision](decisionFrame)
	if err != nil {
		t.Fatal(err)
	}
	if decision.RequestID != "req-1" || decision.Decision != worker.ApprovalApproved {
		t.Fatalf("decision = %+v", decision)
	}
}

// TestADeviceCannotAskAboutWorkItWasNotGiven is the trust boundary: the question
// names a turn, and the turn is the only thing that says which task the question
// is about. A device asking about somebody else's work gets nothing, and no row
// is created for it.
func TestADeviceCannotAskAboutWorkItWasNotGiven(t *testing.T) {
	turns := NewTurns()
	inbox := newFakeInbox()
	approvals := &Approvals{Turns: turns, Engine: inbox, Poll: time.Millisecond}
	mine := openTurn(t, turns, "turn-1", "task-1", "device-1")
	theirs := openTurn(t, turns, "turn-2", "task-2", "device-2")

	for _, tc := range []struct {
		name    string
		conn    *testConn
		turnID  string
		wantErr string
	}{
		{name: "another device's turn", conn: mine, turnID: "turn-2", wantErr: "belongs to another connection"},
		{name: "a turn nobody is running", conn: mine, turnID: "turn-ghost", wantErr: "unknown turn"},
		{name: "the other device asking about my turn", conn: theirs, turnID: "turn-1", wantErr: "belongs to another connection"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := approvals.Route(context.Background(), tc.conn, approvalRequestFrame(t, "req-x", tc.turnID)); err == nil {
				t.Fatal("the request was accepted")
			} else if !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("err = %v, want it to mention %q", err, tc.wantErr)
			}
			if got := len(inbox.questions()); got != 0 {
				t.Fatalf("the hub asked %d questions about work it did not hand out", got)
			}
		})
	}
}

// TestAQuestionTheHubWillNotAskIsAnsweredWithAReason keeps a refusal from
// looking like a hang: the agent is blocked, and "no" is an answer.
func TestAQuestionTheHubWillNotAskIsAnsweredWithAReason(t *testing.T) {
	turns := NewTurns()
	inbox := newFakeInbox()
	inbox.refuse = errors.New("task status failed cannot request approval")
	approvals := &Approvals{Turns: turns, Engine: inbox, Poll: time.Millisecond}
	conn := openTurn(t, turns, "turn-1", "task-1", "device-1")

	if err := approvals.Route(context.Background(), conn, approvalRequestFrame(t, "req-1", "turn-1")); err != nil {
		t.Fatal(err)
	}
	status, err := Decode[worker.ApprovalStatus](waitForKind(t, conn, "approval.status"))
	if err != nil {
		t.Fatal(err)
	}
	if status.Error == "" || status.ApprovalID != "" {
		t.Fatalf("status = %+v, want a refusal", status)
	}
	if !strings.Contains(status.Error, "cannot request approval") {
		t.Fatalf("the refusal lost its reason: %q", status.Error)
	}
	if frames := framesOfKind(conn.sent(), "approval.decision"); len(frames) != 0 {
		t.Fatalf("a refused question was also decided: %+v", frames)
	}
	if pending := approvals.Pending(); len(pending) != 0 {
		t.Fatalf("a refused question was left pending: %v", pending)
	}
}

// TestAQuestionDiesWithTheConnectionThatAsked keeps a disconnect from leaving a
// row in the console that a person can answer with nothing on the other end.
func TestAQuestionDiesWithTheConnectionThatAsked(t *testing.T) {
	turns := NewTurns()
	inbox := newFakeInbox()
	approvals := &Approvals{Turns: turns, Engine: inbox, Poll: time.Millisecond}
	conn := openTurn(t, turns, "turn-1", "task-1", "device-1")

	if err := approvals.Route(context.Background(), conn, approvalRequestFrame(t, "req-1", "turn-1")); err != nil {
		t.Fatal(err)
	}
	waitForKind(t, conn, "approval.status")

	settled := approvals.Abandon(conn)
	if len(settled) != 1 || settled[0] != "apr-1" {
		t.Fatalf("settled = %v, want the pending approval", settled)
	}
	decision, via := inbox.decided("apr-1")
	if decision != store.DecisionExpired || via != "device_disconnected" {
		t.Fatalf("recorded %q via %q, want an expiry the disconnect caused", decision, via)
	}
	if pending := approvals.Pending(); len(pending) != 0 {
		t.Fatalf("the approval is still pending: %v", pending)
	}
	// The question is over on this side, so a decision arriving for it now is
	// nobody's business: the waiter was stopped, not left polling a row that is
	// already decided.
	inbox.decision <- store.DecisionApproved
	time.Sleep(20 * time.Millisecond)
	if frames := framesOfKind(conn.sent(), "approval.decision"); len(frames) != 0 {
		t.Fatalf("a dead question was answered anyway: %+v", frames)
	}
}

// TestADuplicateRequestIdDoesNotOpenASecondRow keeps one device from turning one
// question into two rows by repeating its id — and keeps the repeat from looking
// like a hang: the second request is refused with a reason, on the same id.
func TestADuplicateRequestIdDoesNotOpenASecondRow(t *testing.T) {
	turns := NewTurns()
	inbox := newFakeInbox()
	approvals := &Approvals{Turns: turns, Engine: inbox, Poll: time.Millisecond}
	conn := openTurn(t, turns, "turn-1", "task-1", "device-1")

	if err := approvals.Route(context.Background(), conn, approvalRequestFrame(t, "req-1", "turn-1")); err != nil {
		t.Fatal(err)
	}
	waitForKind(t, conn, "approval.status")
	if err := approvals.Route(context.Background(), conn, approvalRequestFrame(t, "req-1", "turn-1")); err != nil {
		t.Fatalf("a repeated request id was dropped instead of answered: %v", err)
	}
	if got := len(inbox.questions()); got != 1 {
		t.Fatalf("the hub asked %d questions for one request id", got)
	}
	statuses := framesOfKind(conn.sent(), "approval.status")
	if len(statuses) != 2 {
		t.Fatalf("the device heard %d answers to two requests", len(statuses))
	}
	refusal, err := Decode[worker.ApprovalStatus](statuses[1])
	if err != nil {
		t.Fatal(err)
	}
	if refusal.RequestID != "req-1" || !strings.Contains(refusal.Error, "already open") {
		t.Fatalf("the repeat was answered with %+v, want a refusal it can match", refusal)
	}
	if pending := approvals.Pending(); len(pending) != 1 {
		t.Fatalf("pending = %v, want the one question that was actually asked", pending)
	}
}

// TestAbandonLeavesOtherConnectionsQuestionsAlone is the same scoping the turn
// registry has: a machine that reconnects must not have the question asked on
// its new connection settled by the old socket's ending.
func TestAbandonLeavesOtherConnectionsQuestionsAlone(t *testing.T) {
	turns := NewTurns()
	inbox := newFakeInbox()
	approvals := &Approvals{Turns: turns, Engine: inbox, Poll: time.Millisecond}
	old := openTurn(t, turns, "turn-old", "task-1", "device-1")
	replacement := newTestConn("device-1")
	if _, err := turns.Open("turn-new", "task-1", replacement, "studio"); err != nil {
		t.Fatal(err)
	}
	if err := approvals.Route(context.Background(), replacement, approvalRequestFrame(t, "req-new", "turn-new")); err != nil {
		t.Fatal(err)
	}
	waitForKind(t, replacement, "approval.status")

	if settled := approvals.Abandon(old); len(settled) != 0 {
		t.Fatalf("the replaced connection settled %v", settled)
	}
	if pending := approvals.Pending(); len(pending) != 1 {
		t.Fatalf("the live question is gone: %v", pending)
	}
}

// TestAWaitThatFailsIsRetriedUntilTheQuestionIsAnswered pins the difference
// between a wait that failed and an answer: a wait can fail on a store that
// blinked, or on an expiry that collided with a decision, and the machine is
// still blocked on a question a person can still answer. Giving up there would
// strand the agent on a question nobody is waiting to deliver.
func TestAWaitThatFailsIsRetriedUntilTheQuestionIsAnswered(t *testing.T) {
	turns := NewTurns()
	inbox := newFakeInbox()
	failed := make(chan struct{}, 4)
	approvals := &Approvals{
		Turns:  turns,
		Engine: inbox,
		Poll:   time.Millisecond,
		Warn: func(string, ...any) {
			select {
			case failed <- struct{}{}:
			default:
			}
		},
	}
	conn := openTurn(t, turns, "turn-1", "task-1", "device-1")

	if err := approvals.Route(context.Background(), conn, approvalRequestFrame(t, "req-1", "turn-1")); err != nil {
		t.Fatal(err)
	}
	waitForKind(t, conn, "approval.status")

	// The wait starts failing — a store that is briefly unavailable, which is
	// exactly when a decision must not be dropped.
	inbox.setWaitErr(errors.New("the approval store is unavailable"))
	select {
	case <-failed:
	case <-time.After(3 * time.Second):
		t.Fatal("the failing wait was never noticed")
	}
	inbox.setWaitErr(nil)
	inbox.decision <- store.DecisionApproved

	decision, err := Decode[worker.ApprovalDecision](waitForKind(t, conn, "approval.decision"))
	if err != nil {
		t.Fatal(err)
	}
	if decision.RequestID != "req-1" || decision.Decision != store.DecisionApproved {
		t.Fatalf("decision = %+v, want the answer that was given while the wait was failing", decision)
	}
}

// TestAQuestionWhoseRowIsGoneIsRefused is the other half of the same rule: when
// the question itself is gone, there is nothing left to wait for, and the device
// is told so rather than left polling a row that does not exist.
func TestAQuestionWhoseRowIsGoneIsRefused(t *testing.T) {
	turns := NewTurns()
	inbox := newFakeInbox()
	approvals := &Approvals{Turns: turns, Engine: inbox, Poll: time.Millisecond}
	conn := openTurn(t, turns, "turn-1", "task-1", "device-1")

	if err := approvals.Route(context.Background(), conn, approvalRequestFrame(t, "req-1", "turn-1")); err != nil {
		t.Fatal(err)
	}
	waitForKind(t, conn, "approval.status")

	// The row disappears underneath the wait, and the engine says so.
	inbox.drop("apr-1")
	inbox.setWaitErr(errors.New("no such approval"))

	statuses := framesOfKind(conn.sent(), "approval.status")
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && len(statuses) < 2 {
		time.Sleep(2 * time.Millisecond)
		statuses = framesOfKind(conn.sent(), "approval.status")
	}
	if len(statuses) < 2 {
		t.Fatal("the device was left waiting on a question that no longer exists")
	}
	refusal, err := Decode[worker.ApprovalStatus](statuses[1])
	if err != nil {
		t.Fatal(err)
	}
	if refusal.RequestID != "req-1" || refusal.Error == "" {
		t.Fatalf("refusal = %+v, want the reason the question ended", refusal)
	}
}

// TestAQuestionTheDeviceCannotBeToldAboutIsNotLeftAnswerable closes the one hole
// in the disconnect rule: the row is created, the answer cannot be delivered,
// and the entry is gone from the map by the time this returns — so Abandon can
// never reach it. Left pending, it would be a question in the console that a
// person can answer with nothing on the other end.
func TestAQuestionTheDeviceCannotBeToldAboutIsNotLeftAnswerable(t *testing.T) {
	turns := NewTurns()
	inbox := newFakeInbox()
	approvals := &Approvals{Turns: turns, Engine: inbox, Poll: time.Millisecond}
	conn := openTurn(t, turns, "turn-1", "task-1", "device-1")
	conn.sendErr = errors.New("the device's socket is not taking writes")

	if err := approvals.Route(context.Background(), conn, approvalRequestFrame(t, "req-1", "turn-1")); err == nil {
		t.Fatal("an answer that never left was reported as delivered")
	}
	if got := len(inbox.questions()); got != 1 {
		t.Fatalf("the hub asked %d questions, want the one it could not answer", got)
	}
	decision, via := inbox.decided("apr-1")
	if decision != store.DecisionExpired || via != "device_disconnected" {
		t.Fatalf("row = %q via %q, want it settled rather than left answerable", decision, via)
	}
	if pending := approvals.Pending(); len(pending) != 0 {
		t.Fatalf("the undeliverable question is still open: %v", pending)
	}
}

// TestARefusalFitsTheWireWithoutCuttingARune keeps a long reason inside the
// protocol's limit without turning its tail into mojibake: the message is going
// to a person, and half a character is worse than a shorter sentence.
func TestARefusalFitsTheWireWithoutCuttingARune(t *testing.T) {
	turns := NewTurns()
	inbox := newFakeInbox()
	approvals := &Approvals{Turns: turns, Engine: inbox, Poll: time.Millisecond}
	conn := openTurn(t, turns, "turn-1", "task-1", "device-1")
	inbox.refuse = errors.New(strings.Repeat("拒", worker.MaxApprovalError))

	if err := approvals.Route(context.Background(), conn, approvalRequestFrame(t, "req-1", "turn-1")); err != nil {
		t.Fatal(err)
	}
	status, err := Decode[worker.ApprovalStatus](waitForKind(t, conn, "approval.status"))
	if err != nil {
		t.Fatal(err)
	}
	if err := status.Validate(); err != nil {
		t.Fatalf("the refusal does not fit the wire: %v", err)
	}
	if !utf8.ValidString(status.Error) {
		t.Fatalf("the refusal was cut mid-character: %q", status.Error)
	}
}
