package node

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/vuuihc/openkin/internal/notify"
	"github.com/vuuihc/openkin/internal/remote/worker"
)

type recordingSender struct {
	mu     sync.Mutex
	frames []worker.Frame
	err    error
}

func (s *recordingSender) Write(ctx context.Context, frame worker.Frame) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil {
		return s.err
	}
	s.frames = append(s.frames, frame)
	return nil
}

func (s *recordingSender) written() []worker.Frame {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]worker.Frame(nil), s.frames...)
}

// blockOnWrite stalls in Write without honouring ctx, so a test can prove that
// a socket stuck mid-write cannot block the queue, SetSender, HandleAck, or the
// read loop. The test releases it in the end.
type blockOnWrite struct {
	started chan struct{}
	release chan struct{}
	once    sync.Once
	mu      sync.Mutex
	writes  int
}

// transientFailureSender models a healthy connection whose first write lost a
// race for the WebSocket's internal write lock. The same sender succeeds on the
// next attempt without a reconnect.
type transientFailureSender struct {
	mu     sync.Mutex
	calls  int
	frames []worker.Frame
}

func (s *transientFailureSender) Write(_ context.Context, frame worker.Frame) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	if s.calls == 1 {
		return errors.New("temporary write timeout")
	}
	s.frames = append(s.frames, frame)
	return nil
}

func (s *transientFailureSender) attempted() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls
}

func (s *transientFailureSender) written() []worker.Frame {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]worker.Frame(nil), s.frames...)
}

func newBlockOnWrite() *blockOnWrite {
	return &blockOnWrite{started: make(chan struct{}, 1), release: make(chan struct{})}
}

func (b *blockOnWrite) Write(context.Context, worker.Frame) error {
	b.mu.Lock()
	b.writes++
	b.mu.Unlock()
	b.once.Do(func() { b.started <- struct{}{} })
	<-b.release
	return nil
}

func (b *blockOnWrite) count() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.writes
}

func decodeRoutineNotify(t *testing.T, frame worker.Frame) worker.RoutineNotify {
	t.Helper()
	msg, err := Decode[worker.RoutineNotify](frame)
	if err != nil {
		t.Fatalf("decode routine.notify: %v", err)
	}
	return msg
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func waitWritten(t *testing.T, s *recordingSender, n int) []worker.Frame {
	t.Helper()
	waitFor(t, "frames to be written", func() bool { return len(s.written()) >= n })
	return s.written()
}

func TestRoutineNotifyForwarderRetriesUnacknowledgedOnSameConnection(t *testing.T) {
	f := newRoutineNotifyForwarder(nil, 20*time.Millisecond)
	defer f.Close()
	f.SetSupported(true)
	sender := &recordingSender{}
	f.SetSender(sender.Write)
	if err := f.Send(context.Background(), notify.RoutineEvent{Event: "report", TaskID: "task-1"}); err != nil {
		t.Fatal(err)
	}
	// The Hub did not acknowledge the first write (for example, while its
	// dispatch slots were full). The same live connection must retry it.
	writes := waitWritten(t, sender, 2)
	if decodeRoutineNotify(t, writes[0]).EventID != decodeRoutineNotify(t, writes[1]).EventID {
		t.Fatal("retry changed event identity")
	}
	ack, _ := worker.NewFrame("routine.notify.ack", worker.RoutineNotifyAck{EventID: "report:task-1"})
	f.HandleAck(ack)
	time.Sleep(60 * time.Millisecond)
	count := len(sender.written())
	time.Sleep(60 * time.Millisecond)
	if len(sender.written()) != count {
		t.Fatal("acknowledged item kept retrying")
	}
}

func TestRoutineNotifyForwarderRetriesTransientWriteErrorOnSameConnection(t *testing.T) {
	f := newRoutineNotifyForwarder(nil, 20*time.Millisecond)
	defer f.Close()
	f.SetSupported(true)
	sender := &transientFailureSender{}
	f.SetSender(sender.Write)
	if err := f.Send(context.Background(), notify.RoutineEvent{
		Event: "report", TaskID: "task-1", Title: "report",
	}); err != nil {
		t.Fatal(err)
	}

	waitFor(t, "the same sender to retry after a write error", func() bool {
		return sender.attempted() >= 2
	})
	frames := sender.written()
	if len(frames) != 1 {
		t.Fatalf("successful writes = %d, want 1", len(frames))
	}
	msg := decodeRoutineNotify(t, frames[0])
	ack, err := worker.NewFrame("routine.notify.ack", worker.RoutineNotifyAck{EventID: msg.EventID})
	if err != nil {
		t.Fatal(err)
	}
	f.HandleAck(ack)
}

func TestRoutineNotifyForwarderQueuesWhileDisconnected(t *testing.T) {
	f := NewRoutineNotifyForwarder(nil)
	defer f.Close()
	f.SetSupported(true)

	if err := f.Send(context.Background(), notify.RoutineEvent{
		Event: "report", TaskID: "task-1", Title: "Routine report", Body: "body",
	}); err != nil {
		t.Fatal(err)
	}

	sender := &recordingSender{}
	f.SetSender(sender.Write)
	got := waitWritten(t, sender, 1)
	msg := decodeRoutineNotify(t, got[0])
	if msg.EventID != "report:task-1" || msg.TaskID != "task-1" {
		t.Fatalf("message = %+v", msg)
	}
}

func TestRoutineNotifyForwarderQueuesBeforeHandshake(t *testing.T) {
	f := NewRoutineNotifyForwarder(nil)
	defer f.Close()
	// Nothing knows the capability yet: a report fired before the first
	// hello_ack must be held, not dropped.
	if err := f.Send(context.Background(), notify.RoutineEvent{
		Event: "report", TaskID: "task-1",
	}); err != nil {
		t.Fatal(err)
	}

	// Even with a live connection, an unsupported Hub receives zero
	// routine.notify frames — an old Hub would close the socket on one.
	sender := &recordingSender{}
	f.SetSender(sender.Write)
	time.Sleep(20 * time.Millisecond)
	if got := sender.written(); len(got) != 0 {
		t.Fatalf("an unsupported Hub was sent %d frames", len(got))
	}

	// A later supported handshake flushes what was queued.
	f.SetSupported(true)
	got := waitWritten(t, sender, 1)
	if decodeRoutineNotify(t, got[0]).TaskID != "task-1" {
		t.Fatalf("queued report = %+v", decodeRoutineNotify(t, got[0]))
	}
}

func TestRoutineNotifyForwarderSurvivesUnsupportedThenUpgradeReconnect(t *testing.T) {
	f := NewRoutineNotifyForwarder(nil)
	defer f.Close()
	if err := f.Send(context.Background(), notify.RoutineEvent{Event: "report", TaskID: "task-1", Title: "Routine report"}); err != nil {
		t.Fatal(err)
	}

	// First connection: old Hub, unsupported.
	f.SetSender((&recordingSender{}).Write)
	time.Sleep(20 * time.Millisecond)
	// Connection ends; a newer Hub announces support.
	f.SetSender(nil)
	supported := &recordingSender{}
	f.SetSupported(true)
	f.SetSender(supported.Write)
	got := waitWritten(t, supported, 1)
	if len(got) != 1 {
		t.Fatalf("after upgrade wrote %d frames", len(got))
	}
}

func TestRoutineNotifyForwarderAckRemovesTheItem(t *testing.T) {
	f := NewRoutineNotifyForwarder(nil)
	defer f.Close()
	f.SetSupported(true)
	if err := f.Send(context.Background(), notify.RoutineEvent{
		Event: "report", TaskID: "task-1", Title: "Routine report",
	}); err != nil {
		t.Fatal(err)
	}
	sender := &recordingSender{}
	f.SetSender(sender.Write)
	waitWritten(t, sender, 1)

	ack, err := worker.NewFrame("routine.notify.ack", worker.RoutineNotifyAck{EventID: "report:task-1"})
	if err != nil {
		t.Fatal(err)
	}
	f.HandleAck(ack)

	// A reconnect after the ack replays nothing.
	sender2 := &recordingSender{}
	f.SetSender(nil)
	f.SetSender(sender2.Write)
	time.Sleep(30 * time.Millisecond)
	if got := sender2.written(); len(got) != 0 {
		t.Fatalf("an acked item was replayed: %d frames", len(got))
	}
}

func TestRoutineNotifyForwarderReplaysOnReconnect(t *testing.T) {
	f := NewRoutineNotifyForwarder(nil)
	defer f.Close()
	f.SetSupported(true)
	if err := f.Send(context.Background(), notify.RoutineEvent{
		Event: "report", TaskID: "task-1", Title: "Routine report",
	}); err != nil {
		t.Fatal(err)
	}
	// The first connection cannot take the write.
	dead := &recordingSender{err: errors.New("socket gone")}
	f.SetSender(dead.Write)
	// The replacement is installed before or after the failed write completes;
	// either way the report must land on the live connection exactly once.
	live := &recordingSender{}
	f.SetSender(live.Write)

	got := waitWritten(t, live, 1)
	time.Sleep(20 * time.Millisecond)
	if len(got) != 1 {
		t.Fatalf("expected one replayed frame, got %d", len(got))
	}
}

func TestRoutineNotifyForwarderDedupesByEventIdentity(t *testing.T) {
	f := NewRoutineNotifyForwarder(nil)
	defer f.Close()
	f.SetSupported(true)
	report := notify.RoutineEvent{Event: "report", TaskID: "task-1", Title: "Routine report"}
	if err := f.Send(context.Background(), report); err != nil {
		t.Fatal(err)
	}
	if err := f.Send(context.Background(), report); err != nil {
		t.Fatal(err)
	}
	sender := &recordingSender{}
	f.SetSender(sender.Write)
	got := waitWritten(t, sender, 1)
	time.Sleep(20 * time.Millisecond)
	if len(got) != 1 {
		t.Fatalf("a repeated report was queued twice: %d frames", len(got))
	}
}

func TestRoutineNotifyForwarderSaturationDropsTheOldest(t *testing.T) {
	f := NewRoutineNotifyForwarder(nil)
	defer f.Close()
	f.SetSupported(true)
	// No sender yet, so everything queues.
	for i := 0; i < routineNotifyMaxItems+2; i++ {
		event := notify.RoutineEvent{Event: "report", TaskID: "task-" + strconv.Itoa(i)}
		if err := f.Send(context.Background(), event); err != nil {
			t.Fatal(err)
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.pending) != routineNotifyMaxItems {
		t.Fatalf("queue = %d items, want %d", len(f.pending), routineNotifyMaxItems)
	}
	first := decodeRoutineNotify(t, f.pending[0].frame)
	if first.TaskID == "task-0" {
		t.Fatal("the oldest report was not dropped")
	}
	last := decodeRoutineNotify(t, f.pending[len(f.pending)-1].frame)
	if last.TaskID != "task-"+strconv.Itoa(routineNotifyMaxItems+1) {
		t.Fatalf("the newest report = %q, want the final event", last.TaskID)
	}
}

func TestRoutineNotifyForwarderRejectsMalformedEvents(t *testing.T) {
	f := NewRoutineNotifyForwarder(nil)
	defer f.Close()
	f.SetSupported(true)
	if err := f.Send(context.Background(), notify.RoutineEvent{Event: "banner"}); err == nil {
		t.Fatal("an unknown event was accepted")
	}
	if err := f.Send(context.Background(), notify.RoutineEvent{Event: "report"}); err == nil {
		t.Fatal("a report without a task was accepted")
	}
}

// TestRoutineNotifyForwarderTruncatesLongText proves a legal-but-long title and
// body reach the Hub as valid UTF-8 within the wire bounds instead of being
// silently dropped. The strings are multibyte so a byte-only cut would split a
// rune and fail JSON encoding.
func TestRoutineNotifyForwarderTruncatesLongText(t *testing.T) {
	f := NewRoutineNotifyForwarder(nil)
	defer f.Close()
	f.SetSupported(true)
	longTitle := strings.Repeat("报", worker.MaxRoutineNotifyTitle+10)
	longBody := strings.Repeat("告", worker.MaxRoutineNotifyBody+10)
	if err := f.Send(context.Background(), notify.RoutineEvent{
		Event: "report", TaskID: "task-1", Title: longTitle, Body: longBody,
	}); err != nil {
		t.Fatal(err)
	}
	sender := &recordingSender{}
	f.SetSender(sender.Write)
	got := waitWritten(t, sender, 1)
	msg := decodeRoutineNotify(t, got[0])
	if len(msg.Title) > worker.MaxRoutineNotifyTitle {
		t.Fatalf("title bytes = %d, over %d", len(msg.Title), worker.MaxRoutineNotifyTitle)
	}
	if len(msg.Body) > worker.MaxRoutineNotifyBody {
		t.Fatalf("body bytes = %d, over %d", len(msg.Body), worker.MaxRoutineNotifyBody)
	}
	if !utf8.ValidString(msg.Title) || !utf8.ValidString(msg.Body) {
		t.Fatalf("truncated text is not valid UTF-8")
	}
	if !strings.HasPrefix(longTitle, msg.Title) || !strings.HasPrefix(longBody, msg.Body) {
		t.Fatalf("truncation does not round to a rune boundary correctly")
	}
}

// TestRoutineNotifyForwarderWriteDoesNotBlockTheQueue proves the sender's mutex
// is never held across a write: while one write is stuck (ignoring its context),
// enqueue, SetSender(nil), HandleAck and the read-loop callers all return.
func TestRoutineNotifyForwarderWriteDoesNotBlockTheQueue(t *testing.T) {
	f := NewRoutineNotifyForwarder(nil)
	defer f.Close()
	f.SetSupported(true)

	blocked := newBlockOnWrite()
	f.SetSender(blocked.Write)
	if err := f.Send(context.Background(), notify.RoutineEvent{Event: "report", TaskID: "task-1", Title: "stuck"}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-blocked.started:
	case <-time.After(time.Second):
		t.Fatal("the sender did not start the write")
	}

	done := make(chan error, 1)
	go func() {
		done <- f.Send(context.Background(), notify.RoutineEvent{Event: "report", TaskID: "task-2", Title: "queued"})
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Send blocked behind a stuck write")
	}

	// SetSender and HandleAck must not block either.
	setDone := make(chan struct{})
	go func() { f.SetSender(nil); close(setDone) }()
	select {
	case <-setDone:
	case <-time.After(time.Second):
		t.Fatal("SetSender blocked behind a stuck write")
	}

	ack, _ := worker.NewFrame("routine.notify.ack", worker.RoutineNotifyAck{EventID: "report:task-1"})
	ackDone := make(chan struct{})
	go func() { f.HandleAck(ack); close(ackDone) }()
	select {
	case <-ackDone:
	case <-time.After(time.Second):
		t.Fatal("HandleAck blocked behind a stuck write")
	}

	close(blocked.release)
}

// TestRoutineNotifyForwarder replaces a stale in-flight write: a frame that was
// still being written when SetSender swapped the connection must not be marked
// sent, so the replacement replays it.
func TestRoutineNotifyForwarderStaleInFlightWriteIsReplayed(t *testing.T) {
	f := NewRoutineNotifyForwarder(nil)
	defer f.Close()
	f.SetSupported(true)

	blocked := newBlockOnWrite()
	f.SetSender(blocked.Write)
	if err := f.Send(context.Background(), notify.RoutineEvent{Event: "report", TaskID: "task-1", Title: "stuck"}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-blocked.started:
	case <-time.After(time.Second):
		t.Fatal("the sender did not start the write")
	}

	// Replace the connection while the write is still stuck.
	live := &recordingSender{}
	f.SetSender(live.Write)
	close(blocked.release)

	// The item was unsent on the dead connection and must be written on the new
	// one even though the old write eventually "succeeded" after the swap.
	waitWritten(t, live, 1)
	if got := live.written(); len(got) != 1 {
		t.Fatalf("replayed frames = %d, want 1", len(got))
	}
}
