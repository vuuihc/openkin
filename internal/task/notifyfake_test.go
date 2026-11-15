package task

// KIN-NOTIFY-001: the notification seam shared by the task hooks.

import (
	"sync"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/notify"
	"github.com/vuuihc/openkin/internal/store"
)

// notifyRecorder captures what the desktop channel would have received.
//
// The task hooks publish through notify.Sender, which detaches delivery into a
// goroutine, so a test must wait for the event rather than read it right after
// the status settles.
type notifyRecorder struct {
	mu     sync.Mutex
	events []notify.Event
}

func (r *notifyRecorder) PublishNotify(ev notify.Event) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, ev)
}

func (r *notifyRecorder) snapshot() []notify.Event {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]notify.Event(nil), r.events...)
}

func (r *notifyRecorder) waitFor(t *testing.T, n int) []notify.Event {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if got := r.snapshot(); len(got) >= n {
			return got
		}
		time.Sleep(20 * time.Millisecond)
	}
	got := r.snapshot()
	t.Fatalf("timed out waiting for %d notification(s), got %d", n, len(got))
	return nil
}

// testSender builds the desktop-only sender these hook tests need: no devices
// and no APNs credentials, which is exactly a node whose phone has not been set
// up yet.
func testSender(st *store.Store, rec *notifyRecorder) *notify.Sender {
	return &notify.Sender{Store: st, Events: rec}
}
