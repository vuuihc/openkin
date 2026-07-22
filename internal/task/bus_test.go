package task

import (
	"testing"
	"time"
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
