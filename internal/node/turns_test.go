package node

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/remote/worker"
)

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
	handle, err := turns.Open("turn-1", "device-1", "task-1", nil)
	if err != nil {
		t.Fatal(err)
	}

	for seq, kind := range []string{"task_started", "message", "result"} {
		if err := turns.Deliver("device-1", worker.TurnEvent{
			TurnID: "turn-1", Seq: seq + 1, Event: event(t, kind),
		}); err != nil {
			t.Fatalf("seq %d: %v", seq+1, err)
		}
	}
	if err := turns.Finish("device-1", worker.TurnFinish{TurnID: "turn-1", Status: worker.TurnOK}); err != nil {
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
	handle, err := turns.Open("turn-1", "device-1", "task-1", nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, seq := range []int{1, 2, 2, 1, 3} {
		if err := turns.Deliver("device-1", worker.TurnEvent{
			TurnID: "turn-1", Seq: seq, Event: event(t, "message"),
		}); err != nil {
			t.Fatalf("seq %d: %v", seq, err)
		}
	}
	turns.Finish("device-1", worker.TurnFinish{TurnID: "turn-1", Status: worker.TurnOK})

	// A reconnect resends from where the Node thinks it left off, so the same
	// event arrives more than once. A transcript that repeats itself is as wrong
	// as one with a hole.
	if got := drain(t, handle); len(got) != 3 {
		t.Fatalf("events = %d, want 3", len(got))
	}
}

func TestTurnsEndOnAGap(t *testing.T) {
	turns := NewTurns()
	handle, err := turns.Open("turn-1", "device-1", "task-1", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := turns.Deliver("device-1", worker.TurnEvent{TurnID: "turn-1", Seq: 1, Event: event(t, "message")}); err != nil {
		t.Fatal(err)
	}
	if err := turns.Deliver("device-1", worker.TurnEvent{TurnID: "turn-1", Seq: 4, Event: event(t, "message")}); err == nil {
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
	if payload["message"] == "" {
		t.Fatalf("the gap was not explained: %v", payload)
	}
}

func TestTurnsRejectAnotherDevicesTurn(t *testing.T) {
	turns := NewTurns()
	handle, err := turns.Open("turn-1", "device-1", "task-1", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := turns.Deliver("device-2", worker.TurnEvent{TurnID: "turn-1", Seq: 1, Event: event(t, "message")}); err == nil {
		t.Fatal("a second device delivered into another device's turn")
	}
	if err := turns.Finish("device-2", worker.TurnFinish{TurnID: "turn-1", Status: worker.TurnOK}); err == nil {
		t.Fatal("a second device finished another device's turn")
	}
	// The turn is untouched: the impostor's frames changed nothing.
	if err := turns.Finish("device-1", worker.TurnFinish{TurnID: "turn-1", Status: worker.TurnOK}); err != nil {
		t.Fatal(err)
	}
	if got := drain(t, handle); len(got) != 0 {
		t.Fatalf("events = %+v", got)
	}
}

func TestTurnsUnknownTurn(t *testing.T) {
	turns := NewTurns()
	if err := turns.Deliver("device-1", worker.TurnEvent{TurnID: "gone", Seq: 1, Event: event(t, "message")}); !errors.Is(err, ErrTurnUnknown) {
		t.Fatalf("Deliver = %v, want ErrTurnUnknown", err)
	}
	if err := turns.Finish("device-1", worker.TurnFinish{TurnID: "gone", Status: worker.TurnOK}); !errors.Is(err, ErrTurnUnknown) {
		t.Fatalf("Finish = %v, want ErrTurnUnknown", err)
	}
}

func TestTurnsRefuseADuplicateID(t *testing.T) {
	turns := NewTurns()
	if _, err := turns.Open("turn-1", "device-1", "task-1", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := turns.Open("turn-1", "device-2", "task-2", nil); err == nil {
		t.Fatal("two runs were allowed to share a turn id")
	}
}

func TestTurnsAbandonADisconnectedDevice(t *testing.T) {
	turns := NewTurns()
	mine, err := turns.Open("turn-1", "device-1", "task-1", nil)
	if err != nil {
		t.Fatal(err)
	}
	theirs, err := turns.Open("turn-2", "device-2", "task-2", nil)
	if err != nil {
		t.Fatal(err)
	}

	if abandoned := turns.Abandon("device-1"); len(abandoned) != 1 || abandoned[0] != "turn-1" {
		t.Fatalf("abandoned = %v", abandoned)
	}
	// A turn whose device walked away has to end, or the engine waits on a
	// socket that no longer exists.
	got := drain(t, mine)
	if len(got) != 1 || got[0].Type != "error" {
		t.Fatalf("events = %+v", got)
	}
	// The other device's turn is untouched.
	if err := turns.Deliver("device-2", worker.TurnEvent{TurnID: "turn-2", Seq: 1, Event: event(t, "message")}); err != nil {
		t.Fatal(err)
	}
	if err := turns.Finish("device-2", worker.TurnFinish{TurnID: "turn-2", Status: worker.TurnOK}); err != nil {
		t.Fatal(err)
	}
	if got := drain(t, theirs); len(got) != 1 || got[0].Type != "message" {
		t.Fatalf("events = %+v", got)
	}
}

func TestTurnsFailedFinishCarriesTheReason(t *testing.T) {
	turns := NewTurns()
	handle, err := turns.Open("turn-1", "device-1", "task-1", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := turns.Finish("device-1", worker.TurnFinish{
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
	sent := make(chan worker.Frame, 1)
	send := func(_ context.Context, deviceID string, frame worker.Frame) error {
		if deviceID != "device-1" {
			t.Errorf("cancel went to %q", deviceID)
		}
		sent <- frame
		return nil
	}
	handle, err := turns.Open("turn-1", "device-1", "task-1", send)
	if err != nil {
		t.Fatal(err)
	}
	if err := handle.Cancel(); err != nil {
		t.Fatal(err)
	}
	select {
	case frame := <-sent:
		if frame.Kind != "turn.cancel" {
			t.Fatalf("frame = %q", frame.Kind)
		}
		cancel, err := Decode[worker.TurnCancel](frame)
		if err != nil {
			t.Fatal(err)
		}
		if cancel.TurnID != "turn-1" {
			t.Fatalf("cancel = %+v", cancel)
		}
	case <-time.After(time.Second):
		t.Fatal("no cancel was sent")
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
	handle, err := turns.Open("turn-1", "device-1", "task-1", func(context.Context, string, worker.Frame) error {
		return ErrOffline
	})
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
	if err := turns.RouteFrame(ctx, "device-1", worker.Frame{Kind: "heartbeat"}); err == nil {
		t.Fatal("a heartbeat was routed as turn traffic")
	}
	// A turn.event whose payload is not an adapter event is refused rather than
	// entering the transcript as an empty row.
	frame, err := worker.NewFrame("turn.event", map[string]any{"turn_id": "t", "seq": 1, "event": map[string]string{}})
	if err != nil {
		t.Fatal(err)
	}
	if err := turns.RouteFrame(ctx, "device-1", frame); err == nil {
		t.Fatal("an event with no type was accepted")
	}
}
