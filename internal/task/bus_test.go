package task

import (
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/store"
)

// TestBusOverflowDisconnectsSlowSubscriber is the Milestone 1 red test:
// a slow subscriber must not stay open after the bus has dropped data for it.
func TestBusOverflowDisconnectsSlowSubscriber(t *testing.T) {
	b := NewBus()
	slow := b.Subscribe()
	fast := b.Subscribe()

	// Drain the fast subscriber so it stays healthy while slow fills up.
	fastDone := make(chan struct{})
	go func() {
		defer close(fastDone)
		for range fast {
		}
	}()

	// Publish more than the 64-entry buffer without reading from slow.
	for i := 0; i < 64+8; i++ {
		b.Publish(WSMessage{Kind: "event", Data: map[string]int{"n": i}})
	}

	// Slow subscriber must not remain open after silent data loss: channel closed.
	closed := make(chan struct{})
	go func() {
		for range slow {
		}
		close(closed)
	}()

	select {
	case <-closed:
		// expected once overflow is recoverable
	case <-time.After(200 * time.Millisecond):
		t.Fatal("slow subscriber still open after overflow; expected disconnect so the browser reconnect path can self-heal")
	}
	if b.OverflowCount() < 1 {
		t.Fatal("expected OverflowCount to record the dropped subscriber")
	}

	// Fast subscriber must still receive new publishes (engine must not block / fan-out to healthy clients).
	healthy := b.Subscribe()
	b.Publish(WSMessage{Kind: "task_update", Data: map[string]string{"id": "t1"}})
	select {
	case msg := <-healthy:
		if msg.Kind != "task_update" {
			t.Fatalf("kind=%q", msg.Kind)
		}
	case <-time.After(time.Second):
		t.Fatal("healthy subscriber did not receive publish after overflow")
	}

	b.Unsubscribe(healthy)
	b.Unsubscribe(fast)
	select {
	case <-fastDone:
	case <-time.After(time.Second):
		t.Fatal("fast drain goroutine did not exit after unsubscribe")
	}
}

func TestBusPublishNeverBlocksOnSlowSubscriber(t *testing.T) {
	b := NewBus()
	_ = b.Subscribe() // never read

	done := make(chan struct{})
	go func() {
		for i := 0; i < 1000; i++ {
			b.Publish(WSMessage{Kind: "event", Data: i})
		}
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Publish blocked on slow subscriber")
	}
}

// TestBusKeepsOneAccountOutOfAnothersEvents is the isolation contract at the
// stream: the socket is a delivery path for the same rows the list endpoint
// filters, so a scoped subscriber must not be handed a task it could not have
// fetched. Publish is synchronous, so an absent message is absent by the time
// Publish returns — no sleeping to prove a negative.
func TestBusKeepsOneAccountOutOfAnothersEvents(t *testing.T) {
	owners := map[string]string{"task-a": "user-a", "task-b": "user-b"}
	b := NewBus()
	b.SetOwnerResolver(func(taskID string) string { return owners[taskID] })

	holder := b.Subscribe() // the master token / the account that claimed this Hub
	member := b.SubscribeFor(store.OwnedBy("user-a"))
	if member == nil {
		t.Fatal("a scoped subscription on a bus with an owner resolver must be honoured")
	}

	// Another account's event reaches the machine's holder and nobody else.
	b.PublishEvent(store.Event{TaskID: "task-b"})
	expectNothing(t, member, "a member received another account's event")
	expectOne(t, holder, "the holder missed another account's event")

	// The member's own event reaches both.
	b.PublishEvent(store.Event{TaskID: "task-a"})
	if msg := expectOne(t, holder, "the holder missed the member's event"); msg.TaskID() != "task-a" {
		t.Fatalf("holder got task_id=%q, want task-a", msg.TaskID())
	}
	if msg := expectOne(t, member, "the member missed its own event"); msg.TaskID() != "task-a" {
		t.Fatalf("member got task_id=%q, want task-a", msg.TaskID())
	}
}

// TestBusFiltersTaskUpdatesWithoutALookup covers the one message that carries
// its own owner: a task row arrives whole, so it is filtered from the row and
// never from the database — which matters because by the time a deletion is
// broadcast the row is already gone.
func TestBusFiltersTaskUpdatesWithoutALookup(t *testing.T) {
	lookups := 0
	b := NewBus()
	b.SetOwnerResolver(func(string) string { lookups++; return "" })

	member := b.SubscribeFor(store.OwnedBy("user-a"))
	if member == nil {
		t.Fatal("scoped subscription refused")
	}

	b.PublishTask(store.Task{ID: "task-b", OwnerUserID: "user-b"})
	expectNothing(t, member, "a member received another account's task_update")
	if lookups != 0 {
		t.Fatalf("a task_update carries its owner but triggered %d lookup(s)", lookups)
	}

	b.PublishTask(store.Task{ID: "task-a", OwnerUserID: "user-a"})
	if msg := expectOne(t, member, "the member missed its own task_update"); msg.TaskID() != "task-a" {
		t.Fatalf("member got task_id=%q, want task-a", msg.TaskID())
	}
}

// TestBusRefusesScopedSubscriptionWithoutAResolver pins the fail-closed
// direction: with no way to attribute a message, "I cannot tell whose this is"
// must not decay into "deliver it anyway".
func TestBusRefusesScopedSubscriptionWithoutAResolver(t *testing.T) {
	b := NewBus()
	if ch := b.SubscribeFor(store.OwnedBy("user-a")); ch != nil {
		t.Fatal("a scoped subscription on a resolver-less bus must be refused, not silently unscoped")
	}
	// An empty scope means "nothing", not "everything", so it is not a way through either.
	if ch := b.SubscribeFor(store.TaskScope{}); ch != nil {
		t.Fatal("the zero scope must be refused on a resolver-less bus")
	}
	// Consumers with no account behind them still get the firehose.
	if ch := b.Subscribe(); ch == nil {
		t.Fatal("an unscoped subscription must not need a resolver")
	}
}

// TestBusDropsEventsItCannotAttribute is the other half of fail-closed: once a
// resolver exists but does not know the task, the message belongs to nobody the
// member can be shown, so the member is not shown it.
func TestBusDropsEventsItCannotAttribute(t *testing.T) {
	b := NewBus()
	b.SetOwnerResolver(func(string) string { return "" })

	member := b.SubscribeFor(store.OwnedBy("user-a"))
	if member == nil {
		t.Fatal("scoped subscription refused")
	}
	b.PublishEvent(store.Event{TaskID: "task-orphan"})
	expectNothing(t, member, "an unattributable event reached a scoped member")
}

// expectOne asserts a message is already waiting.
func expectOne(t *testing.T, ch chan WSMessage, msg string) WSMessage {
	t.Helper()
	select {
	case got := <-ch:
		return got
	default:
		t.Fatal(msg)
		return WSMessage{}
	}
}

// expectNothing asserts the channel is empty without blocking.
func expectNothing(t *testing.T, ch chan WSMessage, msg string) {
	t.Helper()
	select {
	case got := <-ch:
		t.Fatalf("%s: %+v", msg, got.Data)
	default:
	}
}

// TestBusDeliversADeletionToTheAccountThatOwnedIt covers the message the bus
// cannot look up. A deletion is published after the row is gone, so the resolver
// answers "" for it — and a scoped subscriber matching on that empty answer is
// the one account that never hears its own task disappeared, while every other
// account is told nothing either. Passing the owner in is what closes it, so the
// resolver here deliberately answers "" for the deleted id to prove the message
// does not depend on it.
func TestBusDeliversADeletionToTheAccountThatOwnedIt(t *testing.T) {
	b := NewBus()
	b.SetOwnerResolver(func(string) string { return "" })

	holder := b.Subscribe()
	member := b.SubscribeFor(store.OwnedBy("user-a"))
	other := b.SubscribeFor(store.OwnedBy("user-b"))
	if member == nil || other == nil {
		t.Fatal("scoped subscription refused")
	}

	b.PublishTaskDeleted("task-a", "user-a")

	if msg := expectOne(t, member, "the owner missed its own task's deletion"); msg.Kind != "task_deleted" {
		t.Fatalf("member got kind=%q, want task_deleted", msg.Kind)
	}
	expectNothing(t, other, "another account was told about the deletion")
	if msg := expectOne(t, holder, "the holder missed the deletion"); msg.Kind != "task_deleted" {
		t.Fatalf("holder got kind=%q, want task_deleted", msg.Kind)
	}
}

// TestBusDoesNotGuessWhenADeletionHasNoOwner pins the fallback that made the
// previous test necessary. An empty owner means "unknown — go and look it up",
// so a deletion published without one is attributed by a lookup. That lookup runs
// after the row is gone and therefore finds nothing, which is exactly why the
// engine passes the owner in: without it, the account that owned the task is the
// one account that is never told it disappeared.
func TestBusDoesNotGuessWhenADeletionHasNoOwner(t *testing.T) {
	lookups := 0
	b := NewBus()
	b.SetOwnerResolver(func(string) string { lookups++; return "" }) // the row is gone

	holder := b.Subscribe()
	member := b.SubscribeFor(store.OwnedBy("user-a"))
	if member == nil {
		t.Fatal("scoped subscription refused")
	}

	b.PublishTaskDeleted("task-orphan", "")

	if lookups == 0 {
		t.Fatal("an owner-less deletion skipped the lookup that is its only source of an owner")
	}
	expectNothing(t, member, "an unattributable deletion reached a scoped member")
	if msg := expectOne(t, holder, "the holder missed the deletion"); msg.Kind != "task_deleted" {
		t.Fatalf("holder got kind=%q, want task_deleted", msg.Kind)
	}
}
