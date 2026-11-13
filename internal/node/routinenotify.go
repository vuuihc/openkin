package node

import (
	"context"
	"fmt"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/oklog/ulid/v2"

	"github.com/vuuihc/openkin/internal/notify"
	"github.com/vuuihc/openkin/internal/remote/worker"
)

// RoutineNotifyForwarder carries a Node's routine report and disabled alerts to
// its Hub over the control channel, so the Hub can ring the phones it
// registered. It is deliberately process-local and best-effort:
//
//   - A frame is only sent once the Hub's hello_ack said it understands
//     `routine.notify`; an old Hub closes the whole connection on an unknown
//     frame kind, so a Node must never send one it did not advertise. Until
//     that handshake the report is held (bounded) rather than sent, so a
//     report that fires before the first successful handshake survives to ring
//     once the Node reaches a Hub that understands it.
//   - An item is held until the Hub acknowledges its event id, and replayed on
//     each reconnect, so a write that died with the socket is retried and the
//     Hub dedupes by (device, event id). The queue and the dedupe are both
//     in-process: a Node restart loses undelivered reports, and APNs delivery
//     remains best-effort, not durable or exactly-once.
//   - While the Hub is unreachable, the queue is bounded; an overflow drops the
//     oldest report rather than growing without a ceiling.
//
// Socket writes never happen under the forwarder's mutex or on the caller's
// goroutine: a single sender goroutine owns the network, so a stalled Hub
// cannot block the task engine, the socket reader, or the heartbeat while a
// routine report is waiting to be written.
type RoutineNotifyForwarder struct {
	warn func(format string, args ...any)

	mu        sync.Mutex
	supported bool
	sendFrame WriteFunc
	// gen numbers each installed sender. A write that started on one connection
	// is discarded when another connection replaced it, so a frame in flight can
	// never be marked "sent" on a socket that is already gone.
	gen uint64

	pending   []routineNotifyItem
	byEventID map[string]struct{}
	bytes     int

	maxItems int
	maxBytes int

	// wake is signalled (non-blocking, buffered) whenever there is more to
	// write. done stops the sender goroutine on Close.
	wake          chan struct{}
	done          chan struct{}
	once          sync.Once
	retryInterval time.Duration
}

type routineNotifyItem struct {
	frame worker.Frame
	// sent is per-connection: a frame is written once on the connection that
	// carried it, and marked unsent again when that connection ends so the
	// next one replays it until the Hub acknowledges it.
	sent bool
}

const (
	routineNotifyMaxItems = 64
	routineNotifyMaxBytes = 256 << 10
)

// NewRoutineNotifyForwarder returns an empty forwarder and starts its sender
// goroutine. warn may be nil. Stop the goroutine with Close.
func NewRoutineNotifyForwarder(warn func(format string, args ...any)) *RoutineNotifyForwarder {
	return newRoutineNotifyForwarder(warn, 5*time.Second)
}

func newRoutineNotifyForwarder(warn func(format string, args ...any), retryInterval time.Duration) *RoutineNotifyForwarder {
	f := &RoutineNotifyForwarder{
		warn:          warn,
		byEventID:     make(map[string]struct{}),
		maxItems:      routineNotifyMaxItems,
		maxBytes:      routineNotifyMaxBytes,
		wake:          make(chan struct{}, 1),
		done:          make(chan struct{}),
		retryInterval: retryInterval,
	}
	go f.run()
	return f
}

// Close stops the sender goroutine. It is idempotent.
func (f *RoutineNotifyForwarder) Close() {
	f.once.Do(func() { close(f.done) })
}

func (f *RoutineNotifyForwarder) logf(format string, args ...any) {
	if f.warn != nil {
		f.warn(format, args...)
	}
}

func (f *RoutineNotifyForwarder) signalWake() {
	select {
	case f.wake <- struct{}{}:
	default:
	}
}

// SetSupported records whether the Hub understands routine.notify. It is set
// from hello_ack on each connection. An upgrade is per-connection: when the Hub
// later advertises support after an unsupported handshake, whatever was queued
// in the meantime flushes. A downgrade back to an unsupported Hub simply stops
// the writer; the items stay queued for the next supported connection, so no
// unknown frame is ever transmitted to a Hub that would close on it.
func (f *RoutineNotifyForwarder) SetSupported(ok bool) {
	f.mu.Lock()
	changed := f.supported != ok
	f.supported = ok
	if ok {
		for i := range f.pending {
			f.pending[i].sent = false
		}
	}
	f.mu.Unlock()
	if changed && ok {
		f.signalWake()
	}
}

// SetSender installs the connection's write path and flushes what it still
// holds. A nil send means the connection ended: nothing is dropped, but every
// item is marked unsent so the next connection replays it.
//
// This returns immediately: the actual writes happen on the sender goroutine
// with their own bounded deadline, never on the connection code's call path.
func (f *RoutineNotifyForwarder) SetSender(send WriteFunc) {
	f.mu.Lock()
	f.gen++
	f.sendFrame = send
	for i := range f.pending {
		f.pending[i].sent = false
	}
	f.mu.Unlock()
	f.signalWake()
}

// eventID names one alert for dedupe and acknowledgement. Reports are keyed by
// their run, which ends exactly once; a disabled alert is one occurrence, so it
// gets a fresh id each time (a routine can be re-enabled and trip again).
func routineEventID(event notify.RoutineEvent) string {
	switch event.Event {
	case "report":
		return "report:" + event.TaskID
	case "disabled":
		return "disabled:" + event.RoutineID + ":" + ulid.Make().String()
	default:
		return "routine:" + ulid.Make().String()
	}
}

// Send queues one routine alert and wakes the sender. It never blocks the
// caller on the socket and never drops the report just because the current Hub
// does not advertise routine.notify: it is held (bounded) until a supported
// handshake, so a report before the first handshake completes is not lost.
//
// Title and body are clipped to the wire bounds on UTF-8 boundaries before the
// frame is built, because the Hub validates those bounds and would otherwise
// drop a perfectly legible long report. The local desktop notification already
// showed the full text before this is called.
func (f *RoutineNotifyForwarder) Send(ctx context.Context, event notify.RoutineEvent) error {
	event.Title = truncateUTF8(event.Title, worker.MaxRoutineNotifyTitle)
	event.Body = truncateUTF8(event.Body, worker.MaxRoutineNotifyBody)
	msg := worker.RoutineNotify{
		Event:     event.Event,
		EventID:   routineEventID(event),
		RoutineID: event.RoutineID,
		TaskID:    event.TaskID,
		Title:     event.Title,
		Body:      event.Body,
	}
	if err := msg.Validate(); err != nil {
		f.logf("node: routine notification dropped: %v", err)
		return fmt.Errorf("routine notify: %w", err)
	}
	frame, err := worker.NewFrame("routine.notify", msg)
	if err != nil {
		f.logf("node: routine notification dropped: %v", err)
		return fmt.Errorf("routine notify: %w", err)
	}

	f.mu.Lock()
	dup := false
	if _, ok := f.byEventID[msg.EventID]; ok {
		dup = true
	} else {
		f.enqueueLocked(frame)
	}
	f.mu.Unlock()
	if !dup {
		f.signalWake()
	}
	return nil
}

// HandleAck removes the acknowledged item. It is wired into the Node's frame
// handler for routine.notify.ack frames.
func (f *RoutineNotifyForwarder) HandleAck(frame worker.Frame) {
	ack, err := Decode[worker.RoutineNotifyAck](frame)
	if err != nil || ack.EventID == "" {
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.removeLocked(ack.EventID)
}

// run is the single sender. It owns all network writes.
func (f *RoutineNotifyForwarder) run() {
	ticker := time.NewTicker(f.retryInterval)
	defer ticker.Stop()
	for {
		select {
		case <-f.done:
			return
		case <-f.wake:
			f.drain()
		case <-ticker.C:
			// A successful write is not acceptance: the Hub may be busy or
			// temporarily unable to resolve the device. Retry unacknowledged
			// frames on this connection with the same deduplication key.
			f.mu.Lock()
			for i := range f.pending {
				f.pending[i].sent = false
			}
			f.mu.Unlock()
			f.drain()
		}
	}
}

// drain writes queued frames until the outbox has no unsent item, the Hub does
// not understand the frame, or a write fails. A failed write leaves the item
// for the retry ticker because a timeout can be transient even on a live
// connection. The mutex is released before every write and never held during
// network I/O.
func (f *RoutineNotifyForwarder) drain() {
	for {
		f.mu.Lock()
		if !f.supported || f.sendFrame == nil {
			f.mu.Unlock()
			return
		}
		idx := -1
		for i := range f.pending {
			if !f.pending[i].sent {
				idx = i
				break
			}
		}
		if idx < 0 {
			f.mu.Unlock()
			return
		}
		frame := f.pending[idx].frame
		send := f.sendFrame
		gen := f.gen
		f.mu.Unlock()

		ctx, cancel := context.WithTimeout(context.Background(), nodeWriteTimeout)
		err := send(ctx, frame)
		cancel()

		f.mu.Lock()
		if f.gen != gen {
			// The connection changed while the write was in flight. The item is
			// still unsent and the replacement connection replays it.
			f.mu.Unlock()
			return
		}
		if err != nil {
			// A write can time out while waiting behind another writer even when
			// the socket itself remains healthy. Keep this connection installed
			// and let the retry ticker try again; a genuinely dead socket will
			// still be replaced through SetSender(nil) by the connection loop.
			f.mu.Unlock()
			return
		}
		f.markSentLocked(frame)
		f.mu.Unlock()
	}
}

func (f *RoutineNotifyForwarder) eventIDLocked(frame worker.Frame) string {
	raw, err := Decode[worker.RoutineNotify](frame)
	if err != nil {
		return ""
	}
	return raw.EventID
}

func (f *RoutineNotifyForwarder) enqueueLocked(frame worker.Frame) {
	eventID := f.eventIDLocked(frame)
	if eventID == "" {
		return
	}
	if _, dup := f.byEventID[eventID]; dup {
		return
	}
	// Bounded: drop the oldest while the outbox is over budget, so a burst of
	// reports cannot grow memory without a ceiling and the newest alert still
	// rings.
	for len(f.pending) > 0 && (len(f.pending) >= f.maxItems || f.bytes+len(frame.Data) > f.maxBytes) {
		dropped := f.pending[0]
		f.pending = f.pending[1:]
		f.bytes -= len(dropped.frame.Data)
		if id := f.eventIDLocked(dropped.frame); id != "" {
			delete(f.byEventID, id)
		}
		f.logf("node: routine notification queue full; dropped the oldest report")
	}
	f.pending = append(f.pending, routineNotifyItem{frame: frame})
	f.bytes += len(frame.Data)
	f.byEventID[eventID] = struct{}{}
}

func (f *RoutineNotifyForwarder) removeLocked(eventID string) {
	if _, ok := f.byEventID[eventID]; !ok {
		return
	}
	delete(f.byEventID, eventID)
	kept := f.pending[:0]
	for _, item := range f.pending {
		if f.eventIDLocked(item.frame) == eventID {
			f.bytes -= len(item.frame.Data)
			continue
		}
		kept = append(kept, item)
	}
	f.pending = kept
}

// markSentLocked marks the item with the same envelope as sent, if it is still
// queued. An acknowledgement that arrived while the write was in flight has
// already removed it, in which case this is a no-op.
func (f *RoutineNotifyForwarder) markSentLocked(frame worker.Frame) {
	eventID := f.eventIDLocked(frame)
	if eventID == "" {
		return
	}
	for i := range f.pending {
		if f.pending[i].frame.Kind == frame.Kind && f.eventIDLocked(f.pending[i].frame) == eventID {
			f.pending[i].sent = true
			return
		}
	}
}

// truncateUTF8 clips s to at most max bytes without splitting a rune.
func truncateUTF8(s string, max int) string {
	if len(s) <= max {
		return s
	}
	s = s[:max]
	for len(s) > 0 && !utf8.ValidString(s) {
		s = s[:len(s)-1]
	}
	return s
}
