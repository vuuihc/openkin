package task

import (
	"encoding/json"
	"sync"
	"sync/atomic"

	"github.com/vuuihc/kin/internal/store"
)

// WSMessage is pushed on the global bus (spec §6).
type WSMessage struct {
	Kind string `json:"kind"` // task_update | task_deleted | event | approval_update
	Data any    `json:"data"`
}

// Bus is an in-process fan-out for WebSocket clients.
//
// Publish is non-blocking: a full subscriber is dropped (channel closed) so
// the slow client cannot remain "connected" after losing data. Closing the
// channel causes handleWS to exit and the browser reconnect path to run.
type Bus struct {
	mu       sync.Mutex
	subs     map[chan WSMessage]struct{}
	bufSize  int
	overflow atomic.Uint64
}

// NewBus creates a pub/sub bus.
func NewBus() *Bus {
	return &Bus{
		subs:    make(map[chan WSMessage]struct{}),
		bufSize: 64,
	}
}

// Subscribe returns a channel of messages. Call Unsubscribe when done.
func (b *Bus) Subscribe() chan WSMessage {
	ch := make(chan WSMessage, b.bufSize)
	b.mu.Lock()
	b.subs[ch] = struct{}{}
	b.mu.Unlock()
	return ch
}

// Unsubscribe removes a subscriber and closes its channel.
func (b *Bus) Unsubscribe(ch chan WSMessage) {
	b.mu.Lock()
	if _, ok := b.subs[ch]; ok {
		delete(b.subs, ch)
		close(ch)
	}
	b.mu.Unlock()
}

// OverflowCount reports how many times a subscriber was dropped for lag.
// Useful for tests and diagnostics.
func (b *Bus) OverflowCount() uint64 {
	return b.overflow.Load()
}

// Publish sends a message to all subscribers (non-blocking).
// A full subscriber is closed and removed so it cannot appear healthy after a hole.
func (b *Bus) Publish(msg WSMessage) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for ch := range b.subs {
		select {
		case ch <- msg:
		default:
			// Slow client: drop the subscriber rather than drop the message silently.
			// Closing the channel makes the hole observable (WS disconnect → reconnect).
			delete(b.subs, ch)
			close(ch)
			b.overflow.Add(1)
		}
	}
}

// PublishTask broadcasts a task_update.
func (b *Bus) PublishTask(t store.Task) {
	b.Publish(WSMessage{Kind: "task_update", Data: t})
}

// PublishTaskDeleted broadcasts that a task row was permanently removed.
func (b *Bus) PublishTaskDeleted(id string) {
	b.Publish(WSMessage{Kind: "task_deleted", Data: map[string]string{"id": id}})
}

// PublishEvent broadcasts an event envelope with task_id.
func (b *Bus) PublishEvent(e store.Event) {
	b.Publish(WSMessage{Kind: "event", Data: e})
}

// PublishApproval broadcasts an approval_update.
func (b *Bus) PublishApproval(a store.Approval) {
	b.Publish(WSMessage{Kind: "approval_update", Data: a})
}

// Marshal is a helper for tests.
func Marshal(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}
