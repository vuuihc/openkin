package task

import (
	"encoding/json"
	"sync"
	"sync/atomic"

	"github.com/vuuihc/openkin/internal/store"
)

// WSMessage is pushed on the global bus (spec §6).
type WSMessage struct {
	Kind string `json:"kind"` // task_update | task_deleted | event | approval_update
	Data any    `json:"data"`
	// OwnerUserID is who the message is about, and is never sent: it exists so a
	// subscriber can decide whether to deliver at all.
	OwnerUserID string `json:"-"`
}

// TaskID names the task this message concerns, or "" when it concerns none.
func (m WSMessage) TaskID() string {
	switch d := m.Data.(type) {
	case store.Task:
		return d.ID
	case store.Event:
		return d.TaskID
	case store.Approval:
		return d.TaskID
	case store.UserQuestion:
		return d.TaskID
	case map[string]string:
		return d["id"]
	}
	return ""
}

// OwnerResolver answers "which account owns this task". The bus needs it for
// every message that carries only a task id; task_update carries the whole row
// and so needs no lookup.
//
// It is set by whatever built the bus. A bus with no resolver delivers
// everything to scoped subscribers, which is the wrong direction, so a scoped
// subscriber on a resolver-less bus is refused at SubscribeFor instead.
type OwnerResolver func(taskID string) string

type subscriber struct {
	ch    chan WSMessage
	scope store.TaskScope
}

// Bus is an in-process fan-out for WebSocket clients.
//
// Publish is non-blocking: a full subscriber is dropped (channel closed) so
// the slow client cannot remain "connected" after losing data. Closing the
// channel causes handleWS to exit and the browser reconnect path to run.
type Bus struct {
	mu       sync.Mutex
	subs     map[*subscriber]struct{}
	scoped   int
	bufSize  int
	overflow atomic.Uint64
	ownerOf  OwnerResolver
}

// NewBus creates a pub/sub bus.
func NewBus() *Bus {
	return &Bus{
		subs:    make(map[*subscriber]struct{}),
		bufSize: 64,
	}
}

// SetOwnerResolver installs the lookup the bus uses to attribute a message that
// names only a task id. Without it, scoped subscriptions cannot be honoured.
func (b *Bus) SetOwnerResolver(fn OwnerResolver) {
	b.mu.Lock()
	b.ownerOf = fn
	b.mu.Unlock()
}

// Subscribe returns a channel of messages. Call Unsubscribe when done.
//
// The subscription is unscoped: it receives every message on this daemon. Use
// it only for consumers with no account behind them, such as the sleep guard.
func (b *Bus) Subscribe() chan WSMessage {
	return b.SubscribeFor(store.Unscoped())
}

// SubscribeFor returns a channel carrying only what the scope allows.
//
// A scoped subscription on a bus with no owner resolver is refused (nil
// channel) rather than silently upgraded to everything: the caller can then
// decide to skip the connection instead of streaming another account's work.
func (b *Bus) SubscribeFor(scope store.TaskScope) chan WSMessage {
	b.mu.Lock()
	defer b.mu.Unlock()
	if !scope.All && b.ownerOf == nil {
		return nil
	}
	sub := &subscriber{ch: make(chan WSMessage, b.bufSize), scope: scope}
	b.subs[sub] = struct{}{}
	if !scope.All {
		b.scoped++
	}
	return sub.ch
}

// Unsubscribe removes a subscriber and closes its channel.
func (b *Bus) Unsubscribe(ch chan WSMessage) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for sub := range b.subs {
		if sub.ch != ch {
			continue
		}
		delete(b.subs, sub)
		if !sub.scope.All {
			b.scoped--
		}
		close(sub.ch)
		return
	}
}

// OverflowCount reports how many times a subscriber was dropped for lag.
// Useful for tests and diagnostics.
func (b *Bus) OverflowCount() uint64 {
	return b.overflow.Load()
}

// Publish sends a message to all subscribers (non-blocking).
// A full subscriber is closed and removed so it cannot appear healthy after a hole.
func (b *Bus) Publish(msg WSMessage) {
	msg = b.attribute(msg)
	b.mu.Lock()
	defer b.mu.Unlock()
	for sub := range b.subs {
		if !sub.scope.MatchesOwner(msg.OwnerUserID) {
			continue
		}
		select {
		case sub.ch <- msg:
		default:
			// Slow client: drop the subscriber rather than drop the message silently.
			// Closing the channel makes the hole observable (WS disconnect → reconnect).
			delete(b.subs, sub)
			if !sub.scope.All {
				b.scoped--
			}
			close(sub.ch)
			b.overflow.Add(1)
		}
	}
}

// attribute fills in the owner for a message that names only a task id, and
// only when some subscriber actually needs to know. The lookup happens outside
// the lock because it may hit the database, and on a daemon whose subscribers
// are all unscoped — a standalone one, or a Hub with a single owner — it does
// not happen at all.
func (b *Bus) attribute(msg WSMessage) WSMessage {
	if msg.OwnerUserID != "" {
		return msg
	}
	if task, ok := msg.Data.(store.Task); ok {
		msg.OwnerUserID = task.OwnerUserID
		return msg
	}
	b.mu.Lock()
	scoped, ownerOf := b.scoped, b.ownerOf
	b.mu.Unlock()
	if scoped == 0 || ownerOf == nil {
		return msg
	}
	if id := msg.TaskID(); id != "" {
		msg.OwnerUserID = ownerOf(id)
	}
	return msg
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

// PublishUserQuestion broadcasts a user_question_update.
func (b *Bus) PublishUserQuestion(q store.UserQuestion) {
	b.Publish(WSMessage{Kind: "user_question_update", Data: q})
}

// Marshal is a helper for tests.
func Marshal(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}
