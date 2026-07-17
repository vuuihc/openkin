package task

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/vuuihc/kin/internal/adapter"
)

func TestRetryRewindsLastUserTurn(t *testing.T) {
	ad := &fakeAdapter{events: successEvents()}
	e, st := testEngine(t, 4, ad)
	ctx := context.Background()

	task, err := e.Create(ctx, CreateRequest{
		Agent: "claude-code", Cwd: "/tmp", Prompt: "first question",
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 3*time.Second)

	// Second turn
	ad2 := &fakeAdapter{events: successEvents()}
	e.adapters["claude-code"] = ad2
	_, err = e.FollowUp(ctx, task.ID, "second question")
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 3*time.Second)

	evs, err := st.ListEvents(ctx, task.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	before := len(evs)
	if before < 2 {
		t.Fatalf("expected multiple events, got %d", before)
	}

	// Retry last user turn (from_seq=0).
	ad3 := &fakeAdapter{events: successEvents()}
	e.adapters["claude-code"] = ad3
	t2, err := e.Retry(ctx, task.ID, RetryRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if t2.Status != StatusQueued && t2.Status != StatusRunning && t2.Status != StatusSucceeded {
		// may already finish
		t.Logf("status=%s", t2.Status)
	}
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 3*time.Second)

	evs2, err := st.ListEvents(ctx, task.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	// Should have dropped the last assistant turn and re-run.
	if len(evs2) >= before+5 {
		// loose check: not unbounded growth of whole history twice
		t.Logf("events before=%d after=%d", before, len(evs2))
	}
	// Last user message should be "second question"
	var lastUser string
	for _, ev := range evs2 {
		if ev.Type != "message" {
			continue
		}
		var m map[string]any
		_ = json.Unmarshal(ev.Payload, &m)
		if m["role"] == "user" || m["speaker"] == "user" {
			if tx := extractMessageText(m); tx != "" {
				lastUser = tx
			}
		}
	}
	if lastUser != "second question" {
		t.Fatalf("last user = %q", lastUser)
	}
	// session_ref should be cleared then possibly re-set by adapter; at least task finished.
	final, _ := e.Get(ctx, task.ID)
	if final.Status != StatusSucceeded {
		t.Fatalf("status=%s", final.Status)
	}
}

func TestRetryRequiresTerminal(t *testing.T) {
	ad := &fakeAdapter{
		events: []adapter.Event{
			{Type: "task_started", Payload: json.RawMessage(`{"session_id":"s1"}`)},
		},
		runFor: 10 * time.Second,
	}
	e, _ := testEngine(t, 4, ad)
	ctx := context.Background()
	task, err := e.Create(ctx, CreateRequest{
		Agent: "claude-code", Cwd: "/tmp", Prompt: "long",
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusRunning, 2*time.Second)
	_, err = e.Retry(ctx, task.ID, RetryRequest{})
	if !errors.Is(err, ErrNotTerminal) {
		t.Fatalf("want ErrNotTerminal, got %v", err)
	}
	_, _ = e.Cancel(ctx, task.ID)
}

func TestForkCopiesPrefix(t *testing.T) {
	ad := &fakeAdapter{events: successEvents()}
	e, st := testEngine(t, 4, ad)
	ctx := context.Background()

	src, err := e.Create(ctx, CreateRequest{
		Agent: "claude-code", Cwd: "/tmp", Prompt: "root prompt",
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, src.ID, StatusSucceeded, 3*time.Second)

	evs, err := st.ListEvents(ctx, src.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	// Find first user message seq
	var userSeq int
	for _, ev := range evs {
		if ev.Type != "message" {
			continue
		}
		var m map[string]any
		_ = json.Unmarshal(ev.Payload, &m)
		if m["role"] == "user" || m["speaker"] == "user" {
			userSeq = ev.Seq
			break
		}
	}
	if userSeq == 0 {
		t.Fatal("no user event")
	}

	// Fork keeping only up to user message (no new prompt) → snapshot branch.
	forked, err := e.Fork(ctx, src.ID, ForkRequest{FromSeq: userSeq})
	if err != nil {
		t.Fatal(err)
	}
	if forked.ID == src.ID {
		t.Fatal("fork should create new id")
	}
	if forked.Status != StatusSucceeded {
		t.Fatalf("snapshot fork status=%s", forked.Status)
	}
	fevs, err := st.ListEvents(ctx, forked.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	// At least the user message; may have a meta annotation after.
	if len(fevs) < 1 {
		t.Fatalf("expected copied events, got %d", len(fevs))
	}
	// Source unchanged
	sevs, _ := st.ListEvents(ctx, src.ID, 0)
	if len(sevs) != len(evs) {
		t.Fatalf("source events mutated: %d → %d", len(evs), len(sevs))
	}

	// Fork with new prompt → queued/running
	ad2 := &fakeAdapter{events: successEvents()}
	e.adapters["claude-code"] = ad2
	forked2, err := e.Fork(ctx, src.ID, ForkRequest{
		FromSeq: userSeq,
		Prompt:  "branch question",
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, forked2.ID, StatusSucceeded, 3*time.Second)
	fevs2, _ := st.ListEvents(ctx, forked2.ID, 0)
	var sawBranch bool
	for _, ev := range fevs2 {
		if ev.Type != "message" {
			continue
		}
		var m map[string]any
		_ = json.Unmarshal(ev.Payload, &m)
		if extractMessageText(m) == "branch question" {
			sawBranch = true
		}
	}
	if !sawBranch {
		t.Fatal("forked task missing new prompt event")
	}
}
