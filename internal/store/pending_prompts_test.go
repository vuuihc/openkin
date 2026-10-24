package store

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

// A message sent while a task is still running waits in a queue.
//
// The two properties worth a test are the ones a phone depends on: the order
// survives (the second message does not overtake the first) and the queue
// survives a restart (the sender has already put the phone away, so nothing is
// going to resend it).

func openQueueStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func insertQueueTask(t *testing.T, s *Store, id string) {
	t.Helper()
	if err := s.InsertTask(context.Background(), Task{
		ID: id, Title: "Queue", Agent: "claude-code", Cwd: "/work/app",
		Prompt: "start", Status: "running", CreatedAt: time.Now().UnixMilli(),
	}); err != nil {
		t.Fatal(err)
	}
}

func TestQueuedMessagesKeepTheOrderTheyWereSent(t *testing.T) {
	ctx := context.Background()
	s := openQueueStore(t)
	insertQueueTask(t, s, "task-q")
	model := "opus-4"
	for _, text := range []string{"first", "second", "third"} {
		if _, err := s.AppendPendingPrompt(ctx, PendingPrompt{
			TaskID: "task-q", Prompt: text, Agent: "claude-code", Model: &model,
		}); err != nil {
			t.Fatal(err)
		}
	}

	got, err := s.ListPendingPrompts(ctx, "task-q")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 {
		t.Fatalf("queue holds %d messages, want 3", len(got))
	}
	for i, want := range []string{"first", "second", "third"} {
		if got[i].Prompt != want {
			t.Fatalf("position %d = %q, want %q", i, got[i].Prompt, want)
		}
	}
	if got[0].Agent != "claude-code" {
		t.Fatalf("agent = %q, want the one it was queued with", got[0].Agent)
	}
	if got[0].Model == nil || *got[0].Model != model {
		t.Fatalf("model = %v, want %q", got[0].Model, model)
	}
	if got[0].QueuedAt <= 0 {
		t.Fatalf("queued_at = %d, want a real timestamp", got[0].QueuedAt)
	}
}

func TestTheQueueIsDrainedFromTheHeadAndThenIsEmpty(t *testing.T) {
	ctx := context.Background()
	s := openQueueStore(t)
	insertQueueTask(t, s, "task-drain")
	for _, text := range []string{"one", "two"} {
		if _, err := s.AppendPendingPrompt(ctx, PendingPrompt{TaskID: "task-drain", Prompt: text}); err != nil {
			t.Fatal(err)
		}
	}

	for _, want := range []string{"one", "two"} {
		p, ok, err := s.PopPendingPrompt(ctx, "task-drain")
		if err != nil {
			t.Fatal(err)
		}
		if !ok {
			t.Fatalf("queue reported empty while %q was still queued", want)
		}
		if p.Prompt != want {
			t.Fatalf("drained %q, want %q", p.Prompt, want)
		}
	}

	// An empty queue is not an error: two turn boundaries can race for the same
	// last message, and the loser has simply nothing to deliver.
	if _, ok, err := s.PopPendingPrompt(ctx, "task-drain"); err != nil || ok {
		t.Fatalf("pop on an empty queue = (ok=%v, err=%v), want (false, nil)", ok, err)
	}
	rest, err := s.ListPendingPrompts(ctx, "task-drain")
	if err != nil {
		t.Fatal(err)
	}
	if len(rest) != 0 {
		t.Fatalf("queue still holds %d messages after draining", len(rest))
	}
}

// "Said nothing" and "said empty" are different instructions downstream: the
// first leaves the task's setting alone, the second clears it. A nullable column
// is what keeps them apart, and this is the test that says so.
func TestAnAbsentSettingStaysAbsentAndAnEmptyOneStaysEmpty(t *testing.T) {
	ctx := context.Background()
	s := openQueueStore(t)
	insertQueueTask(t, s, "task-null")
	empty := ""
	if _, err := s.AppendPendingPrompt(ctx, PendingPrompt{
		TaskID: "task-null", Prompt: "no opinion", Model: nil, PermissionMode: nil,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AppendPendingPrompt(ctx, PendingPrompt{
		TaskID: "task-null", Prompt: "clear it", Model: &empty, PermissionMode: &empty,
	}); err != nil {
		t.Fatal(err)
	}

	got, err := s.ListPendingPrompts(ctx, "task-null")
	if err != nil {
		t.Fatal(err)
	}
	if got[0].Model != nil || got[0].PermissionMode != nil {
		t.Fatalf("absent settings came back as %v/%v, want nil/nil", got[0].Model, got[0].PermissionMode)
	}
	if got[1].Model == nil || *got[1].Model != "" {
		t.Fatalf("an explicit empty model came back as %v, want a pointer to \"\"", got[1].Model)
	}
	if got[1].PermissionMode == nil || *got[1].PermissionMode != "" {
		t.Fatalf("an explicit empty mode came back as %v, want a pointer to \"\"", got[1].PermissionMode)
	}
}

// The reason this is a table and not a field in memory: the sender is a phone
// that has already been locked by the time the turn boundary arrives.
func TestQueuedMessagesSurviveARestart(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "kin.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	insertQueueTask(t, s, "task-restart")
	if _, err := s.AppendPendingPrompt(ctx, PendingPrompt{
		TaskID: "task-restart", Prompt: "still here after a restart?",
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	p, ok, err := reopened.PopPendingPrompt(ctx, "task-restart")
	if err != nil {
		t.Fatal(err)
	}
	if !ok || p.Prompt != "still here after a restart?" {
		t.Fatalf("after restart pop = (%q, %v), want the queued message", p.Prompt, ok)
	}
}

func TestAQueueBelongsToOneTask(t *testing.T) {
	ctx := context.Background()
	s := openQueueStore(t)
	insertQueueTask(t, s, "task-a")
	insertQueueTask(t, s, "task-b")
	if _, err := s.AppendPendingPrompt(ctx, PendingPrompt{TaskID: "task-a", Prompt: "for a"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AppendPendingPrompt(ctx, PendingPrompt{TaskID: "task-b", Prompt: "for b"}); err != nil {
		t.Fatal(err)
	}

	if _, ok, err := s.PopPendingPrompt(ctx, "task-a"); err != nil || !ok {
		t.Fatalf("pop for task-a = (ok=%v, err=%v)", ok, err)
	}
	left, err := s.ListPendingPrompts(ctx, "task-b")
	if err != nil {
		t.Fatal(err)
	}
	if len(left) != 1 || left[0].Prompt != "for b" {
		t.Fatalf("task-b's queue = %+v, want its own message untouched", left)
	}
}

// A deleted task's queue goes with it: the row is a delivery index, and there is
// nothing left to deliver to.
func TestDeletingATaskTakesItsQueueWithIt(t *testing.T) {
	ctx := context.Background()
	s := openQueueStore(t)
	insertQueueTask(t, s, "task-doomed")
	if _, err := s.AppendPendingPrompt(ctx, PendingPrompt{TaskID: "task-doomed", Prompt: "never delivered"}); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteTask(ctx, "task-doomed"); err != nil {
		t.Fatal(err)
	}

	left, err := s.ListPendingPrompts(ctx, "task-doomed")
	if err != nil {
		t.Fatal(err)
	}
	if len(left) != 0 {
		t.Fatalf("queue survived its task: %+v", left)
	}
}

func TestClearingAQueueReportsWhatItDiscarded(t *testing.T) {
	ctx := context.Background()
	s := openQueueStore(t)
	insertQueueTask(t, s, "task-clear")
	for _, text := range []string{"a", "b"} {
		if _, err := s.AppendPendingPrompt(ctx, PendingPrompt{TaskID: "task-clear", Prompt: text}); err != nil {
			t.Fatal(err)
		}
	}

	n, err := s.ClearPendingPrompts(ctx, "task-clear")
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("cleared %d messages, want 2", n)
	}
	if n, err = s.ClearPendingPrompts(ctx, "task-clear"); err != nil || n != 0 {
		t.Fatalf("second clear = (%d, %v), want (0, nil)", n, err)
	}
}

func TestAnEmptyMessageIsNotQueued(t *testing.T) {
	ctx := context.Background()
	s := openQueueStore(t)
	insertQueueTask(t, s, "task-blank")
	if _, err := s.AppendPendingPrompt(ctx, PendingPrompt{TaskID: "task-blank", Prompt: "   "}); err == nil {
		t.Fatal("a whitespace-only message was queued")
	}
	if _, err := s.AppendPendingPrompt(ctx, PendingPrompt{Prompt: "no task"}); err == nil {
		t.Fatal("a message with no task was queued")
	}
	if n, err := s.ClearPendingPrompts(ctx, "task-blank"); err != nil || n != 0 {
		t.Fatalf("rejected messages left rows behind: %d, %v", n, err)
	}
}

// A task that is gone is a foreign-key violation, not a queue entry. The
// distinction matters because the caller reports the error to the sender.
func TestQueueingForAnUnknownTaskFails(t *testing.T) {
	ctx := context.Background()
	s := openQueueStore(t)
	_, err := s.AppendPendingPrompt(ctx, PendingPrompt{TaskID: "nobody", Prompt: "hello"})
	if err == nil {
		t.Fatal("queueing for a task that does not exist succeeded")
	}
	if errors.Is(err, ErrNotFound) {
		t.Fatalf("error = %v, want the constraint failure rather than a not-found", err)
	}
}

// The upgrade path is the one that can lose data. This is migration 039 over a
// database that already has tasks in it: the table arrives, and the rows that
// were there keep everything they had.
func TestUpgradeAddsTheQueueTableAndKeepsRows(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "kin.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	insertQueueTask(t, s, "task-before")
	// Put the database back to the shape migration 039 upgrades from.
	if _, err := s.db.ExecContext(ctx, `
		DROP TABLE task_pending_prompts;
		PRAGMA user_version = 38;`); err != nil {
		t.Fatalf("roll schema back to 38: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	upgraded, err := Open(path)
	if err != nil {
		t.Fatalf("reopen at version 38: %v", err)
	}
	t.Cleanup(func() { _ = upgraded.Close() })

	if got := schemaVersionOf(t, upgraded); got != schemaVersion {
		t.Fatalf("user_version after upgrade = %d, want %d", got, schemaVersion)
	}
	if _, err := upgraded.GetTask(ctx, "task-before"); err != nil {
		t.Fatalf("the existing task did not survive the upgrade: %v", err)
	}
	if _, err := upgraded.AppendPendingPrompt(ctx, PendingPrompt{
		TaskID: "task-before", Prompt: "queued after the upgrade",
	}); err != nil {
		t.Fatalf("the upgraded database has no usable queue: %v", err)
	}
}

// A fresh install gets the table from migration001, without running the numbered
// steps — so the two shapes have to agree or one of them is wrong.
func TestFreshInstallHasTheQueueTable(t *testing.T) {
	s := openQueueStore(t)
	if got := schemaVersionOf(t, s); got != schemaVersion {
		t.Fatalf("user_version = %d, want %d", got, schemaVersion)
	}
	insertQueueTask(t, s, "task-fresh")
	if _, err := s.AppendPendingPrompt(context.Background(), PendingPrompt{
		TaskID: "task-fresh", Prompt: "queued on a fresh install",
	}); err != nil {
		t.Fatalf("a fresh install has no usable queue: %v", err)
	}
}

// Recovery asks the queue which tasks need a deliverer, because status cannot
// answer it: a task waiting on a user question keeps its status across a restart.
func TestTasksWithPendingPromptsFindsEveryQueue(t *testing.T) {
	ctx := context.Background()
	s := openQueueStore(t)
	insertQueueTask(t, s, "task-one")
	insertQueueTask(t, s, "task-two")
	insertQueueTask(t, s, "task-idle")

	for _, id := range []string{"task-one", "task-two"} {
		if _, err := s.AppendPendingPrompt(ctx, PendingPrompt{TaskID: id, Prompt: "waiting"}); err != nil {
			t.Fatal(err)
		}
	}
	got, err := s.TasksWithPendingPrompts(ctx)
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, id := range got {
		seen[id] = true
	}
	if len(got) != 2 || !seen["task-one"] || !seen["task-two"] {
		t.Fatalf("tasks with a queue = %v, want exactly the two with messages", got)
	}
	if seen["task-idle"] {
		t.Fatalf("a task with no queue was listed: %v", got)
	}

	// Draining the queue takes the task off the list: this is the answer that
	// decides whether recovery starts a run, so a stale entry starts an empty one.
	if _, _, err := s.PopPendingPrompt(ctx, "task-one"); err != nil {
		t.Fatal(err)
	}
	got, err = s.TasksWithPendingPrompts(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0] != "task-two" {
		t.Fatalf("after draining one queue = %v, want only the task still waiting", got)
	}
}
