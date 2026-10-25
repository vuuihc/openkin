package task

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/store"
)

// parkedNotifier records every terminal push and parks on the first one, so a test
// can look at the engine while a cancel is between its status write and whatever
// it does next. That is the only externally reachable window in this file: the
// engine calls the notifier after the write and outside `e.mu`, which is exactly
// where the two halves of an ending used to be separable.
type parkedNotifier struct {
	mu       sync.Mutex
	statuses []string
	reached  chan struct{}
	release  chan struct{}
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

			close(notifier.release)
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
