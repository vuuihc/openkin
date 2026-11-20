package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
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

	report, err := s.DiscardPendingPrompts(ctx, "task-clear")
	if err != nil {
		t.Fatal(err)
	}
	if report == nil {
		t.Fatal("two messages were dropped without a report")
	}
	if report.Seq != 1 || report.Type != "error" {
		t.Fatalf("discard report = %+v, want the first event of the task", report)
	}
	events, err := s.ListEvents(ctx, "task-clear", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].Seq != report.Seq {
		t.Fatalf("the report is not in the transcript: %+v", events)
	}
	var payload struct {
		Count int `json:"count"`
	}
	if err := json.Unmarshal(report.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Count != 2 {
		t.Fatalf("cleared %d messages, want 2", payload.Count)
	}
	if second, err := s.DiscardPendingPrompts(ctx, "task-clear"); err != nil || second != nil {
		t.Fatalf("second clear = (%+v, %v), want (nil, nil)", second, err)
	}
}

// The delete and its report are one transaction, and this is the test that says
// so: when the report cannot be written, the messages stay where they were. The
// alternative -- a queue gone with nothing in the transcript saying so -- is the
// exact state the report exists to prevent, and a process that dies between two
// writes reaches it just as surely as a failed insert does.
func TestAFailedDiscardReportLeavesTheQueueAlone(t *testing.T) {
	ctx := context.Background()
	s := openQueueStore(t)
	insertQueueTask(t, s, "task-keep")
	if _, err := s.AppendPendingPrompt(ctx, PendingPrompt{TaskID: "task-keep", Prompt: "still mine"}); err != nil {
		t.Fatal(err)
	}
	failErrorEventWrites(t, s)

	if report, err := s.DiscardPendingPrompts(ctx, "task-keep"); err == nil {
		t.Fatalf("the discard succeeded (%+v) while its report could not be written", report)
	}
	left, err := s.ListPendingPrompts(ctx, "task-keep")
	if err != nil {
		t.Fatal(err)
	}
	if len(left) != 1 {
		t.Fatalf("the message went without a report: %+v", left)
	}
	events, err := s.ListEvents(ctx, "task-keep", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 0 {
		t.Fatalf("an event survived a rolled-back discard: %+v", events)
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
	if report, err := s.DiscardPendingPrompts(ctx, "task-blank"); err != nil || report != nil {
		t.Fatalf("rejected messages left rows behind: %+v, %v", report, err)
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

// The order a person sets is the order the agent answers in. Both reads have to
// agree -- the delivery path pops, the console lists -- and a message queued
// after a reorder joins the tail rather than the id order it was sent in.
func TestSetPendingPromptOrderPersistsAndPops(t *testing.T) {
	ctx := context.Background()
	s := openQueueStore(t)
	insertQueueTask(t, s, "task-order")
	var rows []PendingPrompt
	for _, text := range []string{"first", "second", "third"} {
		p, err := s.AppendPendingPrompt(ctx, PendingPrompt{TaskID: "task-order", Prompt: text})
		if err != nil {
			t.Fatal(err)
		}
		rows = append(rows, p)
	}

	got, err := s.SetPendingPromptOrder(ctx, "task-order",
		[]int64{rows[2].ID, rows[0].ID, rows[1].ID})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 {
		t.Fatalf("reorder returned %d rows, want the whole queue", len(got))
	}
	for i, want := range []string{"third", "first", "second"} {
		if got[i].Prompt != want || got[i].Position != int64(i+1) {
			t.Fatalf("row %d = (%q, position %d), want (%q, %d)",
				i, got[i].Prompt, got[i].Position, want, i+1)
		}
	}

	listed, err := s.ListPendingPrompts(ctx, "task-order")
	if err != nil {
		t.Fatal(err)
	}
	for i, want := range []string{"third", "first", "second"} {
		if listed[i].Prompt != want {
			t.Fatalf("list position %d = %q, want %q", i, listed[i].Prompt, want)
		}
	}

	// A later message is appended behind everything that is queued, wherever the
	// reorder put it.
	fourth, err := s.AppendPendingPrompt(ctx, PendingPrompt{TaskID: "task-order", Prompt: "fourth"})
	if err != nil {
		t.Fatal(err)
	}
	if fourth.Position != 4 {
		t.Fatalf("appended position = %d, want the tail (4)", fourth.Position)
	}
	listed, err = s.ListPendingPrompts(ctx, "task-order")
	if err != nil {
		t.Fatal(err)
	}
	if len(listed) != 4 || listed[3].Prompt != "fourth" {
		t.Fatalf("queue after append = %+v, want fourth at the tail", listed)
	}

	// The pop is the delivery order, one per turn boundary.
	for _, want := range []string{"third", "first"} {
		p, ok, err := s.PopPendingPrompt(ctx, "task-order")
		if err != nil {
			t.Fatal(err)
		}
		if !ok || p.Prompt != want {
			t.Fatalf("pop = (%q, %v), want %q", p.Prompt, ok, want)
		}
	}
	rest, err := s.ListPendingPrompts(ctx, "task-order")
	if err != nil {
		t.Fatal(err)
	}
	if len(rest) != 2 || rest[0].Prompt != "second" || rest[1].Prompt != "fourth" {
		t.Fatalf("remaining queue = %+v, want second then fourth", rest)
	}
	// A delivery leaves a hole: positions order the queue, they are not indices.
	if rest[0].Position != 3 || rest[1].Position != 4 {
		t.Fatalf("positions after a pop = %d, %d; want them left as written",
			rest[0].Position, rest[1].Position)
	}
}

func queueTableShape(t *testing.T, s *Store) []string {
	t.Helper()
	rows, err := s.db.Query(`
		SELECT name, type, "notnull", COALESCE(dflt_value, ''), pk
		FROM pragma_table_info('task_pending_prompts') ORDER BY cid`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var name, typ, dflt string
		var notNull, pk int
		if err := rows.Scan(&name, &typ, &notNull, &dflt, &pk); err != nil {
			t.Fatal(err)
		}
		out = append(out, fmt.Sprintf("%s|%s|%d|%s|%d", name, typ, notNull, dflt, pk))
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

// Migration 050 adds the delivery-order column without disturbing the order a
// database already has: every existing row shares position 0, so the id
// tiebreak reproduces the old ORDER BY id. The upgraded path and the fresh
// install have to reach the same table shape.
func TestMigration050KeepsExistingPendingPromptOrder(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "kin.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	insertQueueTask(t, s, "task-v49")
	// The v49 table, with three messages queued by that build.
	if _, err := s.db.ExecContext(ctx, `
		DROP TABLE task_pending_prompts;
		CREATE TABLE task_pending_prompts (
		  id              INTEGER PRIMARY KEY AUTOINCREMENT,
		  task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
		  prompt          TEXT NOT NULL,
		  agent           TEXT NOT NULL DEFAULT '',
		  model           TEXT,
		  permission_mode TEXT,
		  user_seq        INTEGER NOT NULL DEFAULT 0,
		  queued_at       INTEGER NOT NULL
		);
		CREATE INDEX idx_task_pending_prompts_queue ON task_pending_prompts(task_id, id);
		INSERT INTO task_pending_prompts (task_id, prompt, user_seq, queued_at)
		VALUES ('task-v49', 'first', 0, 1),
		       ('task-v49', 'second', 0, 2),
		       ('task-v49', 'third', 0, 3);
		PRAGMA user_version = 49;`); err != nil {
		t.Fatalf("recreate the v49 queue: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	upgraded, err := Open(path)
	if err != nil {
		t.Fatalf("reopen at version 49: %v", err)
	}
	t.Cleanup(func() { _ = upgraded.Close() })
	if got := schemaVersionOf(t, upgraded); got != schemaVersion {
		t.Fatalf("user_version after upgrade = %d, want %d", got, schemaVersion)
	}

	kept, err := upgraded.ListPendingPrompts(ctx, "task-v49")
	if err != nil {
		t.Fatalf("the upgraded queue cannot be read: %v", err)
	}
	if len(kept) != 3 {
		t.Fatalf("queue holds %d messages after the upgrade, want 3", len(kept))
	}
	for i, want := range []string{"first", "second", "third"} {
		if kept[i].Prompt != want || kept[i].Position != 0 {
			t.Fatalf("row %d = (%q, position %d), want (%q, 0)",
				i, kept[i].Prompt, kept[i].Position, want)
		}
	}
	// A message queued after the upgrade joins the tail.
	tail, err := upgraded.AppendPendingPrompt(ctx, PendingPrompt{TaskID: "task-v49", Prompt: "fourth"})
	if err != nil {
		t.Fatal(err)
	}
	if tail.Position != 1 {
		t.Fatalf("appended position on an upgraded database = %d, want 1", tail.Position)
	}

	fresh := openQueueStore(t)
	upgradedShape := queueTableShape(t, upgraded)
	freshShape := queueTableShape(t, fresh)
	if len(upgradedShape) != len(freshShape) {
		t.Fatalf("upgraded shape = %v, fresh shape = %v", upgradedShape, freshShape)
	}
	for i := range freshShape {
		if upgradedShape[i] != freshShape[i] {
			t.Fatalf("column %d differs: upgraded %q, fresh %q", i, upgradedShape[i], freshShape[i])
		}
	}
}

func TestWithdrawingAQueuedMessageLeavesANoteAndNoCopy(t *testing.T) {
	ctx := context.Background()
	s := openQueueStore(t)
	insertQueueTask(t, s, "task-w")
	other := PendingPrompt{TaskID: "task-w", Prompt: "the typo I regret"}
	if _, err := s.AppendPendingPrompt(ctx, other); err != nil {
		t.Fatal(err)
	}
	if err := s.InsertTask(ctx, Task{
		ID: "task-other", Title: "Other", Agent: "claude-code", Cwd: "/work/app",
		Prompt: "start", Status: "running", CreatedAt: time.Now().UnixMilli(),
	}); err != nil {
		t.Fatal(err)
	}
	kept, err := s.AppendPendingPrompt(ctx, PendingPrompt{TaskID: "task-other", Prompt: "not this one"})
	if err != nil {
		t.Fatal(err)
	}

	// Another task's id does not reach the row, whatever the prompt id says.
	note, removed, err := s.WithdrawPendingPrompt(ctx, "task-w", kept.ID)
	if err != nil {
		t.Fatal(err)
	}
	if removed || note != nil {
		t.Fatalf("cross-task withdraw = (%+v, %v), want it refused", note, removed)
	}

	queued, err := s.ListPendingPrompts(ctx, "task-w")
	if err != nil || len(queued) != 1 {
		t.Fatalf("queue after refused withdraw = %+v err %v, want the row still there", queued, err)
	}

	withdrawnID := queued[0].ID
	note, removed, err = s.WithdrawPendingPrompt(ctx, "task-w", withdrawnID)
	if err != nil {
		t.Fatal(err)
	}
	if !removed || note == nil {
		t.Fatalf("withdraw = (%+v, %v), want a note", note, removed)
	}
	if note.Type != "notice" {
		t.Fatalf("note type = %q, want notice", note.Type)
	}
	if strings.Contains(string(note.Payload), "the typo I regret") {
		t.Fatalf("note repeats the withdrawn text: %s", note.Payload)
	}
	if left, err := s.ListPendingPrompts(ctx, "task-w"); err != nil || len(left) != 0 {
		t.Fatalf("queue after withdraw = %+v err %v, want it empty", left, err)
	}
	// The other task's queue is untouched.
	if left, err := s.ListPendingPrompts(ctx, "task-other"); err != nil || len(left) != 1 {
		t.Fatalf("other queue = %+v err %v, want its one message", left, err)
	}

	// A second withdraw of the same row is a no-op with no second note.
	note, removed, err = s.WithdrawPendingPrompt(ctx, "task-w", withdrawnID)
	if err != nil {
		t.Fatal(err)
	}
	if removed || note != nil {
		t.Fatalf("second withdraw = (%+v, %v), want nothing", note, removed)
	}
	events, err := s.ListEvents(ctx, "task-w", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 {
		t.Fatalf("events = %+v, want exactly the one withdrawal note", events)
	}
}
