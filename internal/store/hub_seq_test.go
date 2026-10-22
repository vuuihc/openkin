package store

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"testing"
)

func insertCursorTestTask(t *testing.T, s *Store, id string) {
	t.Helper()
	if err := s.InsertTask(context.Background(), Task{
		ID: id, Title: id, Agent: "codex", Cwd: "/tmp", Prompt: "p",
		Status: "running", CreatedAt: NowMilli(),
	}); err != nil {
		t.Fatalf("insert task %s: %v", id, err)
	}
}

func taskHubSeq(t *testing.T, s *Store, taskID string) *int64 {
	t.Helper()
	var seq *int64
	if err := s.db.QueryRow(`SELECT hub_seq FROM tasks WHERE id = ?`, taskID).Scan(&seq); err != nil {
		t.Fatalf("read hub_seq of %s: %v", taskID, err)
	}
	return seq
}

func eventSeqs(t *testing.T, s *Store, taskID string) []int {
	t.Helper()
	rows, err := s.db.Query(`SELECT seq FROM events WHERE task_id = ? ORDER BY seq ASC`, taskID)
	if err != nil {
		t.Fatalf("read event seqs of %s: %v", taskID, err)
	}
	defer rows.Close()
	var out []int
	for rows.Next() {
		var seq int
		if err := rows.Scan(&seq); err != nil {
			t.Fatalf("scan event seq: %v", err)
		}
		out = append(out, seq)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate event seqs: %v", err)
	}
	return out
}

// hub_seq is the cursor a client stores to ask "what changed since I left". Two
// properties make that question answerable: it never goes backwards, and it is
// allocated across every task rather than inside one. This walks two tasks in an
// interleaved order so a per-task counter or a reused number would show up.
func TestEventAppendsShareOneMonotonicCursor(t *testing.T) {
	ctx := context.Background()
	s := openDeviceTestStore(t)
	insertCursorTestTask(t, s, "task-a")
	insertCursorTestTask(t, s, "task-b")

	for i, taskID := range []string{"task-a", "task-b", "task-a", "task-b", "task-b"} {
		if _, err := s.AppendEvent(ctx, taskID, "agent_message", json.RawMessage(`{"text":"hi"}`)); err != nil {
			t.Fatalf("append %d to %s: %v", i, taskID, err)
		}
	}

	// Each task keeps its own gap-free event log...
	for taskID, want := range map[string][]int{"task-a": {1, 2}, "task-b": {1, 2, 3}} {
		got := eventSeqs(t, s, taskID)
		if fmt.Sprint(got) != fmt.Sprint(want) {
			t.Errorf("%s event seqs = %v, want %v", taskID, got, want)
		}
	}
	// ...and the cursor a reader follows is the order the writes happened in,
	// not the order the tasks were created in.
	a, b := taskHubSeq(t, s, "task-a"), taskHubSeq(t, s, "task-b")
	if a == nil || b == nil {
		t.Fatalf("hub_seq not set: task-a=%v task-b=%v", a, b)
	}
	if *a != 3 || *b != 5 {
		t.Errorf("hub_seq = %d/%d, want 3/5 (a's last write was the third append, b's the fifth)", *a, *b)
	}
	if *a >= *b {
		t.Errorf("cursor did not advance across tasks: a=%d b=%d", *a, *b)
	}
}

// A usage event is a task change like any other. It used to update the token
// totals in place, which a cursor-driven reader would sleep through.
func TestUsageEventAdvancesTheCursor(t *testing.T) {
	ctx := context.Background()
	s := openDeviceTestStore(t)
	insertCursorTestTask(t, s, "task-a")

	if _, err := s.AppendEvent(ctx, "task-a", "agent_message", nil); err != nil {
		t.Fatal(err)
	}
	before := taskHubSeq(t, s, "task-a")

	input := 10
	if _, _, err := s.AppendUsageEvent(ctx, "task-a", "usage", nil, UsageRecord{
		Agent: "codex", InputTokens: &input,
		CostSource: CostSourceUnknown, CacheStatus: CacheStatusUnknown,
		InputSemantics: InputSemanticsTotalIncludesCache,
	}); err != nil {
		t.Fatal(err)
	}

	after := taskHubSeq(t, s, "task-a")
	if after == nil || before == nil || *after <= *before {
		t.Fatalf("hub_seq %v -> %v, want an increase", before, after)
	}
}

// Retrying a turn deletes its tail. The deletion is itself a change a synced
// client has to hear about, or it keeps rendering events that no longer exist.
func TestTruncatingEventsAdvancesTheCursor(t *testing.T) {
	ctx := context.Background()
	s := openDeviceTestStore(t)
	insertCursorTestTask(t, s, "task-a")

	for i := 0; i < 3; i++ {
		if _, err := s.AppendEvent(ctx, "task-a", "agent_message", nil); err != nil {
			t.Fatal(err)
		}
	}
	before := taskHubSeq(t, s, "task-a")

	if err := s.TruncateEventsFrom(ctx, "task-a", 2); err != nil {
		t.Fatal(err)
	}

	after := taskHubSeq(t, s, "task-a")
	if after == nil || before == nil || *after <= *before {
		t.Fatalf("hub_seq %v -> %v, want an increase", before, after)
	}
	if got := eventSeqs(t, s, "task-a"); fmt.Sprint(got) != "[1]" {
		t.Fatalf("event seqs after truncate = %v, want [1]", got)
	}
	var epoch int64
	if err := s.db.QueryRow(`SELECT event_epoch FROM tasks WHERE id = 'task-a'`).Scan(&epoch); err != nil {
		t.Fatal(err)
	}
	if epoch != 1 {
		t.Fatalf("event_epoch = %d, want 1", epoch)
	}
}

// MAX(hub_seq)+1 is only safe because every write goes through one connection.
// If that ever stops being true, two writers hand out the same number and a
// client that reads at that cursor silently skips a task. This pins the
// assumption rather than the implementation.
func TestConcurrentAppendsAllocateDistinctCursors(t *testing.T) {
	ctx := context.Background()
	s := openDeviceTestStore(t)
	const writers = 8
	for i := 0; i < writers; i++ {
		insertCursorTestTask(t, s, fmt.Sprintf("task-%d", i))
	}

	var wg sync.WaitGroup
	errs := make([]error, writers)
	for i := 0; i < writers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, errs[i] = s.AppendEvent(ctx, fmt.Sprintf("task-%d", i), "agent_message", nil)
		}(i)
	}
	wg.Wait()

	seen := map[int64]string{}
	for i := 0; i < writers; i++ {
		if errs[i] != nil {
			t.Fatalf("writer %d: %v", i, errs[i])
		}
		seq := taskHubSeq(t, s, fmt.Sprintf("task-%d", i))
		if seq == nil {
			t.Fatalf("task-%d has no cursor", i)
		}
		if other, dup := seen[*seq]; dup {
			t.Fatalf("cursor %d handed to both %s and task-%d", *seq, other, i)
		}
		seen[*seq] = fmt.Sprintf("task-%d", i)
	}
	// Numbering starts at 1 and does not skip, so the cursor a client holds is
	// also a count of changes it has seen.
	for want := int64(1); want <= writers; want++ {
		if _, ok := seen[want]; !ok {
			t.Errorf("cursor %d was never allocated", want)
		}
	}
}
