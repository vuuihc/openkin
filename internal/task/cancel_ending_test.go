package task

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/store"
)

// parkedNotifier records every terminal push and parks on the first one, so a test
// can look at the engine while a cancel is between its status write and whatever
// it does next. That is the only externally reachable window in this file: the
// engine calls the notifier after the write and outside `e.mu`, which is exactly
// where the two halves of an ending used to be separable.
//
// Parking holds the cancel goroutine, and the cancel holds the engine's retry
// lock for its whole length, so the test registers `releaseAll` with t.Cleanup:
// a failure that returns before the probe can complete still lets the goroutine
// go. The `ctx.Done()` case below is the notifier's own escape for a caller that
// passes a cancellable context; the engine passes the caller's context, which in
// this file is Background, so it is the cleanup that does the releasing here.
type parkedNotifier struct {
	mu       sync.Mutex
	statuses []string
	reached  chan struct{}
	release  chan struct{}
	once     sync.Once
}

func newParkedNotifier() *parkedNotifier {
	return &parkedNotifier{reached: make(chan struct{}), release: make(chan struct{})}
}

func (n *parkedNotifier) NotifyApproval(context.Context, string, string, string) {}

func (n *parkedNotifier) NotifyTaskTerminal(ctx context.Context, _, _ string, status string) {
	n.mu.Lock()
	n.statuses = append(n.statuses, status)
	first := len(n.statuses) == 1
	n.mu.Unlock()
	if !first {
		return
	}
	close(n.reached)
	select {
	case <-n.release:
	case <-ctx.Done():
	}
}

// releaseAll unparks the notifier. Idempotent, so a test can release it at the
// point it means to and t.Cleanup can still promise the goroutine ends.
func (n *parkedNotifier) releaseAll() {
	n.once.Do(func() { close(n.release) })
}

func (n *parkedNotifier) announced() []string {
	n.mu.Lock()
	defer n.mu.Unlock()
	return append([]string(nil), n.statuses...)
}

// A task ends once, and "the user is told it ended" is part of ending. Two writers
// can race to end one task: the cancel the user asked for, and the run that was
// already finishing when they asked. The gate between them is the task's
// active-run entry, and it only works if the cancel's status write and the
// retirement of that entry are one critical section.
//
// Split them -- write the status, then retire the entry -- and a delivery already
// on its way to `finishRun` reads a gate that no longer describes reality: it sees
// a run that is still current, writes the terminal status a second time, and pushes
// a second "your task ended" notification for one task. The window is the
// microseconds between the store's commit and a `delete`, which is why this test
// widens it from outside with the notifier instead of trying to hit it.
//
// Both branches of `cancelTask` that end a task which was never handed to an
// adapter are covered: no handle yet, and still in the start queue. The running
// branch already retires the entry inside its own critical section, which is the
// shape the other two now share.
func TestACancelAndTheRunItRefusedCannotBothEndTheTask(t *testing.T) {
	const placedExecution = "exec-placed-by-the-test"

	cases := []struct {
		name string
		// max is the engine's concurrency, which is what decides whether the
		// created task starts or waits in the queue.
		max int
		// branch names the branch of `cancelTask` the arranged state reaches, so a
		// test that quietly stopped driving it fails loudly.
		branch string
		// arrange brings the engine to the state that branch exists for, and
		// returns the task id and the execution id the delivery will name.
		arrange func(t *testing.T, ctx context.Context, e *Engine, st *store.Store) (string, string)
	}{
		{
			// The real path: pump has claimed the task and set its active-run
			// entry, and startOne is inside Adapter.Start, so no handle exists yet.
			name:   "no handle yet",
			max:    4,
			branch: "no handle",
			arrange: func(t *testing.T, ctx context.Context, e *Engine, _ *store.Store) (string, string) {
				t.Helper()
				task, err := e.Create(ctx, CreateRequest{
					Agent: "claude-code", Cwd: "/tmp", Prompt: "start",
				})
				if err != nil {
					t.Fatal(err)
				}
				deadline := time.Now().Add(3 * time.Second)
				for time.Now().Before(deadline) {
					e.mu.Lock()
					execID := e.activeRuns[task.ID]
					_, hasHandle := e.handles[task.ID]
					e.mu.Unlock()
					if execID != "" && !hasHandle {
						return task.ID, execID
					}
					time.Sleep(time.Millisecond)
				}
				t.Fatal("the task never reached the claimed-but-unstarted state, so this test is not driving the branch it names")
				return "", ""
			},
		},
		{
			// Placed rather than produced: a task reaches the start queue with a
			// live active-run entry only if something re-queued it after pump
			// claimed it, which no path in the engine does today. Both halves of
			// that state are therefore written by hand, and no runner is started,
			// so nothing else in the engine can move under the probe. The branch
			// still gets a case, because it is the other caller of the function
			// this test is about.
			name:   "still in the start queue",
			max:    1,
			branch: "in queue",
			arrange: func(t *testing.T, ctx context.Context, e *Engine, st *store.Store) (string, string) {
				t.Helper()
				id, err := e.newID()
				if err != nil {
					t.Fatal(err)
				}
				if err := st.InsertTask(ctx, store.Task{
					ID: id, Title: "queued", Agent: "claude-code", Cwd: "/tmp",
					Prompt: "p", Status: StatusQueued, CreatedAt: time.Now().UnixMilli(),
				}); err != nil {
					t.Fatal(err)
				}
				e.mu.Lock()
				e.queue = append(e.queue, id)
				e.activeRuns[id] = placedExecution
				e.mu.Unlock()
				return id, placedExecution
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			notifier := newParkedNotifier()
			// A start that never returns is what holds the task in the state these
			// branches exist for. Closing the gate, or the engine's context in
			// cleanup, is what lets that goroutine go.
			gate := make(chan struct{})
			t.Cleanup(func() { close(gate) })
			ad := &fakeAdapter{events: liveRunEvents(), runFor: 30 * time.Second, gate: gate}
			e, st := testEngine(t, tc.max, ad)
			e.SetNotifier(notifier)
			t.Cleanup(notifier.releaseAll)

			taskID, execID := tc.arrange(t, ctx, e, st)

			e.mu.Lock()
			inQueue := false
			for _, qid := range e.queue {
				inQueue = inQueue || qid == taskID
			}
			_, hasHandle := e.handles[taskID]
			e.mu.Unlock()
			switch tc.branch {
			case "in queue":
				if !inQueue {
					t.Fatal("the task left the start queue, so this test is not driving the branch it names")
				}
			case "no handle":
				if hasHandle {
					t.Fatal("the task already has a handle, so this test is not driving the branch it names")
				}
			}

			canceled := make(chan error, 1)
			go func() {
				_, err := e.Cancel(ctx, taskID)
				canceled <- err
			}()

			select {
			case <-notifier.reached:
			case <-time.After(5 * time.Second):
				t.Fatal("the cancel never announced the ending, so there is no window to probe")
			}

			// The delivery, arriving while the cancel is parked in its own
			// announcement. Before the fix this is the moment the active-run entry
			// was still set, so the gate let the write through.
			_, deliverErr := e.finishRun(ctx, taskID, execID, StatusSucceeded, nil, nil)

			notifier.releaseAll()
			if err := <-canceled; err != nil {
				t.Fatalf("cancel: %v", err)
			}

			if !errors.Is(deliverErr, store.ErrConflict) {
				t.Fatalf("a delivery for a task the cancel had already ended = %v, want store.ErrConflict", deliverErr)
			}
			if got := notifier.announced(); len(got) != 1 || got[0] != StatusCanceled {
				t.Fatalf("the user was told the task ended %d time(s) %v, want exactly one %s",
					len(got), got, StatusCanceled)
			}
			final, err := e.Get(ctx, taskID)
			if err != nil {
				t.Fatal(err)
			}
			if final.Status != StatusCanceled {
				t.Fatalf("final status = %s, want the cancel to stand", final.Status)
			}
			if final.FinishedAt == nil || *final.FinishedAt == 0 {
				t.Fatal("the canceled task has no finish time, so something ended it without recording when")
			}
		})
	}
}

// The error half of the same critical section: a cancel whose write does not land
// must leave the run entry where it found it.
//
// The delete belongs to the write and not to the attempt. Doing it regardless --
// retiring the entry under the lock without looking at the store's answer -- takes
// the gate away from a run that is still going: the delivery that ends that run
// reads the map, finds nothing, and refuses the write as store.ErrConflict for a
// task it is the only one ending. The row would then sit non-terminal with no
// runner, which is a worse failure than the double-ending this function exists to
// prevent. The same holds for the message label: consuming it on a cancel that did
// not land loses the sentence a later, successful cancel owes the reader.
//
// A canceled context is the way to make the store write fail without a fault
// injection seam -- `BeginTx` refuses before any statement runs -- and it cannot be
// produced through `Engine.Cancel`, whose first act is a read on the same context.
// So the function is called directly, against the placed state the table above uses
// for this branch.
func TestACancelThatCannotWriteLeavesTheRunEntryAndTheLabelAlone(t *testing.T) {
	ctx := context.Background()
	e, st := testEngine(t, 1, &fakeAdapter{events: liveRunEvents(), runFor: 30 * time.Second})

	id, err := e.newID()
	if err != nil {
		t.Fatal(err)
	}
	if err := st.InsertTask(ctx, store.Task{
		ID: id, Title: "queued", Agent: "claude-code", Cwd: "/tmp",
		Prompt: "p", Status: StatusQueued, CreatedAt: time.Now().UnixMilli(),
	}); err != nil {
		t.Fatal(err)
	}
	const placedExecution = "exec-placed-by-the-test"
	const message = "the message no run has been handed"
	e.mu.Lock()
	e.queue = append(e.queue, id)
	e.activeRuns[id] = placedExecution
	e.queuedMessage[id] = message
	e.mu.Unlock()

	dead, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := e.cancelUnstarted(dead, id); err == nil {
		t.Fatal("a cancel whose store write failed reported success")
	}

	e.mu.Lock()
	execID := e.activeRuns[id]
	label := e.queuedMessage[id]
	e.mu.Unlock()
	if execID != placedExecution {
		t.Fatalf("active run after a failed cancel = %q, want %q: the entry is the gate the run's own "+
			"delivery checks, so retiring it here would make that delivery refuse to end its own task",
			execID, placedExecution)
	}
	if label != message {
		t.Fatalf("queued message label after a failed cancel = %q, want %q: the cancel did not happen, "+
			"so the message it would have reported as lost is still owed", label, message)
	}
	task, err := st.GetTask(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if task.Status != StatusQueued {
		t.Fatalf("status after a failed cancel = %s, want %s", task.Status, StatusQueued)
	}
}

// A follow-up that was delivered and then canceled before its turn started is a
// message the user can see that nothing will answer, and the transcript has to say
// so.
//
// The delivery is what makes this ordering invisible: it takes the message off the
// queue (`PopPendingPrompt`) and writes it into the task row as the next turn's
// prompt, so when the cancel lands the message is no longer in the pending table
// the cancel reports from -- and `startOne` never sees a queued row, so it says
// nothing either. The message is left in the chat with a canceled task above it and
// no event explaining why.
//
// The delivery here is the turn-boundary call itself, not a stand-in for it: the
// run loop's boundary reaches `applyFollowUp` through `deliverQueuedPrompt`, and an
// interrupted turn's apply and a restart's catch-up reach it through
// `applyFollowUpPrepared` -- either way the same function, which is where the message
// a queued run owes is remembered.
func TestACancelOfADeliveredFollowUpSaysTheMessageWentUnanswered(t *testing.T) {
	ctx := context.Background()
	// One slot, held by a first turn that stays open: the follow-up is delivered
	// into a task that cannot start it yet, which is the window under test.
	ad := &fakeAdapter{
		events: []adapter.Event{
			{Type: "task_started", Payload: json.RawMessage(`{"session_id":"s1","subtype":"init"}`)},
		},
		runFor: 30 * time.Second,
	}
	e, st := testEngine(t, 1, ad)

	task, err := e.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: "/tmp", Prompt: "start"})
	if err != nil {
		t.Fatal(err)
	}
	waitStatus(t, e, task.ID, StatusRunning, 2*time.Second)

	const message = "also check the logs"
	if _, err := e.FollowUp(ctx, task.ID, message); err != nil {
		t.Fatalf("a prompt sent to a busy task should be accepted: %v", err)
	}

	// The boundary's delivery: what runLoop does when the turn it was waiting on
	// ends. It consumes the queue row and makes the message the next turn's prompt.
	if _, ok, err := e.deliverQueuedPrompt(ctx, task.ID); err != nil || !ok {
		t.Fatalf("delivering the queued message = (ok=%v, err=%v), want it delivered", ok, err)
	}
	if queued, err := st.ListPendingPrompts(ctx, task.ID); err != nil || len(queued) != 0 {
		t.Fatalf("queue after the delivery = %+v (err=%v), want the row consumed", queued, err)
	}
	delivered, err := st.GetTask(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if delivered.Status != StatusQueued {
		t.Fatalf("status after the delivery = %s, want %s: the run is waiting for the slot",
			delivered.Status, StatusQueued)
	}

	if _, err := e.Cancel(ctx, task.ID); err != nil {
		t.Fatalf("cancel: %v", err)
	}

	// The message is exactly where the user left it, and the one event that
	// explains why it is still unanswered names it.
	if n := userEventsNaming(t, st, task.ID, message); n != 1 {
		t.Fatalf("the transcript holds %d copies of the message, want the one the user sent", n)
	}
	if n := reportsNaming(t, st, task.ID, 0, message); n != 1 {
		t.Fatalf("error events naming the undelivered message = %d, want 1: "+
			"a follow-up the cancel ended before its turn started is otherwise silent", n)
	}
	final, err := e.Get(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if final.Status != StatusCanceled {
		t.Fatalf("final status = %s, want %s", final.Status, StatusCanceled)
	}
}

// The other half of the same rule: a cancel of the turn that *did* take the
// message is not a lost message, and says nothing about one.
//
// Written against the same delivery, with a slot free so the run starts before the
// cancel arrives -- the registration of the run's handle is where the message stops
// being owed by a queue entry and becomes a turn's work.
func TestACancelOfTheTurnThatTookTheFollowUpSaysNothing(t *testing.T) {
	ctx := context.Background()
	ad := &fakeAdapter{
		events: []adapter.Event{
			{Type: "task_started", Payload: json.RawMessage(`{"session_id":"s1","subtype":"init"}`)},
		},
		runFor: 30 * time.Second,
	}
	e, st := testEngine(t, 4, ad)

	task, err := e.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: "/tmp", Prompt: "start"})
	if err != nil {
		t.Fatal(err)
	}
	waitHandle(t, e, task.ID, 2*time.Second)

	const message = "and the logs"
	if _, err := e.FollowUp(ctx, task.ID, message); err != nil {
		t.Fatalf("a prompt sent to a busy task should be accepted: %v", err)
	}
	if _, ok, err := e.deliverQueuedPrompt(ctx, task.ID); err != nil || !ok {
		t.Fatalf("delivering the queued message = (ok=%v, err=%v), want it delivered", ok, err)
	}
	// The second run takes the free slot and is handed the prompt.
	waitStatus(t, e, task.ID, StatusRunning, 2*time.Second)
	waitHandle(t, e, task.ID, 2*time.Second)

	if _, err := e.Cancel(ctx, task.ID); err != nil {
		if !errors.Is(err, ErrTerminal) {
			t.Fatalf("cancel: %v", err)
		}
	}
	if n := reportsNaming(t, st, task.ID, 0, message); n != 0 {
		t.Fatalf("error events naming the message = %d, want 0: the turn that was canceled had it", n)
	}
}

// heldDeliveryWriter holds a delivery's own user-guide write open. It gates on the
// plain follow-up source, so the write an interrupt makes (source "interrupt")
// passes through -- heldGuideWriter in approvals_test.go is the one that holds that
// one.
type heldDeliveryWriter struct {
	inner   eventWriter
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (w *heldDeliveryWriter) AppendEvent(ctx context.Context, taskID, typ string, payload json.RawMessage) (store.Event, error) {
	if typ == "message" && bytes.Contains(payload, []byte(`"source":"follow_up"`)) {
		w.once.Do(func() {
			close(w.entered)
			<-w.release
		})
	}
	return w.inner.AppendEvent(ctx, taskID, typ, payload)
}

func (w *heldDeliveryWriter) AppendUsageEvent(ctx context.Context, taskID, typ string, payload json.RawMessage, record store.UsageRecord) (store.Event, store.Task, error) {
	return w.inner.AppendUsageEvent(ctx, taskID, typ, payload, record)
}

// The gap between a delivery's two statements is a state a cancel can see, and the
// delivery is the side that has to answer for it.
//
// `applyFollowUp` writes the row first -- that write is what the queued-to-running
// claim and `startOne` read -- and installs the queue entry and the message label
// after it, in a critical section of its own. A cancel that lands in between finds
// no queue entry under `e.mu`, so it reaches `cancelUnstarted` with no label to read
// and says nothing; it has to, because at the instant it looked nothing had claimed
// the message would be answered. The delivery is then the only side left that knows
// the message exists, and this test drives exactly that interleaving: the delivery's
// own user-guide write -- the statement between the row write and the critical
// section -- is held open while the task is canceled.
//
// Without the status read inside that critical section the delivery enqueues a
// canceled task, installs a label beside it, and reports success: the message stays
// in the chat under a canceled task with nothing saying why, and the label is left
// behind for a later cancel of the same task to quote as a second loss.
func TestADeliveryThatLosesTheGapToACancelReportsItsMessage(t *testing.T) {
	ctx := context.Background()
	e, st := testEngine(t, 1, &fakeAdapter{events: liveRunEvents(), runFor: 30 * time.Second})
	writer := &heldDeliveryWriter{
		inner:   e.eventWriter(),
		entered: make(chan struct{}),
		release: make(chan struct{}),
	}
	e.setEventWriter(writer)

	id, err := e.newID()
	if err != nil {
		t.Fatal(err)
	}
	// A turn that already ended with one message still on the queue: the shape a
	// turn boundary hands over.
	if err := st.InsertTask(ctx, store.Task{
		ID: id, Title: "boundary", Agent: "claude-code", Cwd: "/tmp",
		Prompt: "start", Status: StatusSucceeded, CreatedAt: time.Now().UnixMilli(),
	}); err != nil {
		t.Fatal(err)
	}
	// UserSeq 0: the message is not in the transcript yet, so the delivery writes it
	// and this writer is the statement the gap is measured from.
	const message = "also check the logs"
	if _, err := st.AppendPendingPrompt(ctx, store.PendingPrompt{TaskID: id, Prompt: message}); err != nil {
		t.Fatal(err)
	}

	type delivery struct {
		ok  bool
		err error
	}
	done := make(chan delivery, 1)
	go func() {
		_, ok, err := e.deliverQueuedPrompt(ctx, id)
		done <- delivery{ok: ok, err: err}
	}()

	<-writer.entered // the row is queued by now; the queue entry is not written yet
	task, err := st.GetTask(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if task.Status != StatusQueued {
		t.Fatalf("row while the delivery is open = %s, want %s: the test is not in the gap",
			task.Status, StatusQueued)
	}
	if _, err := e.Cancel(ctx, id); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	close(writer.release)

	got := <-done
	if got.err == nil {
		t.Fatal("the delivery reported success after a cancel took the task: nothing will answer the message and nothing says so")
	}
	if !got.ok {
		t.Fatal("ok=false says nothing was waiting, but the message was taken off the queue")
	}
	if !strings.Contains(got.err.Error(), "could not be delivered") ||
		!strings.Contains(got.err.Error(), message) {
		t.Fatalf("the delivery failed with %q, want the sentence that names the message", got.err)
	}
	// What every caller does with that error (runLoop's boundary, queuedFollowUp,
	// the two interrupt-apply sites): the sentence goes into the transcript, which is
	// what the sender and every other device reads.
	e.reportUndelivered(ctx, id, got.err)

	if n := userEventsNaming(t, st, id, message); n != 1 {
		t.Fatalf("the transcript holds %d copies of the message, want the one the user sent", n)
	}
	if n := reportsNaming(t, st, id, 0, message); n != 1 {
		t.Fatalf("error events naming the undelivered message = %d, want 1: "+
			"a cancel that wins the gap leaves the delivery holding the only copy of why", n)
	}
	final, err := e.Get(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if final.Status != StatusCanceled {
		t.Fatalf("final status = %s, want %s", final.Status, StatusCanceled)
	}
	e.mu.Lock()
	var queued bool
	for _, qid := range e.queue {
		if qid == id {
			queued = true
		}
	}
	_, labeled := e.queuedMessage[id]
	e.mu.Unlock()
	if queued {
		t.Fatal("a canceled task was left in the start queue")
	}
	if labeled {
		t.Fatal("the refused delivery left a message label behind, for a later cancel of this task to report as a second loss")
	}
}
