package task

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/workspace"
)

// treeForSeq gives every capture a different tree so the recorded pair is
// recognisable in the event.
func treeForSeq(seq int) string {
	digit := byte('1' + (seq % 8))
	return strings.Repeat(string(digit), 40)
}

func checkpointCapture(_ context.Context, _ workspace.Metadata, taskID string, seq int) (workspace.Checkpoint, error) {
	return workspace.Checkpoint{
		TaskID:    taskID,
		EventSeq:  seq,
		HeadOID:   strings.Repeat("a", 40),
		TreeOID:   treeForSeq(seq),
		SizeBytes: 1,
		CreatedAt: int64(seq),
	}, nil
}

// The round that just ended is recorded from the two checkpoints that bracket
// it, so the console can show what the disk says rather than what the tools
// claimed. The record is written when the *next* turn starts, which is when the
// second checkpoint exists.
func TestNextTurnRecordsTheRoundBeforeIt(t *testing.T) {
	ad := &fakeAdapter{events: successEvents()}
	e, st := testEngine(t, 4, ad)
	rt := &fakeWorkspaceRuntime{capture: checkpointCapture}
	var pairs [][2]string
	rt.treeDiff = func(baseTreeOID, headTreeOID string) ([]workspace.Change, error) {
		pairs = append(pairs, [2]string{baseTreeOID, headTreeOID})
		return []workspace.Change{{Path: "internal/app.go", Status: "modified", Additions: 4, Deletions: 1}}, nil
	}
	e.SetWorkspaceRuntime(rt)
	ctx := context.Background()

	task, err := e.Create(ctx, CreateRequest{
		Agent: "claude-code", Cwd: "/tmp", Prompt: "first", WorkspaceMode: workspace.ModeWorktree,
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 3*time.Second)
	firstUser := firstUserSeq(t, st, task.ID)

	if _, err := e.FollowUp(ctx, task.ID, "second"); err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 3*time.Second)

	if len(pairs) != 1 {
		t.Fatalf("tree diffs=%v want exactly the round between the two captures", pairs)
	}
	if pairs[0][0] != treeForSeq(firstUser) {
		t.Fatalf("base tree=%s want %s", pairs[0][0], treeForSeq(firstUser))
	}

	events, err := st.ListEvents(ctx, task.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	var recorded map[string]any
	for _, event := range events {
		if event.Type != "round_changed" {
			continue
		}
		if recorded != nil {
			t.Fatal("more than one round_changed event")
		}
		if err := json.Unmarshal(event.Payload, &recorded); err != nil {
			t.Fatal(err)
		}
	}
	if recorded == nil {
		t.Fatal("no round_changed event")
	}
	if got := int(recorded["from_seq"].(float64)); got != firstUser {
		t.Fatalf("from_seq=%d want %d", got, firstUser)
	}
	if got := int(recorded["total"].(float64)); got != 1 {
		t.Fatalf("total=%d want 1", got)
	}
	files, _ := recorded["files"].([]any)
	if len(files) != 1 {
		t.Fatalf("files=%v", recorded["files"])
	}
	file, _ := files[0].(map[string]any)
	if file["path"] != "internal/app.go" || file["status"] != "modified" {
		t.Fatalf("file=%v", file)
	}
	if file["additions"].(float64) != 4 || file["deletions"].(float64) != 1 {
		t.Fatalf("file=%v", file)
	}
}

// A diff that cannot be computed is not a round that changed nothing: the card
// falls back to the tool payloads, and the checkpoint itself still lands.
func TestRoundRecordSkipsWhenTheDiffFails(t *testing.T) {
	ad := &fakeAdapter{events: successEvents()}
	e, st := testEngine(t, 4, ad)
	rt := &fakeWorkspaceRuntime{capture: checkpointCapture, failTreeDiff: workspace.ErrCheckpointUnavailable}
	e.SetWorkspaceRuntime(rt)
	ctx := context.Background()

	task, err := e.Create(ctx, CreateRequest{
		Agent: "claude-code", Cwd: "/tmp", Prompt: "first", WorkspaceMode: workspace.ModeWorktree,
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 3*time.Second)
	if _, err := e.FollowUp(ctx, task.ID, "second"); err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusSucceeded, 3*time.Second)

	events, err := st.ListEvents(ctx, task.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, event := range events {
		if event.Type == "round_changed" {
			t.Fatalf("recorded a round the diff could not describe: %s", event.Payload)
		}
	}
	checkpoints, err := st.ListCheckpoints(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(checkpoints) != 2 {
		t.Fatalf("checkpoints=%d want 2", len(checkpoints))
	}
}
