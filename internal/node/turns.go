package node

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/remote/worker"
)

// SendFunc writes one frame to one device's control channel.
type SendFunc func(ctx context.Context, deviceID string, frame worker.Frame) error

// Turns tracks the turns this Hub has dispatched and not yet seen finish.
//
// It is the Hub's half of remote execution: a turn opened here is what the
// engine sees as a RunHandle, and a turn.event frame arriving on a device's
// control channel is what feeds it. Nothing in the engine, the store, the
// cursor or the bus knows the difference between this and a local agent
// process — which is the point (ADR 0022 D8).
type Turns struct {
	mu   sync.Mutex
	byID map[string]*turn
}

// ErrTurnUnknown means a frame arrived for a turn this Hub is not running:
// a duplicate sent after a reconnect, or a device sending rubbish.
var ErrTurnUnknown = errors.New("unknown turn")

type turn struct {
	id       string
	deviceID string
	taskID   string
	send     SendFunc

	// events is buffered because its reader is the engine's run loop, which is
	// doing store writes, and its writer is the device's frame reader, which is
	// also reading heartbeats. A slow Hub must slow a turn down rather than
	// block the control channel outright, but it must not silently drop
	// anything either — a lost event is a hole in the transcript.
	events chan adapter.Event

	// highest is the last local_seq accepted. A reconnecting Node resends from
	// where it thinks it left off, so duplicates are expected and dropped.
	highest int

	// senders counts the deliveries in flight. A delivery hands its event to the
	// engine's run loop, which is the reader; ending the turn closes that
	// channel, and closing it under a sender would panic, so the close waits for
	// them (see close).
	senders sync.WaitGroup

	closeOnce sync.Once
	ended     chan struct{}
	// closed is guarded by Turns.mu. It is what a delivery checks before it
	// counts itself, so no sender can start after the close has begun waiting.
	closed bool
}

func NewTurns() *Turns {
	return &Turns{byID: make(map[string]*turn)}
}

// Open registers a turn and returns the handle the engine will read.
//
// The same turn id twice is an error rather than a replacement: two runs
// sharing one id would interleave their events into one transcript, and one of
// them is a bug.
func (t *Turns) Open(turnID, deviceID, taskID string, send SendFunc) (*Handle, error) {
	if strings.TrimSpace(turnID) == "" || strings.TrimSpace(deviceID) == "" {
		return nil, errors.New("turn id and device id are required")
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if _, exists := t.byID[turnID]; exists {
		return nil, fmt.Errorf("turn %s is already running", turnID)
	}
	item := &turn{
		id:       turnID,
		deviceID: deviceID,
		taskID:   taskID,
		send:     send,
		events:   make(chan adapter.Event, 64),
		ended:    make(chan struct{}),
	}
	t.byID[turnID] = item
	return &Handle{turns: t, turn: item}, nil
}

// Deliver hands one event from a device to the turn that is waiting for it.
//
// Delivery is by turn id, and the frame has to come from the device the turn
// was dispatched to: a device can only ever speak for its own turns.
func (t *Turns) Deliver(deviceID string, event worker.TurnEvent) error {
	// Decode first: a payload that is not an adapter event must not move the
	// sequence on, or the event it stood for is lost while the next one still
	// looks contiguous. A hole nobody can see is the one outcome the sequence
	// number exists to prevent.
	decoded, err := decodeEvent(event.Event)
	if err != nil {
		t.mu.Lock()
		item, ok := t.byID[event.TurnID]
		owned := ok && item.deviceID == deviceID
		t.mu.Unlock()
		if owned {
			t.fail(item, fmt.Sprintf("device sent an unreadable turn event: %v", err))
		}
		return err
	}

	t.mu.Lock()
	item, ok := t.byID[event.TurnID]
	if !ok {
		t.mu.Unlock()
		return fmt.Errorf("%w: %s", ErrTurnUnknown, event.TurnID)
	}
	if item.deviceID != deviceID {
		t.mu.Unlock()
		return fmt.Errorf("turn %s belongs to another device", event.TurnID)
	}
	if event.Seq <= item.highest {
		// A resend after a reconnect. Dropping it is the whole reason the
		// sequence number is on the wire.
		t.mu.Unlock()
		return nil
	}
	if event.Seq != item.highest+1 {
		t.mu.Unlock()
		// An event is missing and no amount of waiting brings it back. Ending
		// the turn says so in the transcript; carrying on would leave a hole
		// nobody can see.
		t.fail(item, fmt.Sprintf("device skipped turn events %d..%d", item.highest+1, event.Seq-1))
		return fmt.Errorf("turn %s skipped from %d to %d", event.TurnID, item.highest, event.Seq)
	}
	item.highest = event.Seq
	t.mu.Unlock()

	t.push(item, decoded)
	return nil
}

// Finish records how a device says a turn ended.
func (t *Turns) Finish(deviceID string, finish worker.TurnFinish) error {
	t.mu.Lock()
	item, ok := t.byID[finish.TurnID]
	if !ok {
		t.mu.Unlock()
		return fmt.Errorf("%w: %s", ErrTurnUnknown, finish.TurnID)
	}
	if item.deviceID != deviceID {
		t.mu.Unlock()
		return fmt.Errorf("turn %s belongs to another device", finish.TurnID)
	}
	t.mu.Unlock()

	switch finish.Status {
	case worker.TurnOK, worker.TurnCanceled:
		// The events already carry the outcome; the engine reads the terminal
		// one out of the transcript and does not need to be told twice.
		t.close(item)
	case worker.TurnError:
		message := strings.TrimSpace(finish.Error)
		if message == "" {
			message = "the device reported a failed turn"
		}
		t.fail(item, message)
	}
	return nil
}

// Abandon ends every turn on a device that is no longer connected.
//
// The failure is reported into each transcript, so the engine fails the turn
// with a reason rather than hanging on a socket that is gone.
func (t *Turns) Abandon(deviceID string) []string {
	t.mu.Lock()
	var doomed []*turn
	for _, item := range t.byID {
		if item.deviceID == deviceID {
			doomed = append(doomed, item)
		}
	}
	t.mu.Unlock()

	abandoned := make([]string, 0, len(doomed))
	for _, item := range doomed {
		t.fail(item, fmt.Sprintf("device %s disconnected mid-turn", deviceID))
		abandoned = append(abandoned, item.id)
	}
	return abandoned
}

// Running reports the turns in flight, for one device or for all of them.
func (t *Turns) Running(deviceID string) []string {
	t.mu.Lock()
	defer t.mu.Unlock()
	var ids []string
	for id, item := range t.byID {
		if deviceID == "" || item.deviceID == deviceID {
			ids = append(ids, id)
		}
	}
	return ids
}

// fail ends a turn as failed, putting the reason in the transcript first.
func (t *Turns) fail(item *turn, message string) {
	payload, err := json.Marshal(map[string]string{"message": message})
	if err != nil {
		payload = []byte(`{"message":"turn failed"}`)
	}
	t.push(item, adapter.Event{Type: "error", Payload: payload})
	t.close(item)
}

// push hands one event to the turn's reader. It reports whether the event was
// taken; an event that arrives after the turn ended is dropped.
func (t *Turns) push(item *turn, event adapter.Event) bool {
	t.mu.Lock()
	if item.closed {
		t.mu.Unlock()
		return false
	}
	item.senders.Add(1)
	t.mu.Unlock()

	defer item.senders.Done()
	select {
	case item.events <- event:
		return true
	case <-item.ended:
		return false
	}
}

// close ends a turn and closes its event channel, which is what the engine's
// run loop is waiting for.
//
// Closing a channel that another goroutine may be sending on is a panic waiting
// for a schedule, and it is reachable here: the engine cancels a turn at the
// same moment a device's frame for it is being routed. So the close is ordered
// against the senders — the flag stops new ones, the closed ended channel wakes
// the parked ones, and only then is the channel closed.
func (t *Turns) close(item *turn) {
	item.closeOnce.Do(func() {
		t.mu.Lock()
		item.closed = true
		t.mu.Unlock()
		close(item.ended)
		item.senders.Wait()
		close(item.events)

		t.mu.Lock()
		delete(t.byID, item.id)
		t.mu.Unlock()
	})
}

// Handle is one remote turn, as the engine sees it: a local agent run.
type Handle struct {
	turns *Turns
	turn  *turn
}

func (h *Handle) Events() <-chan adapter.Event { return h.turn.events }

// Cancel asks the device to stop, and ends this side's turn either way.
//
// It does not wait for the device to acknowledge. Cancel means the engine has
// already stopped reading the transcript, and a handle whose channel never
// closes would leave the run loop blocked forever — holding one of the engine's
// concurrency slots for a turn nobody is running any more. Anything the device
// says afterwards arrives for a turn the Hub has finished with and is dropped.
func (h *Handle) Cancel() error {
	defer h.turns.close(h.turn)
	if h.turn.send == nil {
		return errors.New("no control channel")
	}
	frame, err := worker.NewFrame("turn.cancel", worker.TurnCancel{
		TurnID: h.turn.id,
		Reason: "canceled on the hub",
	})
	if err != nil {
		return err
	}
	if err := h.turn.send(context.Background(), h.turn.deviceID, frame); err != nil {
		return fmt.Errorf("cancel turn %s: %w", h.turn.id, err)
	}
	return nil
}

// decodeEvent unwraps one adapter event from a turn.event payload.
func decodeEvent(raw json.RawMessage) (adapter.Event, error) {
	var event adapter.Event
	if err := json.Unmarshal(raw, &event); err != nil {
		return adapter.Event{}, fmt.Errorf("decode turn event: %w", err)
	}
	if strings.TrimSpace(event.Type) == "" {
		return adapter.Event{}, errors.New("turn event has no type")
	}
	return event, nil
}
