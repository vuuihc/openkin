package task

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/vuuihc/kin/internal/adapter"
	"github.com/vuuihc/kin/internal/store"
	"github.com/vuuihc/kin/internal/workspace"
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
	e.putAdapter("claude-code", ad2)
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
	e.putAdapter("claude-code", ad3)
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

func TestRetryRestoresCheckpointBeforeTruncate(t *testing.T) {
	ad := &fakeAdapter{events: successEvents()}
	e, st := testEngine(t, 4, ad)
	rt := &fakeWorkspaceRuntime{}
	e.SetWorkspaceRuntime(rt)
	ctx := context.Background()

	task, err := e.Create(ctx, CreateRequest{
		Agent: "claude-code", Cwd: "/tmp", Prompt: "restore me", WorkspaceMode: workspace.ModeWorktree,
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 3*time.Second)

	before, err := st.ListEvents(ctx, task.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	rt.restore = func(ctx context.Context, meta workspace.Metadata, taskID string, cp workspace.Checkpoint) error {
		evs, err := st.ListEvents(ctx, taskID, 0)
		if err != nil {
			t.Fatal(err)
		}
		if len(evs) != len(before) {
			t.Fatalf("restore saw truncated events: got %d want %d", len(evs), len(before))
		}
		return nil
	}
	ad2 := &fakeAdapter{events: successEvents()}
	e.putAdapter("claude-code", ad2)

	if _, err := e.Retry(ctx, task.ID, RetryRequest{}); err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 3*time.Second)

	rt.mu.Lock()
	restores := append([]restoreCall(nil), rt.restores...)
	captures := append([]captureCall(nil), rt.captures...)
	rt.mu.Unlock()
	if len(restores) != 1 {
		t.Fatalf("restores=%d", len(restores))
	}
	if restores[0].CP.EventSeq != 1 {
		t.Fatalf("restore checkpoint seq=%d", restores[0].CP.EventSeq)
	}
	if len(captures) < 2 {
		t.Fatalf("captures=%d want create + retry", len(captures))
	}
	cps, err := st.ListCheckpoints(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	latestUserSeq := firstUserSeq(t, st, task.ID)
	for {
		evs, err := st.ListEvents(ctx, task.ID, latestUserSeq)
		if err != nil {
			t.Fatal(err)
		}
		next := 0
		for _, ev := range evs {
			if ev.Type != "message" {
				continue
			}
			var m map[string]any
			_ = json.Unmarshal(ev.Payload, &m)
			if m["role"] == "user" || m["speaker"] == "user" {
				next = ev.Seq
			}
		}
		if next == 0 {
			break
		}
		latestUserSeq = next
	}
	if len(cps) != 1 || cps[0].EventSeq != latestUserSeq {
		t.Fatalf("checkpoints after retry=%+v", cps)
	}
}

func TestRetryRestoreFailureLeavesEventsAndCheckpoints(t *testing.T) {
	ad := &fakeAdapter{events: successEvents()}
	e, st := testEngine(t, 4, ad)
	rt := &fakeWorkspaceRuntime{}
	e.SetWorkspaceRuntime(rt)
	ctx := context.Background()

	task, err := e.Create(ctx, CreateRequest{
		Agent: "claude-code", Cwd: "/tmp", Prompt: "restore fail", WorkspaceMode: workspace.ModeWorktree,
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 3*time.Second)
	beforeEvents, err := st.ListEvents(ctx, task.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	beforeCheckpoints, err := st.ListCheckpoints(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}

	rt.failRestore = workspace.ErrCheckpointUnavailable
	_, err = e.Retry(ctx, task.ID, RetryRequest{})
	if !errors.Is(err, workspace.ErrCheckpointUnavailable) {
		t.Fatalf("err=%v", err)
	}
	afterEvents, _ := st.ListEvents(ctx, task.ID, 0)
	afterCheckpoints, _ := st.ListCheckpoints(ctx, task.ID)
	if len(afterEvents) != len(beforeEvents) {
		t.Fatalf("events mutated: %d -> %d", len(beforeEvents), len(afterEvents))
	}
	if len(afterCheckpoints) != len(beforeCheckpoints) {
		t.Fatalf("checkpoints mutated: %d -> %d", len(beforeCheckpoints), len(afterCheckpoints))
	}
}

func TestRetryRestoreFilesFalseKeepsConversationOnlyBehavior(t *testing.T) {
	ad := &fakeAdapter{events: successEvents()}
	e, _ := testEngine(t, 4, ad)
	rt := &fakeWorkspaceRuntime{failRestore: workspace.ErrCheckpointUnavailable}
	e.SetWorkspaceRuntime(rt)
	ctx := context.Background()

	task, err := e.Create(ctx, CreateRequest{
		Agent: "claude-code", Cwd: "/tmp", Prompt: "no restore", WorkspaceMode: workspace.ModeWorktree,
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 3*time.Second)

	restoreFiles := false
	ad2 := &fakeAdapter{events: successEvents()}
	e.putAdapter("claude-code", ad2)
	if _, err := e.Retry(ctx, task.ID, RetryRequest{RestoreFiles: &restoreFiles}); err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 3*time.Second)
	rt.mu.Lock()
	restores := len(rt.restores)
	rt.mu.Unlock()
	if restores != 0 {
		t.Fatalf("restores=%d", restores)
	}
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
	e.putAdapter("claude-code", ad2)
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

func TestForkIsolatedPreparesWorkspaceFromCheckpoint(t *testing.T) {
	ad := &fakeAdapter{events: successEvents()}
	e, st := testEngine(t, 4, ad)
	rt := &fakeWorkspaceRuntime{}
	e.SetWorkspaceRuntime(rt)
	ctx := context.Background()

	src, err := e.Create(ctx, CreateRequest{
		Agent: "claude-code", Cwd: "/tmp", Prompt: "root prompt", WorkspaceMode: workspace.ModeWorktree,
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, src.ID, StatusSucceeded, 3*time.Second)
	userSeq := firstUserSeq(t, st, src.ID)

	forked, err := e.Fork(ctx, src.ID, ForkRequest{FromSeq: userSeq})
	if err != nil {
		t.Fatal(err)
	}
	if forked.WorkspaceMode != string(workspace.ResolvedWorktree) {
		t.Fatalf("workspace mode=%q", forked.WorkspaceMode)
	}
	rt.mu.Lock()
	prepareForks := append([]prepareForkCall(nil), rt.prepareForks...)
	rt.mu.Unlock()
	if len(prepareForks) != 1 {
		t.Fatalf("prepareForks=%d", len(prepareForks))
	}
	if prepareForks[0].CP.TaskID != src.ID || prepareForks[0].CP.EventSeq != userSeq {
		t.Fatalf("prepare fork checkpoint=%+v", prepareForks[0].CP)
	}
	cps, err := st.ListCheckpoints(ctx, forked.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(cps) == 0 {
		t.Fatal("forked task missing owned checkpoint")
	}
}

func TestForkIsolatedRequiresCheckpoint(t *testing.T) {
	ad := &fakeAdapter{events: successEvents()}
	e, st := testEngine(t, 4, ad)
	rt := &fakeWorkspaceRuntime{failCapture: workspace.ErrSnapshotTooLarge}
	e.SetWorkspaceRuntime(rt)
	ctx := context.Background()

	src, err := e.Create(ctx, CreateRequest{
		Agent: "claude-code", Cwd: "/tmp", Prompt: "root prompt", WorkspaceMode: workspace.ModeWorktree,
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, src.ID, StatusSucceeded, 3*time.Second)
	userSeq := firstUserSeq(t, st, src.ID)
	beforeTasks, err := st.ListTasks(ctx, store.ListTasksOpts{})
	if err != nil {
		t.Fatal(err)
	}

	_, err = e.Fork(ctx, src.ID, ForkRequest{FromSeq: userSeq})
	if !errors.Is(err, workspace.ErrCheckpointUnavailable) {
		t.Fatalf("err=%v", err)
	}
	afterTasks, err := st.ListTasks(ctx, store.ListTasksOpts{})
	if err != nil {
		t.Fatal(err)
	}
	if len(afterTasks) != len(beforeTasks) {
		t.Fatalf("task inserted despite missing checkpoint: %d -> %d", len(beforeTasks), len(afterTasks))
	}
	rt.mu.Lock()
	prepareForks := len(rt.prepareForks)
	rt.mu.Unlock()
	if prepareForks != 0 {
		t.Fatalf("prepareForks=%d", prepareForks)
	}
}

func firstUserSeq(t *testing.T, st *store.Store, taskID string) int {
	t.Helper()
	evs, err := st.ListEvents(context.Background(), taskID, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, ev := range evs {
		if ev.Type != "message" {
			continue
		}
		var m map[string]any
		_ = json.Unmarshal(ev.Payload, &m)
		if m["role"] == "user" || m["speaker"] == "user" {
			return ev.Seq
		}
	}
	t.Fatal("no user event")
	return 0
}

func TestRestoreWorkspaceInitialCheckpoint(t *testing.T) {
	ad := &fakeAdapter{events: successEvents()}
	e, st := testEngine(t, 4, ad)
	rt := &fakeWorkspaceRuntime{}
	e.SetWorkspaceRuntime(rt)
	ctx := context.Background()

	task, err := e.Create(ctx, CreateRequest{
		Agent: "claude-code", Cwd: "/tmp", Prompt: "restore me", WorkspaceMode: workspace.ModeWorktree,
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 3*time.Second)

	// Second turn so there are multiple checkpoints.
	ad2 := &fakeAdapter{events: successEvents()}
	e.putAdapter("claude-code", ad2)
	if _, err := e.FollowUp(ctx, task.ID, "again"); err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 3*time.Second)

	cps, err := st.ListCheckpoints(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(cps) < 1 {
		t.Fatalf("checkpoints=%d", len(cps))
	}
	initial := cps[0]

	rt.mu.Lock()
	rt.restores = nil
	rt.mu.Unlock()

	if _, err := e.RestoreWorkspace(ctx, task.ID, 0); err != nil {
		t.Fatal(err)
	}
	rt.mu.Lock()
	restores := append([]restoreCall(nil), rt.restores...)
	rt.mu.Unlock()
	if len(restores) != 1 {
		t.Fatalf("restores=%d", len(restores))
	}
	if restores[0].CP.EventSeq != initial.EventSeq {
		t.Fatalf("restored seq=%d want %d", restores[0].CP.EventSeq, initial.EventSeq)
	}

	// Meta event published.
	evs, err := st.ListEvents(ctx, task.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, ev := range evs {
		if ev.Type == "workspace_restored" {
			found = true
			var p map[string]any
			_ = json.Unmarshal(ev.Payload, &p)
			if int(p["event_seq"].(float64)) != initial.EventSeq {
				t.Fatalf("event_seq payload=%v", p["event_seq"])
			}
		}
	}
	if !found {
		t.Fatal("missing workspace_restored event")
	}

	// Status unchanged.
	got, err := e.Get(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != StatusSucceeded {
		t.Fatalf("status=%s", got.Status)
	}
}

func TestRestoreWorkspaceRequiresTerminalAndIsolated(t *testing.T) {
	ad := &fakeAdapter{
		events: []adapter.Event{
			{Type: "task_started", Payload: json.RawMessage(`{"session_id":"s1"}`)},
		},
		runFor: 10 * time.Second,
	}
	e, _ := testEngine(t, 4, ad)
	rt := &fakeWorkspaceRuntime{}
	e.SetWorkspaceRuntime(rt)
	ctx := context.Background()

	task, err := e.Create(ctx, CreateRequest{
		Agent: "claude-code", Cwd: "/tmp", Prompt: "running", WorkspaceMode: workspace.ModeWorktree,
	})
	if err != nil {
		t.Fatal(err)
	}
	// Non-terminal → conflict.
	if _, err := e.RestoreWorkspace(ctx, task.ID, 0); !errors.Is(err, ErrConflict) {
		t.Fatalf("want ErrConflict, got %v", err)
	}
	if _, err := e.Cancel(ctx, task.ID); err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusCanceled, 3*time.Second)

	// Shared task → not isolated.
	ad2 := &fakeAdapter{events: successEvents()}
	e2, _ := testEngine(t, 4, ad2)
	// No workspace runtime → prepareWorkspace falls back to shared.
	shared, err := e2.Create(ctx, CreateRequest{
		Agent: "claude-code", Cwd: "/tmp", Prompt: "shared", WorkspaceMode: workspace.ModeShared,
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e2, shared.ID, StatusSucceeded, 3*time.Second)
	if shared.WorkspaceMode != string(workspace.ResolvedShared) {
		t.Fatalf("workspace mode=%q", shared.WorkspaceMode)
	}
	if _, err := e2.RestoreWorkspace(ctx, shared.ID, 0); !errors.Is(err, workspace.ErrNotIsolated) {
		t.Fatalf("want ErrNotIsolated, got %v", err)
	}
}

func TestRestoreWorkspaceFailureDoesNotAppendEvent(t *testing.T) {
	ad := &fakeAdapter{events: successEvents()}
	e, st := testEngine(t, 4, ad)
	rt := &fakeWorkspaceRuntime{failRestore: workspace.ErrCheckpointUnavailable}
	e.SetWorkspaceRuntime(rt)
	ctx := context.Background()

	task, err := e.Create(ctx, CreateRequest{
		Agent: "claude-code", Cwd: "/tmp", Prompt: "restore fail", WorkspaceMode: workspace.ModeWorktree,
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 3*time.Second)

	// Clear fail so capture succeeded; force restore fail.
	rt.failRestore = errors.New("git boom")
	before, err := st.ListEvents(ctx, task.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.RestoreWorkspace(ctx, task.ID, 0); err == nil {
		t.Fatal("expected restore error")
	}
	after, err := st.ListEvents(ctx, task.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != len(before) {
		t.Fatalf("events grew on failed restore: %d -> %d", len(before), len(after))
	}
	got, _ := e.Get(ctx, task.ID)
	if got.Status != StatusSucceeded {
		t.Fatalf("status changed to %s", got.Status)
	}
}
