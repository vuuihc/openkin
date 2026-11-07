package node

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"nhooyr.io/websocket"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/remote/worker"
)

// testConn is a Node connection in a test: an identity for the Hub's turn
// registry, and somewhere for the frames it sends to land.
type testConn struct {
	deviceID string
	gen      uint64

	mu      sync.Mutex
	frames  []worker.Frame
	sendErr error
	closed  bool

	// slowKind, when set, is a frame kind this connection takes its time with:
	// a peer that is not reading, so a test can see who waits for the write.
	slowKind  string
	slowWrite time.Duration
}

func newTestConn(deviceID string) *testConn {
	return &testConn{deviceID: deviceID, gen: connGenerations.Add(1)}
}

func (c *testConn) DeviceID() string   { return c.deviceID }
func (c *testConn) Generation() uint64 { return c.gen }

func (c *testConn) Send(_ context.Context, frame worker.Frame) error {
	if frame.Kind == c.slowKind && c.slowWrite > 0 {
		time.Sleep(c.slowWrite)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.sendErr != nil {
		return c.sendErr
	}
	c.frames = append(c.frames, frame)
	return nil
}

func (c *testConn) Close(_ websocket.StatusCode, _ string) {
	c.mu.Lock()
	c.closed = true
	c.mu.Unlock()
}

func (c *testConn) sent() []worker.Frame {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]worker.Frame(nil), c.frames...)
}

// testConnFor is one connection per device id, so tests read like the Hub's own
// view: a device is a connection until it is replaced by a newer one.
var (
	testConnsMu sync.Mutex
	testConns   = map[string]*testConn{}
)

func testConnFor(deviceID string) *testConn {
	testConnsMu.Lock()
	defer testConnsMu.Unlock()
	conn, ok := testConns[deviceID]
	if !ok {
		conn = newTestConn(deviceID)
		testConns[deviceID] = conn
	}
	return conn
}

func event(t *testing.T, kind string) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(adapter.Event{Type: kind, Payload: json.RawMessage(`{"n":1}`)})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// drain reads everything the handle offers until it closes.
func drain(t *testing.T, h *Handle) []adapter.Event {
	t.Helper()
	var out []adapter.Event
	for event := range h.Events() {
		out = append(out, event)
	}
	return out
}

func TestTurnsDeliverInOrder(t *testing.T) {
	turns := NewTurns()
	handle, err := turns.Open("turn-1", "task-1", testConnFor("device-1"), "")
	if err != nil {
		t.Fatal(err)
	}

	for seq, kind := range []string{"task_started", "message", "result"} {
		if err := turns.Deliver(testConnFor("device-1"), worker.TurnEvent{
			TurnID: "turn-1", Seq: seq + 1, Event: event(t, kind),
		}); err != nil {
			t.Fatalf("seq %d: %v", seq+1, err)
		}
	}
	if err := turns.Finish(testConnFor("device-1"), worker.TurnFinish{TurnID: "turn-1", Status: worker.TurnOK}); err != nil {
		t.Fatal(err)
	}

	got := drain(t, handle)
	if len(got) != 3 {
		t.Fatalf("events = %+v", got)
	}
	for i, want := range []string{"task_started", "message", "result"} {
		if got[i].Type != want {
			t.Fatalf("event %d = %q, want %q", i, got[i].Type, want)
		}
	}
}

func TestTurnsDropResentEvents(t *testing.T) {
	turns := NewTurns()
	handle, err := turns.Open("turn-1", "task-1", testConnFor("device-1"), "")
	if err != nil {
		t.Fatal(err)
	}
	for _, seq := range []int{1, 2, 2, 1, 3} {
		if err := turns.Deliver(testConnFor("device-1"), worker.TurnEvent{
			TurnID: "turn-1", Seq: seq, Event: event(t, "message"),
		}); err != nil {
			t.Fatalf("seq %d: %v", seq, err)
		}
	}
	turns.Finish(testConnFor("device-1"), worker.TurnFinish{TurnID: "turn-1", Status: worker.TurnOK})

	// A reconnect resends from where the Node thinks it left off, so the same
	// event arrives more than once. A transcript that repeats itself is as wrong
	// as one with a hole.
	if got := drain(t, handle); len(got) != 3 {
		t.Fatalf("events = %d, want 3", len(got))
	}
}

func TestTurnsEndOnAGap(t *testing.T) {
	turns := NewTurns()
	handle, err := turns.Open("turn-1", "task-1", testConnFor("device-1"), "")
	if err != nil {
		t.Fatal(err)
	}
	if err := turns.Deliver(testConnFor("device-1"), worker.TurnEvent{TurnID: "turn-1", Seq: 1, Event: event(t, "message")}); err != nil {
		t.Fatal(err)
	}
	if err := turns.Deliver(testConnFor("device-1"), worker.TurnEvent{TurnID: "turn-1", Seq: 4, Event: event(t, "message")}); err == nil {
		t.Fatal("a gap was accepted")
	}

	// The turn ends with the reason in the transcript: events 2 and 3 are gone
	// and no amount of waiting brings them back.
	got := drain(t, handle)
	if len(got) != 2 || got[1].Type != "error" {
		t.Fatalf("events = %+v", got)
	}
	var payload map[string]string
	if err := json.Unmarshal(got[1].Payload, &payload); err != nil {
		t.Fatal(err)
	}
	// Whoever reads the transcript has to be able to tell what was lost.
	if !strings.Contains(payload["message"], "2..3") {
		t.Fatalf("the gap was not explained: %v", payload)
	}
	// And the turn is over rather than holding a slot for events that are gone.
	if running := turns.Running(""); len(running) != 0 {
		t.Fatalf("running = %v", running)
	}
}

func TestTurnsRejectAnotherDevicesTurn(t *testing.T) {
	turns := NewTurns()
	handle, err := turns.Open("turn-1", "task-1", testConnFor("device-1"), "")
	if err != nil {
		t.Fatal(err)
	}
	if err := turns.Deliver(testConnFor("device-2"), worker.TurnEvent{TurnID: "turn-1", Seq: 1, Event: event(t, "message")}); err == nil {
		t.Fatal("a second device delivered into another device's turn")
	}
	if err := turns.Finish(testConnFor("device-2"), worker.TurnFinish{TurnID: "turn-1", Status: worker.TurnOK}); err == nil {
		t.Fatal("a second device finished another device's turn")
	}
	// The turn is untouched: the impostor's frames changed nothing.
	if err := turns.Finish(testConnFor("device-1"), worker.TurnFinish{TurnID: "turn-1", Status: worker.TurnOK}); err != nil {
		t.Fatal(err)
	}
	if got := drain(t, handle); len(got) != 0 {
		t.Fatalf("events = %+v", got)
	}
}

func TestTurnsUnknownTurn(t *testing.T) {
	turns := NewTurns()
	if err := turns.Deliver(testConnFor("device-1"), worker.TurnEvent{TurnID: "gone", Seq: 1, Event: event(t, "message")}); !errors.Is(err, ErrTurnUnknown) {
		t.Fatalf("Deliver = %v, want ErrTurnUnknown", err)
	}
	if err := turns.Finish(testConnFor("device-1"), worker.TurnFinish{TurnID: "gone", Status: worker.TurnOK}); !errors.Is(err, ErrTurnUnknown) {
		t.Fatalf("Finish = %v, want ErrTurnUnknown", err)
	}
}

// TestTurnsEndOnAnUnreadableEvent: an event the Hub cannot read must not be
// swallowed. The sequence is what makes a transcript trustworthy, and consuming
// a number for an event nobody received leaves a hole the next event hides.
func TestTurnsEndOnAnUnreadableEvent(t *testing.T) {
	turns := NewTurns()
	handle, err := turns.Open("turn-1", "task-1", testConnFor("device-1"), "")
	if err != nil {
		t.Fatal(err)
	}
	if err := turns.Deliver(testConnFor("device-1"), worker.TurnEvent{
		TurnID: "turn-1", Seq: 1, Event: json.RawMessage(`{"type":`),
	}); err == nil {
		t.Fatal("an unreadable event was accepted")
	}
	got := drain(t, handle)
	if len(got) != 1 || got[0].Type != "error" {
		t.Fatalf("events = %+v", got)
	}
	if !strings.Contains(string(got[0].Payload), "unreadable") {
		t.Fatalf("the reason was lost: %s", got[0].Payload)
	}
	// The turn is over rather than waiting for the event after a hole.
	if running := turns.Running(""); len(running) != 0 {
		t.Fatalf("running = %v", running)
	}
}

// TestTurnsSurviveACancelRacingDelivery is the concurrency case production
// actually has: the engine ends a turn (cancel, or a device dropping) on its own
// goroutine while the device's frame reader is delivering into it. A close that
// lands between a sender's check and its send panics, and that panic takes the
// whole control channel down with every other turn on the machine.
func TestTurnsSurviveACancelRacingDelivery(t *testing.T) {
	payload := event(t, "message")
	for i := 0; i < 100; i++ {
		turns := NewTurns()
		handle, err := turns.Open("turn-1", "task-1", testConnFor("device-1"), "")
		if err != nil {
			t.Fatal(err)
		}
		// The engine's run loop, draining until the turn ends.
		drained := make(chan struct{})
		go func() {
			defer close(drained)
			for range handle.Events() {
			}
		}()

		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			for seq := 1; seq <= 8; seq++ {
				_ = turns.Deliver(testConnFor("device-1"), worker.TurnEvent{TurnID: "turn-1", Seq: seq, Event: payload})
			}
		}()
		go func() {
			defer wg.Done()
			_ = handle.Cancel()
		}()
		wg.Wait()
		<-drained
	}
}

func TestTurnsRefuseADuplicateID(t *testing.T) {
	turns := NewTurns()
	if _, err := turns.Open("turn-1", "task-1", testConnFor("device-1"), ""); err != nil {
		t.Fatal(err)
	}
	if _, err := turns.Open("turn-1", "task-1", testConnFor("device-2"), ""); err == nil {
		t.Fatal("two runs were allowed to share a turn id")
	}
}

func TestTurnsAbandonADisconnectedDevice(t *testing.T) {
	turns := NewTurns()
	turns.ReconnectGrace = 40 * time.Millisecond
	mine, err := turns.Open("turn-1", "task-1", testConnFor("device-1"), "")
	if err != nil {
		t.Fatal(err)
	}
	theirs, err := turns.Open("turn-2", "task-1", testConnFor("device-2"), "")
	if err != nil {
		t.Fatal(err)
	}
	// Both turns said they started, so the reconnect grace is the only deadline
	// in play: a turn whose device never answered has its own start timeout.
	if err := turns.Started(testConnFor("device-1"), worker.TurnStarted{TurnID: "turn-1"}); err != nil {
		t.Fatal(err)
	}
	if err := turns.Started(testConnFor("device-2"), worker.TurnStarted{TurnID: "turn-2"}); err != nil {
		t.Fatal(err)
	}

	if abandoned := turns.Abandon(testConnFor("device-1")); len(abandoned) != 1 || abandoned[0] != "turn-1" {
		t.Fatalf("abandoned = %v", abandoned)
	}
	// The turn is held, not failed: the machine may still be running it and may
	// reconnect to claim it. Abandon fails synchronously when it is going to, so
	// checking the buffer now is deterministic — waiting a fixed moment would
	// race the grace timer on a loaded machine.
	select {
	case event := <-mine.Events():
		t.Fatalf("a turn failed before the reconnect grace ended: %+v", event)
	default:
	}
	// Nobody claimed it, so it ends the way it always did, with a reason in the
	// transcript rather than a reader parked on a socket that no longer exists.
	got := drain(t, mine)
	if len(got) != 1 || got[0].Type != "error" {
		t.Fatalf("events = %+v", got)
	}
	if !strings.Contains(string(got[0].Payload), "disconnected mid-turn") {
		t.Fatalf("the reason was lost: %s", got[0].Payload)
	}
	// The other device's turn is untouched.
	if err := turns.Deliver(testConnFor("device-2"), worker.TurnEvent{TurnID: "turn-2", Seq: 1, Event: event(t, "message")}); err != nil {
		t.Fatal(err)
	}
	if err := turns.Finish(testConnFor("device-2"), worker.TurnFinish{TurnID: "turn-2", Status: worker.TurnOK}); err != nil {
		t.Fatal(err)
	}
	if got := drain(t, theirs); len(got) != 1 || got[0].Type != "message" {
		t.Fatalf("events = %+v", got)
	}
}

// A device that drops and comes back with the turn still running keeps it: the
// work never stopped on that machine, so the Hub must not stop waiting for it.
func TestTurnsAdoptATurnAcrossAReconnect(t *testing.T) {
	turns := NewTurns()
	first := newTestConn("device-1")
	handle, err := turns.Open("turn-1", "task-1", first, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := turns.Started(first, worker.TurnStarted{TurnID: "turn-1"}); err != nil {
		t.Fatal(err)
	}
	if err := turns.Deliver(first, worker.TurnEvent{TurnID: "turn-1", Seq: 1, Event: event(t, "message")}); err != nil {
		t.Fatal(err)
	}

	// The socket drops, and the machine reconnects with the turn still open.
	turns.Abandon(first)
	second := newTestConn("device-1")
	adopted, unknown := turns.Adopt(second, []string{"turn-1"})
	if len(adopted) != 1 || adopted[0] != "turn-1" || len(unknown) != 0 {
		t.Fatalf("adopted = %v, unknown = %v", adopted, unknown)
	}

	// The old connection can no longer speak for it; the new one can, and the
	// sequence carries on where the machine left off.
	if err := turns.Deliver(first, worker.TurnEvent{TurnID: "turn-1", Seq: 2, Event: event(t, "message")}); err == nil {
		t.Fatal("a replaced connection was allowed to speak for an adopted turn")
	}
	if err := turns.Deliver(second, worker.TurnEvent{TurnID: "turn-1", Seq: 2, Event: event(t, "message")}); err != nil {
		t.Fatal(err)
	}
	if err := turns.Finish(second, worker.TurnFinish{TurnID: "turn-1", Status: worker.TurnOK}); err != nil {
		t.Fatal(err)
	}
	if got := drain(t, handle); len(got) != 2 || got[0].Type != "message" || got[1].Type != "message" {
		t.Fatalf("events = %+v", got)
	}
}

// A second start ack for a live turn is the Node resending a frame it could not
// confirm, not a mistake: refusing it as an unknown turn would make the Hub
// cancel the healthy run it describes.
func TestTurnsAcceptADuplicateStartAck(t *testing.T) {
	turns := NewTurns()
	conn := newTestConn("device-1")
	handle, err := turns.Open("turn-1", "task-1", conn, "")
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := turns.Started(conn, worker.TurnStarted{TurnID: "turn-1"}); err != nil {
			t.Fatalf("start ack %d: %v", i+1, err)
		}
	}
	if err := turns.Deliver(conn, worker.TurnEvent{TurnID: "turn-1", Seq: 1, Event: event(t, "message")}); err != nil {
		t.Fatal(err)
	}
	if err := turns.Finish(conn, worker.TurnFinish{TurnID: "turn-1", Status: worker.TurnOK}); err != nil {
		t.Fatal(err)
	}
	if got := drain(t, handle); len(got) != 1 || got[0].Type != "message" {
		t.Fatalf("events = %+v", got)
	}
	// Once the turn is over the answer changes: there is no run left, so the
	// device should stop rather than keep reporting into it.
	if err := turns.Started(conn, worker.TurnStarted{TurnID: "turn-1"}); !errors.Is(err, ErrTurnUnknown) {
		t.Fatalf("start ack after the turn ended = %v, want ErrTurnUnknown", err)
	}
}

// Listing a turn in a resume is the device saying it holds the dispatch. That
// answers the start question even when the ack itself died with the socket, so
// adoption must settle the start deadline rather than let it fire later on a
// run that is doing fine.
func TestTurnsAdoptionSettlesTheStartDeadline(t *testing.T) {
	turns := NewTurns()
	first := newTestConn("device-1")
	handle, err := turns.Open("turn-1", "task-1", first, "")
	if err != nil {
		t.Fatal(err)
	}
	// No Started here: the ack is exactly what the socket lost.
	turns.Abandon(first)

	second := newTestConn("device-1")
	adopted, unknown := turns.Adopt(second, []string{"turn-1"})
	if len(adopted) != 1 || adopted[0] != "turn-1" || len(unknown) != 0 {
		t.Fatalf("adopted = %v, unknown = %v", adopted, unknown)
	}

	turns.mu.Lock()
	item := turns.byID["turn-1"]
	answered, armed := item.answered, item.startTimer != nil
	turns.mu.Unlock()
	if !answered || armed {
		t.Fatalf("adoption left the start question open (answered=%v, timer=%v)", answered, armed)
	}
	// The deadline may still be running when the decision lands. Firing it now
	// must be a no-op, not the end of a turn nobody gave up on.
	turns.failIfOpen(item, "device never started the turn")
	if err := turns.Deliver(second, worker.TurnEvent{TurnID: "turn-1", Seq: 1, Event: event(t, "message")}); err != nil {
		t.Fatalf("the adopted turn was failed by its start deadline: %v", err)
	}
	if err := turns.Finish(second, worker.TurnFinish{TurnID: "turn-1", Status: worker.TurnOK}); err != nil {
		t.Fatal(err)
	}
	if got := drain(t, handle); len(got) != 1 || got[0].Type != "message" {
		t.Fatalf("events = %+v", got)
	}
}

// The start deadline does not preempt the reconnect grace. A turn whose ack
// died with the socket is orphaned, not unstarted: the machine may still be
// running it, and the grace is the deadline that decides.
func TestTurnsAnOrphanedTurnOutlivesTheStartDeadline(t *testing.T) {
	turns := NewTurns()
	first := newTestConn("device-1")
	handle, err := turns.Open("turn-1", "task-1", first, "")
	if err != nil {
		t.Fatal(err)
	}
	// No Started: the ack is exactly what the drop swallowed.
	turns.Abandon(first)
	turns.mu.Lock()
	item := turns.byID["turn-1"]
	turns.mu.Unlock()

	// The start timer fires while the turn is orphaned.
	turns.failIfOpen(item, "device never started the turn")
	select {
	case event := <-handle.Events():
		t.Fatalf("the start deadline ended an orphaned turn: %+v", event)
	default:
	}

	second := newTestConn("device-1")
	adopted, unknown := turns.Adopt(second, []string{"turn-1"})
	if len(adopted) != 1 || len(unknown) != 0 {
		t.Fatalf("adopted = %v, unknown = %v", adopted, unknown)
	}
	if err := turns.Deliver(second, worker.TurnEvent{TurnID: "turn-1", Seq: 1, Event: event(t, "message")}); err != nil {
		t.Fatal(err)
	}
	if err := turns.Finish(second, worker.TurnFinish{TurnID: "turn-1", Status: worker.TurnOK}); err != nil {
		t.Fatal(err)
	}
	if got := drain(t, handle); len(got) != 1 || got[0].Type != "message" {
		t.Fatalf("events = %+v", got)
	}
}

// A deadline that has already decided to end a turn must not have it adopted in
// the window before the transcript write lands: the machine would keep running
// work the Hub is ending. The claim is taken under the registry lock, so this
// test sets the state that claim leaves behind.
func TestTurnsDoNotAdoptATurnTheyAreAlreadyFailing(t *testing.T) {
	turns := NewTurns()
	first := newTestConn("device-1")
	handle, err := turns.Open("turn-1", "task-1", first, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := turns.Started(first, worker.TurnStarted{TurnID: "turn-1"}); err != nil {
		t.Fatal(err)
	}
	turns.Abandon(first)

	turns.mu.Lock()
	item := turns.byID["turn-1"]
	item.orphaned = false
	item.failing = true
	turns.mu.Unlock()

	second := newTestConn("device-1")
	adopted, unknown := turns.Adopt(second, []string{"turn-1"})
	if len(adopted) != 0 || len(unknown) != 1 || unknown[0] != "turn-1" {
		t.Fatalf("adopted = %v, unknown = %v, want the failing turn refused", adopted, unknown)
	}
	turns.fail(item, "device device-1 disconnected mid-turn")
	got := drain(t, handle)
	if len(got) != 1 || got[0].Type != "error" {
		t.Fatalf("events = %+v", got)
	}
}

// A device that reconnects without a turn it used to hold is telling the Hub
// the run is gone. Waiting out the grace would only delay the answer it has
// already given.
func TestTurnsFailATurnTheReconnectedDeviceDidNotClaim(t *testing.T) {
	turns := NewTurns()
	first := newTestConn("device-1")
	handle, err := turns.Open("turn-1", "task-1", first, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := turns.Started(first, worker.TurnStarted{TurnID: "turn-1"}); err != nil {
		t.Fatal(err)
	}
	turns.Abandon(first)

	second := newTestConn("device-1")
	adopted, unknown := turns.Adopt(second, nil)
	if len(adopted) != 0 || len(unknown) != 0 {
		t.Fatalf("adopted = %v, unknown = %v", adopted, unknown)
	}
	got := drain(t, handle)
	if len(got) != 1 || got[0].Type != "error" {
		t.Fatalf("events = %+v", got)
	}
	if !strings.Contains(string(got[0].Payload), "disconnected mid-turn") {
		t.Fatalf("the reason was lost: %s", got[0].Payload)
	}
}

// A turn id is not a capability: a reconnecting machine can only claim turns
// the Hub dispatched to that same device.
func TestTurnsRefuseToAdoptAnotherDevicesTurn(t *testing.T) {
	turns := NewTurns()
	turns.ReconnectGrace = 20 * time.Millisecond
	owner := newTestConn("device-1")
	handle, err := turns.Open("turn-1", "task-1", owner, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := turns.Started(owner, worker.TurnStarted{TurnID: "turn-1"}); err != nil {
		t.Fatal(err)
	}
	turns.Abandon(owner)

	intruder := newTestConn("device-2")
	adopted, unknown := turns.Adopt(intruder, []string{"turn-1"})
	if len(adopted) != 0 || len(unknown) != 1 || unknown[0] != "turn-1" {
		t.Fatalf("adopted = %v, unknown = %v", adopted, unknown)
	}
	// The turn still belongs to the first machine, which has not reconnected:
	// the intruder cannot speak for it, and the grace still ends it.
	if err := turns.Deliver(intruder, worker.TurnEvent{TurnID: "turn-1", Seq: 1, Event: event(t, "message")}); err == nil {
		t.Fatal("another device was allowed to speak for the turn")
	}
	got := drain(t, handle)
	if len(got) != 1 || got[0].Type != "error" {
		t.Fatalf("events = %+v", got)
	}
}

func TestTurnsFailedFinishCarriesTheReason(t *testing.T) {
	turns := NewTurns()
	handle, err := turns.Open("turn-1", "task-1", testConnFor("device-1"), "")
	if err != nil {
		t.Fatal(err)
	}
	if err := turns.Finish(testConnFor("device-1"), worker.TurnFinish{
		TurnID: "turn-1", Status: worker.TurnError, Error: "claude-code exited 1",
	}); err != nil {
		t.Fatal(err)
	}
	got := drain(t, handle)
	if len(got) != 1 || got[0].Type != "error" {
		t.Fatalf("events = %+v", got)
	}
	if !strings.Contains(string(got[0].Payload), "claude-code exited 1") {
		t.Fatalf("the reason was lost: %s", got[0].Payload)
	}
}

func TestCancelSendsTurnCancel(t *testing.T) {
	turns := NewTurns()
	conn := newTestConn("device-1")
	handle, err := turns.Open("turn-1", "task-1", conn, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := handle.Cancel(); err != nil {
		t.Fatal(err)
	}
	// Cancel ends the turn locally without waiting for the request to go out —
	// the engine's slot must not wait on a machine that may take a while to
	// notice — so the frame is on its way, not necessarily gone.
	select {
	case _, open := <-handle.Events():
		if open {
			t.Fatal("cancel left the event channel open")
		}
	case <-time.After(time.Second):
		t.Fatal("cancel did not close the event channel")
	}
	cancel := waitForKind(t, conn, "turn.cancel")
	decoded, err := Decode[worker.TurnCancel](cancel)
	if err != nil {
		t.Fatal(err)
	}
	if decoded.TurnID != "turn-1" {
		t.Fatalf("cancel = %+v", decoded)
	}
}

// TestCancelOnADeadConnectionEndsTheTurn is the other half of that: a request
// that cannot be delivered is not a reason to keep the turn open here, and it is
// not silent either — it goes to the warning sink, which is all that is left of
// it.
func TestCancelOnADeadConnectionEndsTheTurn(t *testing.T) {
	turns := NewTurns()
	var mu sync.Mutex
	var warned []string
	turns.Warn = func(format string, args ...any) {
		mu.Lock()
		warned = append(warned, fmt.Sprintf(format, args...))
		mu.Unlock()
	}
	conn := newTestConn("device-1")
	conn.sendErr = ErrOffline
	handle, err := turns.Open("turn-1", "task-1", conn, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := handle.Cancel(); err != nil {
		t.Fatal(err)
	}
	if len(turns.Running("")) != 0 {
		t.Fatal("the turn is still registered after a cancel")
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		reported := append([]string(nil), warned...)
		mu.Unlock()
		if len(reported) > 0 {
			if !strings.Contains(reported[0], "turn-1") {
				t.Fatalf("the warning does not name the turn: %q", reported[0])
			}
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("a cancel nobody could deliver was not reported")
}

// TestASlowCancelDoesNotHoldUpTheEndOfTheTurn is what "the turn ends either way"
// costs: the request to the device can wait for the connection's write turn, and
// neither the frame reader ending the turn nor the engine asking for its slot
// back is allowed to wait with it.
func TestASlowCancelDoesNotHoldUpTheEndOfTheTurn(t *testing.T) {
	turns := NewTurns()
	turns.PushGrace = 5 * time.Second
	conn := newTestConn("device-1")
	conn.slowKind = "turn.cancel"
	conn.slowWrite = 3 * time.Second
	handle, err := turns.Open("turn-1", "task-1", conn, "")
	if err != nil {
		t.Fatal(err)
	}

	// The turn overflows: its reader stopped reading, so the Hub is giving up on
	// it and telling the device to stop.
	for seq := 1; seq <= 200; seq++ {
		_ = turns.Deliver(conn, worker.TurnEvent{TurnID: "turn-1", Seq: seq, Event: event(t, "message")})
	}

	// The engine takes its slot back.
	started := time.Now()
	if err := handle.Cancel(); err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("cancel waited %s for a connection that is slow to write", elapsed)
	}
	// And the channel the engine reads really does close, rather than being
	// merely readable: the turn is over while the request is still on its way
	// out.
	drained := make(chan int, 1)
	go func() { drained <- len(drain(t, handle)) }()
	select {
	case count := <-drained:
		if count == 0 {
			t.Fatal("the turn ended without a transcript")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("cancel did not end the turn while the write to the device was in flight")
	}
}

func TestRouteFrameRejectsRubbish(t *testing.T) {
	turns := NewTurns()
	ctx := context.Background()
	if err := turns.RouteFrame(ctx, testConnFor("device-1"), worker.Frame{Kind: "heartbeat"}); err == nil {
		t.Fatal("a heartbeat was routed as turn traffic")
	}
	// A turn.event whose payload is not an adapter event is refused rather than
	// entering the transcript as an empty row.
	frame, err := worker.NewFrame("turn.event", map[string]any{"turn_id": "t", "seq": 1, "event": map[string]string{}})
	if err != nil {
		t.Fatal(err)
	}
	if err := turns.RouteFrame(ctx, testConnFor("device-1"), frame); err == nil {
		t.Fatal("an event with no type was accepted")
	}
}

// A turn belongs to the connection that dispatched it until the same device
// claims it on a newer one. A machine that reconnects while work is being
// handed to it must not have the new turn killed by the old socket's ending,
// and the old socket's late frames must not be read as the new run's.
func TestTurnsBindToTheConnectionThatDispatchedThem(t *testing.T) {
	turns := NewTurns()
	first := newTestConn("device-1")
	if _, err := turns.Open("turn-old", "task-1", first, ""); err != nil {
		t.Fatal(err)
	}
	if err := turns.Started(first, worker.TurnStarted{TurnID: "turn-old"}); err != nil {
		t.Fatal(err)
	}

	// The machine reconnects: a new connection, same device.
	second := newTestConn("device-1")
	if second.Generation() == first.Generation() {
		t.Fatal("two connections share a generation")
	}
	fresh, err := turns.Open("turn-new", "task-1", second, "")
	if err != nil {
		t.Fatal(err)
	}

	// The old connection ending holds its own turn for the reconnect grace and
	// does not touch the new connection's turn.
	abandoned := turns.Abandon(first)
	if len(abandoned) != 1 || abandoned[0] != "turn-old" {
		t.Fatalf("abandoned = %v", abandoned)
	}
	// The new connection claims the old turn back, as a reconnecting machine
	// with the work still running does.
	if adopted, unknown := turns.Adopt(second, []string{"turn-old"}); len(adopted) != 1 || len(unknown) != 0 {
		t.Fatalf("adopted = %v, unknown = %v", adopted, unknown)
	}

	// Frames from the replaced connection are refused, even for a turn id it
	// once owned, and even for the turn now running on the new connection.
	if err := turns.Deliver(first, worker.TurnEvent{TurnID: "turn-new", Seq: 1, Event: event(t, "message")}); err == nil {
		t.Fatal("a replaced connection was allowed to speak for the new turn")
	}
	if err := turns.Finish(first, worker.TurnFinish{TurnID: "turn-new", Status: worker.TurnOK}); err == nil {
		t.Fatal("a replaced connection was allowed to finish the new turn")
	}
	if err := turns.Deliver(first, worker.TurnEvent{TurnID: "turn-old", Seq: 1, Event: event(t, "message")}); err == nil {
		t.Fatal("a replaced connection was allowed to speak for an adopted turn")
	}
	// The new connection can.
	if err := turns.Deliver(second, worker.TurnEvent{TurnID: "turn-new", Seq: 1, Event: event(t, "message")}); err != nil {
		t.Fatal(err)
	}
	if err := turns.Finish(second, worker.TurnFinish{TurnID: "turn-new", Status: worker.TurnOK}); err != nil {
		t.Fatal(err)
	}
	if got := drain(t, fresh); len(got) != 1 || got[0].Type != "message" {
		t.Fatalf("events = %+v", got)
	}
}

// A device that is connected but never starts the turn is the one case silence
// cannot be told from work. The Hub gives it a deadline and then says so in the
// transcript, instead of holding the task open forever.
func TestTurnsFailATurnTheDeviceNeverStarted(t *testing.T) {
	turns := NewTurns()
	turns.StartTimeout = 40 * time.Millisecond
	conn := newTestConn("device-1")
	handle, err := turns.Open("turn-1", "task-1", conn, "")
	if err != nil {
		t.Fatal(err)
	}
	got := drain(t, handle)
	if len(got) != 1 || got[0].Type != "error" {
		t.Fatalf("events = %+v", got)
	}
	if !strings.Contains(string(got[0].Payload), "did not start") {
		t.Fatalf("payload = %s", got[0].Payload)
	}
	if running := turns.Running(""); len(running) != 0 {
		t.Fatalf("the turn is still registered: %v", running)
	}
}

func TestTurnsStartedStopsTheDeadline(t *testing.T) {
	turns := NewTurns()
	turns.StartTimeout = 40 * time.Millisecond
	conn := newTestConn("device-1")
	handle, err := turns.Open("turn-1", "task-1", conn, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := turns.Started(conn, worker.TurnStarted{TurnID: "turn-1"}); err != nil {
		t.Fatal(err)
	}
	if err := turns.Deliver(conn, worker.TurnEvent{TurnID: "turn-1", Seq: 1, Event: event(t, "message")}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(80 * time.Millisecond)
	// The deadline must not have fired: a turn that started is a turn the Hub
	// waits on, however long the agent takes.
	if err := turns.Finish(conn, worker.TurnFinish{TurnID: "turn-1", Status: worker.TurnOK}); err != nil {
		t.Fatal(err)
	}
	got := drain(t, handle)
	if len(got) != 1 || got[0].Type != "message" {
		t.Fatalf("events = %+v", got)
	}
	// A start for a connection that does not own the turn is refused.
	other := newTestConn("device-1")
	if _, err := turns.Open("turn-2", "task-1", conn, ""); err != nil {
		t.Fatal(err)
	}
	if err := turns.Started(other, worker.TurnStarted{TurnID: "turn-2"}); err == nil {
		t.Fatal("another connection claimed to have started the turn")
	}
	if err := turns.Started(conn, worker.TurnStarted{TurnID: "gone"}); !errors.Is(err, ErrTurnUnknown) {
		t.Fatalf("err = %v", err)
	}
}

// A reader that has stopped must not stop the connection: the device's other
// turns and its heartbeats are the read loop's business, and one stuck consumer
// holding that loop would take them all down. The stuck turn ends instead, with
// a reason in its transcript.
func TestTurnsDoNotLetOneStuckReaderStallTheConnection(t *testing.T) {
	turns := NewTurns()
	// Long enough that the reader below, which starts as soon as the burst is
	// over, is certain to be handed the reason.
	turns.PushGrace = 5 * time.Second
	stuck := newTestConn("device-1")
	stuckHandle, err := turns.Open("turn-stuck", "task-1", stuck, "")
	if err != nil {
		t.Fatal(err)
	}
	fine := newTestConn("device-2")
	fineHandle, err := turns.Open("turn-fine", "task-1", fine, "")
	if err != nil {
		t.Fatal(err)
	}
	// Nobody reads turn-stuck: fill its buffer and then some.
	done := make(chan struct{})
	go func() {
		defer close(done)
		for seq := 1; seq <= 200; seq++ {
			_ = turns.Deliver(stuck, worker.TurnEvent{TurnID: "turn-stuck", Seq: seq, Event: event(t, "message")})
		}
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("delivery blocked the read loop on a turn nobody is reading")
	}

	// The other device's turn is unaffected while that resolves.
	if err := turns.Deliver(fine, worker.TurnEvent{TurnID: "turn-fine", Seq: 1, Event: event(t, "message")}); err != nil {
		t.Fatal(err)
	}
	if err := turns.Finish(fine, worker.TurnFinish{TurnID: "turn-fine", Status: worker.TurnOK}); err != nil {
		t.Fatal(err)
	}
	if got := drain(t, fineHandle); len(got) != 1 || got[0].Type != "message" {
		t.Fatalf("events = %+v", got)
	}

	// The stalled turn says why it ended, once someone reads it.
	got := drain(t, stuckHandle)
	if len(got) != 65 {
		t.Fatalf("the backlog is %d events, want the 64 that fit plus the reason", len(got))
	}
	last := got[len(got)-1]
	if last.Type != "error" || !strings.Contains(string(last.Payload), "fell behind") {
		t.Fatalf("last event = %+v", last)
	}
}

// A reader that never comes back must not leave the turn open forever. The
// registry is what says so without reading the channel: a turn is in it only
// while it is running.
func TestTurnsEndEvenWhenNobodyReadsTheEvents(t *testing.T) {
	turns := NewTurns()
	turns.PushGrace = 30 * time.Millisecond
	conn := newTestConn("device-1")
	handle, err := turns.Open("turn-1", "task-1", conn, "")
	if err != nil {
		t.Fatal(err)
	}
	for seq := 1; seq <= 200; seq++ {
		if err := turns.Deliver(conn, worker.TurnEvent{TurnID: "turn-1", Seq: seq, Event: event(t, "message")}); err != nil {
			t.Fatal(err)
		}
	}
	deadline := time.Now().Add(5 * time.Second)
	for turns.Running("") != nil {
		if time.Now().After(deadline) {
			t.Fatal("a turn with nobody reading it stayed open")
		}
		time.Sleep(5 * time.Millisecond)
	}
	// And the channel the engine is parked on is closed, so its run loop ends
	// rather than holding a concurrency slot. The backlog is whatever fit in the
	// buffer; what matters is that reading it ends.
	drained := make(chan int, 1)
	go func() { drained <- len(drain(t, handle)) }()
	select {
	case n := <-drained:
		if n == 0 {
			t.Fatal("the turn ended without a single event in its transcript")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the turn ended but its event channel stayed open")
	}
}

// The blast radius of a stalled reader is the connection, so the turn that has
// to keep working is the other one on the *same* device: it shares the read
// loop the stuck turn is not allowed to hold.
func TestOneStuckTurnDoesNotStallAnotherTurnOnTheSameConnection(t *testing.T) {
	turns := NewTurns()
	turns.PushGrace = 5 * time.Second
	conn := newTestConn("device-1")
	if _, err := turns.Open("turn-stuck", "task-1", conn, ""); err != nil {
		t.Fatal(err)
	}
	fine, err := turns.Open("turn-fine", "task-1", conn, "")
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		for seq := 1; seq <= 200; seq++ {
			_ = turns.Deliver(conn, worker.TurnEvent{TurnID: "turn-stuck", Seq: seq, Event: event(t, "message")})
		}
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("delivery blocked the read loop on a turn nobody is reading")
	}

	if err := turns.Deliver(conn, worker.TurnEvent{TurnID: "turn-fine", Seq: 1, Event: event(t, "message")}); err != nil {
		t.Fatal(err)
	}
	if err := turns.Finish(conn, worker.TurnFinish{TurnID: "turn-fine", Status: worker.TurnOK}); err != nil {
		t.Fatal(err)
	}
	if got := drain(t, fine); len(got) != 1 || got[0].Type != "message" {
		t.Fatalf("the other turn on the same connection = %+v", got)
	}
}

// The device hears that the Hub gave up on a turn instead of finding out when
// its next frame is refused: an agent part-way through a long silence would
// otherwise keep working for a transcript nobody is writing any more.
func TestAnOverflowingTurnTellsTheDeviceToStop(t *testing.T) {
	turns := NewTurns()
	turns.PushGrace = 5 * time.Second
	conn := newTestConn("device-1")
	if _, err := turns.Open("turn-1", "task-1", conn, ""); err != nil {
		t.Fatal(err)
	}
	for seq := 1; seq <= 200; seq++ {
		if err := turns.Deliver(conn, worker.TurnEvent{TurnID: "turn-1", Seq: seq, Event: event(t, "message")}); err != nil {
			t.Fatal(err)
		}
	}

	deadline := time.Now().Add(5 * time.Second)
	for {
		for _, frame := range conn.sent() {
			if frame.Kind != "turn.cancel" {
				continue
			}
			cancel, err := Decode[worker.TurnCancel](frame)
			if err != nil {
				t.Fatal(err)
			}
			if cancel.TurnID != "turn-1" {
				t.Fatalf("cancel = %+v", cancel)
			}
			if !strings.Contains(cancel.Reason, "fell behind") {
				t.Fatalf("the device is not told why: %q", cancel.Reason)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("the device was never told to stop the turn")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// The deadline fires on a goroutine of its own, so "the device answered" and
// "the deadline gave up" are settled under one lock. Without that, an ack in
// the gap is accepted — the Hub sends no cancel, and the device keeps working —
// and the turn is failed anyway as one that never started.
func TestAStartedTurnIsNotFailedByTheDeadline(t *testing.T) {
	for round := 0; round < 200; round++ {
		turns := NewTurns()
		// As soon as a timer can fire, which is what makes this a race at all.
		turns.StartTimeout = time.Nanosecond
		conn := newTestConn("device-1")
		if _, err := turns.Open("turn-1", "task-1", conn, ""); err != nil {
			t.Fatal(err)
		}
		err := turns.Started(conn, worker.TurnStarted{TurnID: "turn-1"})
		if err != nil {
			// The deadline won and the turn is gone. The Hub answers that with a
			// cancel, because this is the same "not running any more" answer a
			// frame for a turn from a previous Hub gets.
			if !errors.Is(err, ErrTurnUnknown) {
				t.Fatalf("err = %v", err)
			}
			gone := time.Now().Add(2 * time.Second)
			for turns.Running("") != nil && time.Now().Before(gone) {
				time.Sleep(time.Millisecond)
			}
			continue
		}
		time.Sleep(time.Millisecond)
		if running := turns.Running(""); len(running) != 1 || running[0] != "turn-1" {
			t.Fatalf("the deadline failed a turn whose start the hub had accepted: %v", running)
		}
	}
}

// A refused duplicate must not take the live turn with it. Its close deletes
// from the registry by id, and that id is someone else's: a turn that is not in
// the registry can never be delivered, finished or abandoned, so its task would
// sit in running with a run loop parked on a channel nobody closes.
func TestARefusedDuplicateDoesNotTakeTheLiveTurnWithIt(t *testing.T) {
	turns := NewTurns()
	conn := newTestConn("device-1")
	if _, err := turns.Open("turn-1", "task-1", conn, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := turns.Open("turn-1", "task-1", conn, ""); err == nil {
		t.Fatal("a second turn with the same id was accepted")
	}
	// And the same for a turn that never made it into the registry at all: the
	// duplicate used to arm its deadline before it knew the id was taken, so
	// what closed the live turn was a turn with no claim to the id.
	stranger := &turn{
		id: "turn-1", deviceID: conn.deviceID, sender: conn,
		events: make(chan adapter.Event, 1), ended: make(chan struct{}),
	}
	turns.close(stranger)

	if running := turns.Running(""); len(running) != 1 || running[0] != "turn-1" {
		t.Fatalf("the live turn is no longer registered: %v", running)
	}
	if err := turns.Deliver(conn, worker.TurnEvent{TurnID: "turn-1", Seq: 1, Event: event(t, "message")}); err != nil {
		t.Fatalf("the live turn can no longer be delivered to: %v", err)
	}
	if err := turns.Finish(conn, worker.TurnFinish{TurnID: "turn-1", Status: worker.TurnOK}); err != nil {
		t.Fatal(err)
	}
}

// A transcript is read by a person, so the machine in it is named the way that
// person knows it. The id is what the row is keyed on; it is not what anyone
// would recognize.
func TestATurnNamesItsDeviceTheWayAPersonDoes(t *testing.T) {
	turns := NewTurns()
	turns.StartTimeout = 20 * time.Millisecond
	handle, err := turns.Open("turn-1", "task-1", newTestConn("01HZZZDEVICE"), "studio")
	if err != nil {
		t.Fatal(err)
	}
	got := drain(t, handle)
	if len(got) != 1 || got[0].Type != "error" {
		t.Fatalf("events = %+v", got)
	}
	if said := string(got[0].Payload); !strings.Contains(said, "device studio did not start the turn") {
		t.Fatalf("the transcript says %s", said)
	}
}

// RouteFrame's turn.resume is the wire half of adoption: the listed turns move
// to the new connection, and the ones this machine claims but the Hub no longer
// has are told to stop.
func TestRouteFrameResumeAdoptsAndStopsUnknownTurns(t *testing.T) {
	turns := NewTurns()
	first := newTestConn("device-1")
	handle, err := turns.Open("turn-1", "task-1", first, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := turns.Started(first, worker.TurnStarted{TurnID: "turn-1"}); err != nil {
		t.Fatal(err)
	}
	turns.Abandon(first)

	second := newTestConn("device-1")
	frame, err := worker.NewFrame("turn.resume", worker.TurnResume{
		TurnIDs: []string{"turn-1", "turn-from-before-the-restart"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := turns.RouteFrame(context.Background(), second, frame); err != nil {
		t.Fatal(err)
	}

	// The known turn is adopted: its next event arrives on the new connection.
	if err := turns.Deliver(second, worker.TurnEvent{TurnID: "turn-1", Seq: 1, Event: event(t, "message")}); err != nil {
		t.Fatal(err)
	}
	// The unknown one is answered with a cancel, so the machine stops a run
	// nobody is collecting.
	var stopped []string
	for _, sent := range second.sent() {
		if sent.Kind != "turn.cancel" {
			continue
		}
		cancel, err := Decode[worker.TurnCancel](sent)
		if err != nil {
			t.Fatal(err)
		}
		stopped = append(stopped, cancel.TurnID)
	}
	if len(stopped) != 1 || stopped[0] != "turn-from-before-the-restart" {
		t.Fatalf("cancels = %v, want the unknown turn only", stopped)
	}

	if err := turns.Finish(second, worker.TurnFinish{TurnID: "turn-1", Status: worker.TurnOK}); err != nil {
		t.Fatal(err)
	}
	if got := drain(t, handle); len(got) != 1 || got[0].Type != "message" {
		t.Fatalf("events = %+v", got)
	}
}
