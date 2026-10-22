package node

import (
	"context"
	"encoding/json"
	"errors"
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
}

func newTestConn(deviceID string) *testConn {
	return &testConn{deviceID: deviceID, gen: connGenerations.Add(1)}
}

func (c *testConn) DeviceID() string   { return c.deviceID }
func (c *testConn) Generation() uint64 { return c.gen }

func (c *testConn) Send(_ context.Context, frame worker.Frame) error {
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
	handle, err := turns.Open("turn-1", testConnFor("device-1"), "")
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
	handle, err := turns.Open("turn-1", testConnFor("device-1"), "")
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
	handle, err := turns.Open("turn-1", testConnFor("device-1"), "")
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
	handle, err := turns.Open("turn-1", testConnFor("device-1"), "")
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
	handle, err := turns.Open("turn-1", testConnFor("device-1"), "")
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
		handle, err := turns.Open("turn-1", testConnFor("device-1"), "")
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
	if _, err := turns.Open("turn-1", testConnFor("device-1"), ""); err != nil {
		t.Fatal(err)
	}
	if _, err := turns.Open("turn-1", testConnFor("device-2"), ""); err == nil {
		t.Fatal("two runs were allowed to share a turn id")
	}
}

func TestTurnsAbandonADisconnectedDevice(t *testing.T) {
	turns := NewTurns()
	mine, err := turns.Open("turn-1", testConnFor("device-1"), "")
	if err != nil {
		t.Fatal(err)
	}
	theirs, err := turns.Open("turn-2", testConnFor("device-2"), "")
	if err != nil {
		t.Fatal(err)
	}

	if abandoned := turns.Abandon(testConnFor("device-1")); len(abandoned) != 1 || abandoned[0] != "turn-1" {
		t.Fatalf("abandoned = %v", abandoned)
	}
	// A turn whose device walked away has to end, or the engine waits on a
	// socket that no longer exists.
	got := drain(t, mine)
	if len(got) != 1 || got[0].Type != "error" {
		t.Fatalf("events = %+v", got)
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

func TestTurnsFailedFinishCarriesTheReason(t *testing.T) {
	turns := NewTurns()
	handle, err := turns.Open("turn-1", testConnFor("device-1"), "")
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
	handle, err := turns.Open("turn-1", conn, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := handle.Cancel(); err != nil {
		t.Fatal(err)
	}
	frames := conn.sent()
	if len(frames) != 1 || frames[0].Kind != "turn.cancel" {
		t.Fatalf("frames = %+v", frames)
	}
	cancel, err := Decode[worker.TurnCancel](frames[0])
	if err != nil {
		t.Fatal(err)
	}
	if cancel.TurnID != "turn-1" {
		t.Fatalf("cancel = %+v", cancel)
	}
	// Cancel ends the turn locally too: the engine's slot must not wait on a
	// machine that may take a while to notice.
	select {
	case _, open := <-handle.Events():
		if open {
			t.Fatal("cancel left the event channel open")
		}
	case <-time.After(time.Second):
		t.Fatal("cancel did not close the event channel")
	}
}

func TestCancelOnADeadConnectionEndsTheTurn(t *testing.T) {
	turns := NewTurns()
	conn := newTestConn("device-1")
	conn.sendErr = ErrOffline
	handle, err := turns.Open("turn-1", conn, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := handle.Cancel(); err == nil {
		t.Fatal("cancel on an unreachable device reported success")
	}
	if len(turns.Running("")) != 0 {
		t.Fatal("the turn is still registered after a failed cancel")
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

// A turn belongs to the connection that dispatched it, not to the device. A
// machine that reconnects while work is being handed to it must not have the
// new turn killed by the old socket's ending, and the old socket's late frames
// must not be read as the new run's.
func TestTurnsBindToTheConnectionThatDispatchedThem(t *testing.T) {
	turns := NewTurns()
	first := newTestConn("device-1")
	if _, err := turns.Open("turn-old", first, ""); err != nil {
		t.Fatal(err)
	}

	// The machine reconnects: a new connection, same device.
	second := newTestConn("device-1")
	if second.Generation() == first.Generation() {
		t.Fatal("two connections share a generation")
	}
	fresh, err := turns.Open("turn-new", second, "")
	if err != nil {
		t.Fatal(err)
	}

	// The old connection ending settles its own turn and nothing else.
	abandoned := turns.Abandon(first)
	if len(abandoned) != 1 || abandoned[0] != "turn-old" {
		t.Fatalf("abandoned = %v", abandoned)
	}
	if running := turns.Running("device-1"); len(running) != 1 || running[0] != "turn-new" {
		t.Fatalf("running = %v", running)
	}

	// Frames from the replaced connection are refused, even for a turn id it
	// once owned, and even for the turn now running on the new connection.
	if err := turns.Deliver(first, worker.TurnEvent{TurnID: "turn-new", Seq: 1, Event: event(t, "message")}); err == nil {
		t.Fatal("a replaced connection was allowed to speak for the new turn")
	}
	if err := turns.Finish(first, worker.TurnFinish{TurnID: "turn-new", Status: worker.TurnOK}); err == nil {
		t.Fatal("a replaced connection was allowed to finish the new turn")
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
	handle, err := turns.Open("turn-1", conn, "")
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
	handle, err := turns.Open("turn-1", conn, "")
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
	if _, err := turns.Open("turn-2", conn, ""); err != nil {
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
	stuckHandle, err := turns.Open("turn-stuck", stuck, "")
	if err != nil {
		t.Fatal(err)
	}
	fine := newTestConn("device-2")
	fineHandle, err := turns.Open("turn-fine", fine, "")
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
	handle, err := turns.Open("turn-1", conn, "")
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
	if _, err := turns.Open("turn-stuck", conn, ""); err != nil {
		t.Fatal(err)
	}
	fine, err := turns.Open("turn-fine", conn, "")
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
	if _, err := turns.Open("turn-1", conn, ""); err != nil {
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
		if _, err := turns.Open("turn-1", conn, ""); err != nil {
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
	if _, err := turns.Open("turn-1", conn, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := turns.Open("turn-1", conn, ""); err == nil {
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
	handle, err := turns.Open("turn-1", newTestConn("01HZZZDEVICE"), "studio")
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
