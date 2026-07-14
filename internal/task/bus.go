package task

import (
	"encoding/json"
	"sync"

	"github.com/vuuihc/kin/internal/store"
)

// WSMessage is pushed on the global bus (spec §6).
type WSMessage struct {
	Kind string `json:"kind"` // task_update | event
	Data any    `json:"data"`
}

// Bus is an in-process fan-out for WebSocket clients.
type Bus struct {
	mu      sync.Mutex
	subs    map[chan WSMessage]struct{}
	bufSize int
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

// Publish sends a message to all subscribers (non-blocking; drops if full).
func (b *Bus) Publish(msg WSMessage) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for ch := range b.subs {
		select {
		case ch <- msg:
		default:
			// Slow client: drop rather than block the engine.
		}
	}
}

// PublishTask broadcasts a task_update.
func (b *Bus) PublishTask(t store.Task) {
	b.Publish(WSMessage{Kind: "task_update", Data: t})
}

// PublishEvent broadcasts an event envelope with task_id.
func (b *Bus) PublishEvent(e store.Event) {
	b.Publish(WSMessage{Kind: "event", Data: e})
}

// Marshal is a helper for tests.
func Marshal(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}
