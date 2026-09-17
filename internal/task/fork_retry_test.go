package task

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/workspace"
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
	if t2.EventEpoch != 1 {
		t.Fatalf("event_epoch=%d want 1", t2.EventEpoch)
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
	originalUserSeq := firstUserSeq(t, st, task.ID)
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
	if restores[0].CP.EventSeq != originalUserSeq {
		t.Fatalf("restore checkpoint seq=%d want %d", restores[0].CP.EventSeq, originalUserSeq)
	}
	if len(captures) != 1 {
		t.Fatalf("captures=%d want only initial filesystem capture", len(captures))
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

func TestRetryWithoutRestoreCreatesGenerationAfterRelease(t *testing.T) {
	ad := &fakeAdapter{events: successEvents()}
	e, st := testEngine(t, 1, ad)
	rt := &fakeWorkspaceRuntime{failRestore: workspace.ErrCheckpointUnavailable}
	e.SetWorkspaceRuntime(rt)
	ctx := context.Background()
	task, err := e.Create(ctx, CreateRequest{
		Agent: "claude-code", Cwd: t.TempDir(), Prompt: "first",
		WorkspaceMode: workspace.ModeWorktree,
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 3*time.Second)
	first, err := st.GetCurrentWorkspace(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := st.ApplyWorkspaceTransition(ctx, store.WorkspaceTransition{
		WorkspaceID: first.ID, TaskID: task.ID,
		FromStates: []store.WorkspaceState{store.WorkspaceActive},
		ToState:    store.WorkspaceIntegrated,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := st.ApplyWorkspaceTransition(ctx, store.WorkspaceTransition{
		WorkspaceID: first.ID, TaskID: task.ID,
		FromStates: []store.WorkspaceState{store.WorkspaceIntegrated},
		ToState:    store.WorkspaceReleased,
	}); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(first.PhysicalRoot); err != nil {
		t.Fatal(err)
	}

	nextAdapter := &fakeAdapter{events: successEvents()}
	e.putAdapter("claude-code", nextAdapter)
	restoreFiles := false
	if _, err := e.Retry(ctx, task.ID, RetryRequest{RestoreFiles: &restoreFiles}); err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 3*time.Second)
	current, err := st.GetCurrentWorkspace(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if current.Generation != 2 || current.State != store.WorkspaceActive {
		t.Fatalf("retry workspace=%+v", current)
	}
	nextAdapter.mu.Lock()
	runCwd := nextAdapter.lastSpec.Cwd
	nextAdapter.mu.Unlock()
	if runCwd != current.ExecutionCwd {
		t.Fatalf("retry cwd=%q want %q", runCwd, current.ExecutionCwd)
	}
	rt.mu.Lock()
	hardRestores, treeRestores := len(rt.restores), len(rt.treeRestores)
	rt.mu.Unlock()
	if hardRestores != 0 || treeRestores != 0 {
		t.Fatalf("restore_files=false performed restores: hard=%d tree=%d", hardRestores, treeRestores)
	}
}

func TestFollowUpCreatesGenerationAfterRelease(t *testing.T) {
	ad := &fakeAdapter{events: successEvents()}
	e, st := testEngine(t, 1, ad)
	rt := &fakeWorkspaceRuntime{}
	e.SetWorkspaceRuntime(rt)
	ctx := context.Background()
	task, err := e.Create(ctx, CreateRequest{
		Agent: "claude-code", Cwd: t.TempDir(), Prompt: "first",
		WorkspaceMode: workspace.ModeWorktree,
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 3*time.Second)
	first, err := st.GetCurrentWorkspace(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := st.ApplyWorkspaceTransition(ctx, store.WorkspaceTransition{
		WorkspaceID: first.ID, TaskID: task.ID,
		FromStates: []store.WorkspaceState{store.WorkspaceActive},
		ToState:    store.WorkspaceIntegrated,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := st.ApplyWorkspaceTransition(ctx, store.WorkspaceTransition{
		WorkspaceID: first.ID, TaskID: task.ID,
		FromStates: []store.WorkspaceState{store.WorkspaceIntegrated},
		ToState:    store.WorkspaceReleased,
	}); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(first.PhysicalRoot); err != nil {
		t.Fatal(err)
	}

	nextAdapter := &fakeAdapter{events: successEvents()}
	e.putAdapter("claude-code", nextAdapter)
	if _, err := e.FollowUp(ctx, task.ID, "continue"); err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 3*time.Second)
	current, err := st.GetCurrentWorkspace(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if current.Generation != 2 {
		t.Fatalf("generation=%d want 2", current.Generation)
	}
	nextAdapter.mu.Lock()
	runCwd := nextAdapter.lastSpec.Cwd
	nextAdapter.mu.Unlock()
	if runCwd != current.ExecutionCwd {
		t.Fatalf("follow-up cwd=%q want %q", runCwd, current.ExecutionCwd)
	}
}

func TestOrchestratedFollowUpUsesGenerationAfterRelease(t *testing.T) {
	host := &fakeAdapter{events: successEvents()}
	claudeWorker := &fakeAdapter{events: successEvents()}
	codexWorker := &fakeAdapter{events: successEvents()}
	e, st := testEngine(t, 1, host)
	e.putAdapter("kin", host)
	e.putAdapter("claude-code", claudeWorker)
	e.putAdapter("codex", codexWorker)
	rt := &fakeWorkspaceRuntime{}
	e.SetWorkspaceRuntime(rt)
	ctx := context.Background()
	task, err := e.Create(ctx, CreateRequest{
		Agent: "kin", Cwd: t.TempDir(), Prompt: "first",
		WorkspaceMode: workspace.ModeWorktree,
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 3*time.Second)
	first, err := st.GetCurrentWorkspace(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := st.ApplyWorkspaceTransition(ctx, store.WorkspaceTransition{
		WorkspaceID: first.ID, TaskID: task.ID,
		FromStates: []store.WorkspaceState{store.WorkspaceActive},
		ToState:    store.WorkspaceIntegrated,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := st.ApplyWorkspaceTransition(ctx, store.WorkspaceTransition{
		WorkspaceID: first.ID, TaskID: task.ID,
		FromStates: []store.WorkspaceState{store.WorkspaceIntegrated},
		ToState:    store.WorkspaceReleased,
	}); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(first.PhysicalRoot); err != nil {
		t.Fatal(err)
	}

	if _, err := e.FollowUp(ctx, task.ID, "@claude inspect auth @codex inspect storage"); err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 3*time.Second)
	current, err := st.GetCurrentWorkspace(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if current.Generation != 2 {
		t.Fatalf("generation=%d want 2", current.Generation)
	}
	for name, worker := range map[string]*fakeAdapter{
		"claude-code": claudeWorker,
		"codex":       codexWorker,
	} {
		worker.mu.Lock()
		spec := worker.lastSpec
		worker.mu.Unlock()
		if spec.Cwd != current.ExecutionCwd {
			t.Fatalf("%s worker cwd=%q want %q", name, spec.Cwd, current.ExecutionCwd)
		}
		if spec.RunMeta.WorkspaceID != current.ID ||
			spec.RunMeta.WorkspaceAccess != adapter.AccessSourceReadOnly ||
			spec.RunMeta.Generation != current.Generation {
			t.Fatalf("%s worker run metadata=%+v want workspace %s generation %d", name, spec.RunMeta, current.ID, current.Generation)
		}
		if spec.RunMeta.WorkspaceExecutionID != current.RequestedExecutionID {
			t.Fatalf(
				"%s worker workspace execution=%q want owner %q",
				name,
				spec.RunMeta.WorkspaceExecutionID,
				current.RequestedExecutionID,
			)
		}
		if spec.Execution.ID == spec.RunMeta.WorkspaceExecutionID {
			t.Fatalf("%s worker attribution id must remain distinct from workspace owner", name)
		}
	}
}

func TestOrchestratedWorkspaceCompletionFinalizesBeforeTaskSuccess(t *testing.T) {
	host := &fakeAdapter{events: successEvents()}
	worker := &fakeAdapter{events: successEvents()}
	e, st := testEngine(t, 1, host)
	e.putAdapter("kin", host)
	e.putAdapter("claude-code", worker)
	rt := &fakeWorkspaceRuntime{}
	e.SetWorkspaceRuntime(rt)
	ctx := context.Background()
	task, err := e.Create(ctx, CreateRequest{
		Agent: "kin", Cwd: t.TempDir(), Prompt: "first",
		WorkspaceMode: workspace.ModeWorktree,
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 3*time.Second)

	worker.mu.Lock()
	worker.onStart = func(spec adapter.TaskSpec) {
		if _, err := e.CompleteWorkspace(context.Background(), WorkspaceIntentRequest{
			TaskID:      task.ID,
			ExecutionID: spec.RunMeta.WorkspaceExecutionID,
			Agent:       spec.Execution.Agent,
		}); err != nil {
			t.Errorf("complete workspace: %v", err)
		}
	}
	worker.mu.Unlock()
	if _, err := e.FollowUp(ctx, task.ID, "@claude edit the workspace"); err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 3*time.Second)

	if _, err := st.GetCurrentWorkspace(ctx, task.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("completed workspace remained current: %v", err)
	}
	generations, err := st.ListTaskWorkspaces(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(generations) != 1 || generations[0].State != store.WorkspaceReleased {
		t.Fatalf("workspace generations=%+v want one released generation", generations)
	}
	rt.mu.Lock()
	fastForwards := rt.fastForwardCalls
	rt.mu.Unlock()
	if fastForwards != 1 {
		t.Fatalf("fast-forward calls=%d want 1", fastForwards)
	}
}

func TestOrchestratedWorkspaceCompletionFinalizesBeforeFollowUp(t *testing.T) {
	host := &fakeAdapter{events: successEvents()}
	worker := &holdForApprovalAdapter{started: make(chan adapter.TaskSpec, 1)}
	e, st := testEngine(t, 1, host)
	e.putAdapter("kin", host)
	e.putAdapter("claude-code", worker)
	rt := &fakeWorkspaceRuntime{}
	e.SetWorkspaceRuntime(rt)
	ctx := context.Background()
	task, err := e.Create(ctx, CreateRequest{
		Agent: "kin", Cwd: t.TempDir(), Prompt: "first",
		WorkspaceMode: workspace.ModeWorktree,
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 3*time.Second)

	if _, err := e.FollowUp(ctx, task.ID, "@claude edit the workspace"); err != nil {
		t.Fatal(err)
	}
	var workerSpec adapter.TaskSpec
	select {
	case workerSpec = <-worker.started:
	case <-time.After(2 * time.Second):
		t.Fatal("worker did not start")
	}
	if _, err := e.CompleteWorkspace(ctx, WorkspaceIntentRequest{
		TaskID:      task.ID,
		ExecutionID: workerSpec.RunMeta.WorkspaceExecutionID,
		Agent:       workerSpec.Execution.Agent,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.FollowUp(ctx, task.ID, "continue after integration"); err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 3*time.Second)

	generations, err := st.ListTaskWorkspaces(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(generations) != 2 ||
		generations[0].State != store.WorkspaceReleased ||
		generations[1].State != store.WorkspaceActive {
		t.Fatalf("workspace generations=%+v want released g1 and active g2", generations)
	}
}

func TestFollowUpRejectedWhileOrchestratedWorkspaceFinalizes(t *testing.T) {
	host := &fakeAdapter{events: successEvents()}
	worker := &fakeAdapter{events: successEvents()}
	e, st := testEngine(t, 1, host)
	e.putAdapter("kin", host)
	e.putAdapter("claude-code", worker)
	rt := &fakeWorkspaceRuntime{
		finalizeStarted: make(chan struct{}),
		finalizeRelease: make(chan struct{}),
	}
	e.SetWorkspaceRuntime(rt)
	ctx := context.Background()
	task, err := e.Create(ctx, CreateRequest{
		Agent: "kin", Cwd: t.TempDir(), Prompt: "first",
		WorkspaceMode: workspace.ModeWorktree,
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 3*time.Second)

	worker.mu.Lock()
	worker.onStart = func(spec adapter.TaskSpec) {
		if _, err := e.CompleteWorkspace(context.Background(), WorkspaceIntentRequest{
			TaskID:      task.ID,
			ExecutionID: spec.RunMeta.WorkspaceExecutionID,
			Agent:       spec.Execution.Agent,
		}); err != nil {
			t.Errorf("complete workspace: %v", err)
		}
	}
	worker.mu.Unlock()
	if _, err := e.FollowUp(ctx, task.ID, "@claude edit the workspace"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-rt.finalizeStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("workspace finalization did not start")
	}
	if _, err := e.FollowUp(ctx, task.ID, "arrived during finalization"); !errors.Is(err, ErrConflict) {
		t.Fatalf("follow-up error=%v want conflict", err)
	}
	close(rt.finalizeRelease)
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 3*time.Second)

	generations, err := st.ListTaskWorkspaces(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(generations) != 1 || generations[0].State != store.WorkspaceReleased {
		t.Fatalf("workspace generations=%+v want released", generations)
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
	ws, err := st.GetCurrentWorkspace(ctx, forked.ID)
	if err != nil {
		t.Fatalf("forked task missing workspace generation: %v", err)
	}
	if ws.Generation != 1 || ws.State != store.WorkspaceActive {
		t.Fatalf("forked workspace=%+v", ws)
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

	current, err := st.GetCurrentWorkspace(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := st.ApplyWorkspaceTransition(ctx, store.WorkspaceTransition{
		WorkspaceID: current.ID,
		TaskID:      task.ID,
		FromStates:  []store.WorkspaceState{store.WorkspaceActive},
		ToState:     store.WorkspaceIntegrated,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := st.ApplyWorkspaceTransition(ctx, store.WorkspaceTransition{
		WorkspaceID: current.ID,
		TaskID:      task.ID,
		FromStates:  []store.WorkspaceState{store.WorkspaceIntegrated},
		ToState:     store.WorkspaceReleased,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.RestoreWorkspace(ctx, task.ID, initial.EventSeq); err != nil {
		t.Fatalf("restore from released generation: %v", err)
	}
	current, err = st.GetCurrentWorkspace(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if current.Generation != 2 || current.State != store.WorkspaceActive {
		t.Fatalf("restored workspace=%+v", current)
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

func TestRestoreCheckpointAcrossGenerationsPreservesCurrentHead(t *testing.T) {
	rt := &fakeWorkspaceRuntime{}
	e := &Engine{workspace: rt}
	target := checkpointRestoreTarget{
		meta: workspace.Metadata{
			Mode: workspace.ResolvedWorktree, Generation: 2,
			Root: "/tmp/task-g2",
		},
		workspaceID: "task:g2",
	}
	checkpoint := store.TaskCheckpoint{
		TaskID: "task", WorkspaceID: "task:g1",
		HeadOID: "old-head", TreeOID: "old-tree",
	}

	if err := e.restoreCheckpointIntoTarget(
		context.Background(), "task", target, checkpoint,
	); err != nil {
		t.Fatal(err)
	}
	rt.mu.Lock()
	defer rt.mu.Unlock()
	if len(rt.treeRestores) != 1 || len(rt.restores) != 0 {
		t.Fatalf("tree restores=%d hard restores=%d", len(rt.treeRestores), len(rt.restores))
	}
}

func TestRecoverRetryRestoreIntentRollsForward(t *testing.T) {
	e, st := testEngine(t, 1, &fakeAdapter{events: successEvents()})
	rt := &fakeWorkspaceRuntime{}
	e.SetWorkspaceRuntime(rt)
	intent := seedRetryRestoreIntent(t, st)

	if err := e.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	recovered := waitStatus(t, e, intent.TaskID, StatusSucceeded, 2*time.Second)
	if recovered.EventEpoch != 1 {
		t.Fatalf("recovered task=%+v", recovered)
	}
	if _, err := st.GetRetryRestoreIntent(context.Background(), intent.TaskID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("intent after recovery error=%v", err)
	}
	rt.mu.Lock()
	restores := append([]restoreCall(nil), rt.restores...)
	rt.mu.Unlock()
	if len(restores) != 1 || restores[0].CP.TreeOID != intent.Checkpoint.TreeOID {
		t.Fatalf("recovery restores=%+v", restores)
	}
}

func TestRecoverRetryRestoreRepeatsRestoreAfterCrashPoint(t *testing.T) {
	e, st := testEngine(t, 1, &fakeAdapter{events: successEvents()})
	rt := &fakeWorkspaceRuntime{}
	e.SetWorkspaceRuntime(rt)
	intent := seedRetryRestoreIntent(t, st)
	meta := workspaceGenerationMetadata(intent.Target)
	if err := rt.Restore(context.Background(), meta, intent.TaskID, runtimeCheckpoint(intent.Checkpoint)); err != nil {
		t.Fatal(err)
	}

	if err := e.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	recovered := waitStatus(t, e, intent.TaskID, StatusSucceeded, 2*time.Second)
	if recovered.EventEpoch != 1 {
		t.Fatalf("recovered task=%+v", recovered)
	}
	rt.mu.Lock()
	restores := append([]restoreCall(nil), rt.restores...)
	rt.mu.Unlock()
	if len(restores) != 2 {
		t.Fatalf("restores=%d want initial + idempotent recovery", len(restores))
	}
}

func TestRecoverRetryRestorePreparesRegisteredGeneration(t *testing.T) {
	e, st := testEngine(t, 1, &fakeAdapter{gate: make(chan struct{})})
	rt := &fakeWorkspaceRuntime{}
	e.SetWorkspaceRuntime(rt)
	ctx := context.Background()
	task := store.Task{
		ID: "01RECOVERRETRYNEW000000001", Title: "retry", Agent: "claude-code",
		Cwd: "/repo", Prompt: "before", Status: StatusFailed, CreatedAt: store.NowMilli(),
		WorkspaceMode: string(workspace.ResolvedWorktree),
	}
	if err := st.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}
	event, err := st.AppendEvent(ctx, task.ID, "message", json.RawMessage(`{"role":"user"}`))
	if err != nil {
		t.Fatal(err)
	}
	now := store.NowMilli()
	target := store.WorkspaceGeneration{
		ID: task.ID + ":g1", TaskID: task.ID, Generation: 1,
		State: store.WorkspaceProvisioning, SourceRoot: "/repo", Scope: ".",
		TargetBranch: "main", BaseOID: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
		CreatedAt: now, UpdatedAt: now,
	}
	intent := store.RetryRestoreIntent{
		TaskID: task.ID, RestoreFiles: true, FromSeq: event.Seq, Prompt: "after",
		UserPayload: json.RawMessage(`{"role":"user"}`),
		Checkpoint: store.TaskCheckpoint{
			TaskID: task.ID, EventSeq: event.Seq, HeadOID: "old-head",
			TreeOID: "old-tree", CreatedAt: now,
		},
		Target: target, TargetIsNew: true,
	}
	if err := st.BeginRetryRestore(ctx, intent); err != nil {
		t.Fatal(err)
	}

	if err := e.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	current, err := st.GetCurrentWorkspace(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if current.State != store.WorkspaceActive || current.PhysicalRoot == "" {
		t.Fatalf("recovered generation=%+v", current)
	}
	rt.mu.Lock()
	treeRestores := append([]restoreCall(nil), rt.treeRestores...)
	rt.mu.Unlock()
	if len(treeRestores) != 1 {
		t.Fatalf("tree restores=%d want 1", len(treeRestores))
	}
}

func TestRecoverRetryRestoreFailsClosedWhenCompensationFails(t *testing.T) {
	e, st := testEngine(t, 1, &fakeAdapter{events: successEvents()})
	rt := &fakeWorkspaceRuntime{failRestore: errors.New("restore unavailable")}
	e.SetWorkspaceRuntime(rt)
	intent := seedRetryRestoreIntent(t, st)

	if err := e.Recover(context.Background()); err == nil {
		t.Fatal("expected recovery failure")
	}
	task, err := st.GetTask(context.Background(), intent.TaskID)
	if err != nil {
		t.Fatal(err)
	}
	if task.Status != StatusRetrying {
		t.Fatalf("status=%q want retrying", task.Status)
	}
	if _, err := st.GetRetryRestoreIntent(context.Background(), intent.TaskID); err != nil {
		t.Fatalf("intent was not retained: %v", err)
	}
	if _, err := e.Cancel(context.Background(), intent.TaskID); !errors.Is(err, ErrConflict) {
		t.Fatalf("cancel error=%v want conflict", err)
	}
	if err := e.Delete(context.Background(), intent.TaskID); !errors.Is(err, ErrConflict) {
		t.Fatalf("delete error=%v want conflict", err)
	}
	if _, err := e.FollowUp(context.Background(), intent.TaskID, "new"); !errors.Is(err, ErrConflict) {
		t.Fatalf("follow-up error=%v want conflict", err)
	}
}

func TestRecoverCommittedConversationRetryClearsSessionAndRuns(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	ad := &fakeAdapter{gate: make(chan struct{})}
	e := NewEngineFromAdapters(st, map[string]adapter.Adapter{"kin": ad}, NewBus(), 1)
	defer e.Close()
	ctx := context.Background()
	task := store.Task{
		ID: "01RECOVERCONVRETRY0000001", Title: "retry", Agent: "kin",
		Cwd: t.TempDir(), Prompt: "before", Status: StatusFailed, CreatedAt: store.NowMilli(),
	}
	if err := st.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}
	event, err := st.AppendEvent(ctx, task.ID, "message", json.RawMessage(`{"role":"user"}`))
	if err != nil {
		t.Fatal(err)
	}
	if err := st.ReplaceKinMessages(ctx, task.ID, []store.KinMessage{
		{Role: "user", Content: "discarded"},
	}); err != nil {
		t.Fatal(err)
	}
	intent := store.RetryRestoreIntent{
		TaskID: task.ID, RestoreFiles: false, FromSeq: event.Seq,
		Prompt: "after", UserPayload: json.RawMessage(`{"role":"user"}`),
	}
	if err := st.BeginRetryRestore(ctx, intent); err != nil {
		t.Fatal(err)
	}
	if _, err := st.CompleteRetryRestore(ctx, task.ID); err != nil {
		t.Fatal(err)
	}
	if queued, err := st.GetTask(ctx, task.ID); err != nil || queued.Status != StatusQueued {
		t.Fatalf("completed retry task=%+v err=%v", queued, err)
	}
	if _, err := st.GetRetryRestoreIntent(ctx, task.ID); err != nil {
		t.Fatalf("completed retry marker missing: %v", err)
	}
	if orphaned, err := st.FailOrphaned(ctx); err != nil || len(orphaned) != 0 {
		t.Fatalf("committed retry classified as orphaned: ids=%v err=%v", orphaned, err)
	}

	if err := e.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusRunning, 2*time.Second)
	messages, err := st.LoadKinMessages(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 0 {
		t.Fatalf("stale kin transcript survived recovery: %+v", messages)
	}
	if _, err := st.GetRetryRestoreIntent(ctx, task.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("resume intent was not consumed at start: %v", err)
	}
}

func TestFinishConsumesQueuedRetryIntent(t *testing.T) {
	e, st := testEngine(t, 1, &fakeAdapter{events: successEvents()})
	ctx := context.Background()
	task := store.Task{
		ID: "01CANCELRETRY000000000001", Title: "retry", Agent: "claude-code",
		Cwd: t.TempDir(), Prompt: "before", Status: StatusFailed, CreatedAt: store.NowMilli(),
	}
	if err := st.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}
	event, err := st.AppendEvent(ctx, task.ID, "message", json.RawMessage(`{"role":"user"}`))
	if err != nil {
		t.Fatal(err)
	}
	intent := store.RetryRestoreIntent{
		TaskID: task.ID, FromSeq: event.Seq, Prompt: "after",
		UserPayload: json.RawMessage(`{"role":"user"}`),
	}
	if err := st.BeginRetryRestore(ctx, intent); err != nil {
		t.Fatal(err)
	}
	result, err := st.CompleteRetryRestore(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.finish(ctx, task.ID, StatusCanceled, nil, nil); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("stale finish error=%v want conflict", err)
	}
	if _, err := st.GetRetryRestoreIntent(ctx, task.ID); err != nil {
		t.Fatalf("stale finish consumed retry marker: %v", err)
	}
	if _, err := e.finishQueued(ctx, task.ID, StatusCanceled, nil, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := st.GetRetryRestoreIntent(ctx, task.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("retry marker survived terminal transition: %v", err)
	}
	intent.FromSeq = result.UserEvent.Seq
	intent.ExpectedEventEpoch = result.Task.EventEpoch
	if err := st.BeginRetryRestore(ctx, intent); err != nil {
		t.Fatalf("next retry remained blocked: %v", err)
	}
}

func TestPublishCompletedRetryIgnoresCanceledRequestContext(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	ad := &fakeAdapter{gate: make(chan struct{})}
	e := NewEngineFromAdapters(st, map[string]adapter.Adapter{"kin": ad}, NewBus(), 1)
	defer e.Close()
	task := store.Task{
		ID: "01RETRYDISCONNECT000000001", Title: "retry", Agent: "kin",
		Cwd: t.TempDir(), Prompt: "after", Status: StatusQueued, CreatedAt: store.NowMilli(),
		EventEpoch: 1,
	}
	if err := st.InsertTask(context.Background(), task); err != nil {
		t.Fatal(err)
	}
	if err := st.ReplaceKinMessages(context.Background(), task.ID, []store.KinMessage{
		{Role: "user", Content: "discarded"},
	}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := e.publishCompletedRetry(ctx, store.RetryMutationResult{
		Task: task,
		UserEvent: store.Event{
			TaskID: task.ID, EventEpoch: 1, Seq: 1, Type: "message",
			Payload: json.RawMessage(`{"role":"user"}`),
		},
	}, false, true); err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusRunning, 2*time.Second)
	messages, err := st.LoadKinMessages(context.Background(), task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 0 {
		t.Fatalf("stale kin transcript survived canceled request: %+v", messages)
	}
}

func seedRetryRestoreIntent(t *testing.T, st *store.Store) store.RetryRestoreIntent {
	t.Helper()
	ctx := context.Background()
	sourceRoot := t.TempDir()
	physicalRoot := t.TempDir()
	task := store.Task{
		ID: "01RECOVERRETRY00000000001", Title: "retry", Agent: "claude-code",
		Cwd: sourceRoot, Prompt: "before", Status: StatusFailed, CreatedAt: store.NowMilli(),
		WorkspaceMode: string(workspace.ResolvedWorktree),
	}
	if err := st.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}
	event, err := st.AppendEvent(ctx, task.ID, "message", json.RawMessage(`{"role":"user"}`))
	if err != nil {
		t.Fatal(err)
	}
	now := store.NowMilli()
	ws := store.WorkspaceGeneration{
		ID: task.ID + ":g1", TaskID: task.ID, Generation: 1, State: store.WorkspaceActive,
		SourceRoot: sourceRoot, Scope: ".", TargetBranch: "main",
		WorkspaceBranch: "kin/task/retry/g1", PhysicalRoot: physicalRoot,
		ExecutionCwd: physicalRoot, BaseOID: "base", CreatedAt: now, UpdatedAt: now,
	}
	if _, err := st.InsertWorkspaceAsCurrent(ctx, ws); err != nil {
		t.Fatal(err)
	}
	intent := store.RetryRestoreIntent{
		TaskID: task.ID, RestoreFiles: true, FromSeq: event.Seq, Prompt: "after",
		UserPayload: json.RawMessage(`{"role":"user","content":[{"type":"text","text":"after"}]}`),
		Checkpoint: store.TaskCheckpoint{
			TaskID: task.ID, EventSeq: event.Seq, HeadOID: "desired-head",
			TreeOID: "desired-tree", CreatedAt: now, WorkspaceID: ws.ID,
		},
		RollbackCheckpoint: store.TaskCheckpoint{
			TaskID: task.ID, HeadOID: "rollback-head", TreeOID: "rollback-tree",
			CreatedAt: now, WorkspaceID: ws.ID,
		},
		Target: ws,
	}
	if err := st.BeginRetryRestore(ctx, intent); err != nil {
		t.Fatal(err)
	}
	return intent
}
