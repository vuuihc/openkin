package node

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/remote/worker"
)

// Default bounds on a remote turn. Both are about convergence, not throughput:
// a turn has to reach a terminal state even when the other side stops talking.
const (
	// DefaultStartTimeout is how long a turn may sit dispatched with no word
	// from the device before the Hub concludes it never started.
	DefaultStartTimeout = 30 * time.Second
	// DefaultPushGrace is how long the reason for a stalled turn waits for room
	// in a reader's buffer before the turn is closed without it.
	DefaultPushGrace = 30 * time.Second
	// cancelTimeout bounds one "stop that turn" write. It is short because the
	// answer to a cancel that cannot be delivered is the connection ending, not
	// a longer wait.
	cancelTimeout = 10 * time.Second
)

// Turns tracks the turns this Hub has dispatched and not yet seen finish.
//
// It is the Hub's half of remote execution: a turn opened here is what the
// engine sees as a RunHandle, and a turn.event frame arriving on a device's
// control channel is what feeds it. Nothing in the engine, the store, the
// cursor or the bus knows the difference between this and a local agent
// process — which is the point (ADR 0022 D8).
type Turns struct {
	// StartTimeout and PushGrace bound the two ways a remote turn can go quiet.
	// Zero means the defaults above; tests set them short.
	StartTimeout time.Duration
	PushGrace    time.Duration

	mu   sync.Mutex
	byID map[string]*turn
}

// ErrTurnUnknown means a frame arrived for a turn this Hub is not running:
// a duplicate sent after a reconnect, or a device sending rubbish.
var ErrTurnUnknown = errors.New("unknown turn")

type turn struct {
	id       string
	deviceID string
	// deviceLabel is what to call that device in a message a person reads. It
	// falls back to the id, which is all a device that never said its name has.
	deviceLabel string

	// sender is the connection this turn was dispatched on, and the only one
	// allowed to speak for it. A device that reconnects gets a new connection
	// with a new generation, so a stale socket's late frame is refused instead
	// of being accepted as the current run's, and a turn opened on the new
	// connection is not killed along with the old one's.
	sender Sender

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

	// startTimer fails the turn if the device never says it began. Cleared by
	// the first word from the device.
	startTimer *time.Timer

	// answered records which of the two ways a turn stops waiting for its first
	// word got there first: the device saying it started, or the deadline giving
	// up on it. The deadline runs on a timer goroutine, so without one flag
	// under one lock, an ack landing in the gap could be accepted and then
	// failed anyway — the transcript would say the device never started a turn
	// it is in fact running. Guarded by Turns.mu.
	answered bool

	closeOnce sync.Once
	ended     chan struct{}
	// closed is guarded by Turns.mu. It is what a delivery checks before it
	// counts itself, so no sender can start after the close has begun waiting.
	closed bool
	// overflowed is guarded by Turns.mu: it marks a turn whose reader fell a
	// whole buffer behind, so the ending is written once and later events for it
	// are dropped rather than queued behind a reader that is not coming back.
	overflowed bool
}

func NewTurns() *Turns {
	return &Turns{
		StartTimeout: DefaultStartTimeout,
		PushGrace:    DefaultPushGrace,
		byID:         make(map[string]*turn),
	}
}

func (t *Turns) startTimeout() time.Duration {
	if t.StartTimeout > 0 {
		return t.StartTimeout
	}
	return DefaultStartTimeout
}

func (t *Turns) pushGrace() time.Duration {
	if t.PushGrace > 0 {
		return t.PushGrace
	}
	return DefaultPushGrace
}

// Open registers a turn on the connection that is dispatching it, and returns
// the handle the engine will read. deviceLabel is the display name used in
// anything the transcript says about the machine; it may be empty.
//
// The same turn id twice is an error rather than a replacement: two runs
// sharing one id would interleave their events into one transcript, and one of
// them is a bug.
func (t *Turns) Open(turnID string, sender Sender, deviceLabel string) (*Handle, error) {
	if strings.TrimSpace(turnID) == "" || sender == nil {
		return nil, errors.New("turn id and connection are required")
	}
	if strings.TrimSpace(sender.DeviceID()) == "" {
		return nil, errors.New("turn has no device")
	}
	item := &turn{
		id:          turnID,
		deviceID:    sender.DeviceID(),
		deviceLabel: deviceLabel,
		sender:      sender,
		events:      make(chan adapter.Event, 64),
		ended:       make(chan struct{}),
	}

	t.mu.Lock()
	if _, exists := t.byID[turnID]; exists {
		t.mu.Unlock()
		return nil, fmt.Errorf("turn %s is already running", turnID)
	}
	t.byID[turnID] = item
	// Armed once the turn is in the registry, and under the same lock that
	// publishes it: a deadline that fired before the insert would end a turn
	// nobody can look up — and its close deletes from the registry by id, which
	// for a refused duplicate would be someone else's live turn.
	item.startTimer = time.AfterFunc(t.startTimeout(), func() {
		t.failIfOpen(item, fmt.Sprintf("device %s did not start the turn", item.name()))
	})
	t.mu.Unlock()
	return &Handle{turns: t, turn: item}, nil
}

// name is the device as a person would recognize it.
func (item *turn) name() string {
	if strings.TrimSpace(item.deviceLabel) != "" {
		return item.deviceLabel
	}
	return item.deviceID
}

// Started records that the device has taken a dispatch and is about to run it.
//
// Until this arrives the Hub has only its own write to the socket as evidence
// that anything was received, and a device that is connected but stuck would
// otherwise leave the turn open forever.
//
// It settles that question against the deadline under the registry lock: an ack
// that arrives as the deadline fires either wins (and the turn runs) or loses
// (and the caller is told the turn is already gone, so the device hears a
// cancel instead of nothing).
func (t *Turns) Started(sender Sender, started worker.TurnStarted) error {
	item, err := t.owned(sender, started.TurnID)
	if err != nil {
		return err
	}
	t.mu.Lock()
	if item.answered {
		t.mu.Unlock()
		return fmt.Errorf("%w: %s was given up on before the device answered", ErrTurnUnknown, started.TurnID)
	}
	item.answered = true
	if item.startTimer != nil {
		item.startTimer.Stop()
		item.startTimer = nil
	}
	t.mu.Unlock()
	return nil
}

// owned finds a turn this connection is allowed to speak for.
func (t *Turns) owned(sender Sender, turnID string) (*turn, error) {
	if sender == nil {
		return nil, errors.New("no connection")
	}
	t.mu.Lock()
	item, ok := t.byID[turnID]
	t.mu.Unlock()
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrTurnUnknown, turnID)
	}
	if item.deviceID != sender.DeviceID() || item.sender.Generation() != sender.Generation() {
		return nil, fmt.Errorf("turn %s belongs to another connection", turnID)
	}
	return item, nil
}

// Deliver hands one event from a device to the turn that is waiting for it.
//
// Delivery is by turn id, and the frame has to come from the connection the turn
// was dispatched on: a connection can only ever speak for its own turns.
func (t *Turns) Deliver(sender Sender, event worker.TurnEvent) error {
	// Decode first: a payload that is not an adapter event must not move the
	// sequence on, or the event it stood for is lost while the next one still
	// looks contiguous. A hole nobody can see is the one outcome the sequence
	// number exists to prevent.
	decoded, err := decodeEvent(event.Event)
	if err != nil {
		if item, ownErr := t.owned(sender, event.TurnID); ownErr == nil {
			t.fail(item, fmt.Sprintf("device sent an unreadable turn event: %v", err))
		}
		return err
	}

	item, err := t.owned(sender, event.TurnID)
	if err != nil {
		return err
	}
	t.mu.Lock()
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
func (t *Turns) Finish(sender Sender, finish worker.TurnFinish) error {
	item, err := t.owned(sender, finish.TurnID)
	if err != nil {
		return err
	}

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

// Abandon ends every turn that was dispatched on a connection that has ended.
//
// The failure is reported into each transcript, so the engine fails the turn
// with a reason rather than hanging on a socket that is gone.
//
// It is scoped to one connection, not to the device: a machine that reconnects
// while a turn is being dispatched must not have the new turn killed by the old
// socket's ending.
func (t *Turns) Abandon(sender Sender) []string {
	if sender == nil {
		return nil
	}
	deviceID, gen := sender.DeviceID(), sender.Generation()
	t.mu.Lock()
	var doomed []*turn
	for _, item := range t.byID {
		if item.deviceID == deviceID && item.sender.Generation() == gen {
			doomed = append(doomed, item)
		}
	}
	t.mu.Unlock()

	abandoned := make([]string, 0, len(doomed))
	for _, item := range doomed {
		t.fail(item, fmt.Sprintf("device %s disconnected mid-turn", item.name()))
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
	t.push(item, errorEvent(message))
	t.close(item)
}

// failIfOpen is fail for the deadline, which runs on its own goroutine and may
// be racing the device's first word about the turn.
//
// Claiming the turn and deciding to fail it are one step under the registry
// lock: checking first and failing afterwards would let an ack land in between,
// be accepted, and then be failed anyway.
func (t *Turns) failIfOpen(item *turn, message string) {
	t.mu.Lock()
	if item.closed || item.answered {
		t.mu.Unlock()
		return
	}
	item.answered = true
	t.mu.Unlock()
	t.fail(item, message)
}

// errorEvent is the transcript's record of a turn the Hub gave up on.
func errorEvent(message string) adapter.Event {
	payload, err := json.Marshal(map[string]string{"message": message})
	if err != nil {
		payload = []byte(`{"message":"turn failed"}`)
	}
	return adapter.Event{Type: "error", Payload: payload}
}

// push hands one event to the turn's reader. It reports whether the event was
// taken; an event that arrives after the turn ended is dropped.
//
// It never blocks. Its caller is the device's frame reader, and a turn whose
// consumer has stopped must not stop that machine's other turns from being read
// or its heartbeats from being answered — one stuck turn on a busy machine would
// otherwise take the whole connection down with it. A reader that is a whole
// buffer behind is not coming back, so the turn ends instead, and the reason is
// handed over on a goroutine that is allowed to wait for room: a transcript that
// says why beats a channel that closes for no stated reason.
func (t *Turns) push(item *turn, event adapter.Event) bool {
	t.mu.Lock()
	if item.closed || item.overflowed {
		t.mu.Unlock()
		return false
	}
	select {
	case item.events <- event:
		t.mu.Unlock()
		return true
	default:
		item.overflowed = true
		item.senders.Add(1)
		t.mu.Unlock()
	}

	go func() {
		// Tell the machine to stop before waiting for room: the reader is not
		// coming back, so the agent is working for a transcript nobody will
		// write, and the reason below is all that is left to send it.
		_ = t.cancelDevice(item, "the hub fell behind this turn's events")
		select {
		case item.events <- errorEvent("the hub fell behind this turn's events"):
		case <-item.ended:
		case <-time.After(t.pushGrace()):
			// Nobody is reading and nobody is coming back. The turn still ends: the
			// run saw no result, so the engine fails it either way, and the reason
			// was only ever readable by the reader that never arrived.
		}
		// Released before the close, not after it: close waits for the senders it
		// counted, and this goroutine is one of them.
		item.senders.Done()
		t.close(item)
	}()
	return false
}

// cancelDevice asks the machine to stop running a turn the Hub has given up on.
//
// Best effort by design: a device only finds out that the Hub stopped caring
// when its next frame is refused, and an agent that never sends another event
// would keep working to completion with nobody collecting the result. A failed
// write means the control channel is already gone, and the connection ending is
// what ends the turn on that side.
func (t *Turns) cancelDevice(item *turn, reason string) error {
	if item.sender == nil {
		return errors.New("no control channel")
	}
	frame, err := worker.NewFrame("turn.cancel", worker.TurnCancel{TurnID: item.id, Reason: reason})
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), cancelTimeout)
	defer cancel()
	return item.sender.Send(ctx, frame)
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
		timer := item.startTimer
		item.startTimer = nil
		t.mu.Unlock()
		if timer != nil {
			timer.Stop()
		}
		close(item.ended)
		item.senders.Wait()
		close(item.events)

		t.mu.Lock()
		// Only if this turn is still the one registered under that id: a turn
		// that was closed after being refused as a duplicate would otherwise
		// delete the live turn of the same id, and a turn that is not in the
		// registry can never be delivered, finished or abandoned — the task
		// would sit in running with a run loop parked on a channel nobody
		// closes.
		if t.byID[item.id] == item {
			delete(t.byID, item.id)
		}
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
	return h.turns.cancelDevice(h.turn, "canceled on the hub")
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
