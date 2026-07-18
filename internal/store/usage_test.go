package store

import (
	"context"
	"path/filepath"
	"testing"
)

func TestMigrateV4UsageLedger(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "kin.db")

	// Build a populated v4 database, then remove the v5-only table before
	// reopening it through the migration path.
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	now := NowMilli()
	if err := s.InsertTask(ctx, Task{
		ID: "01USAGELEDGERMIGRATE0000001", Title: "existing", Agent: "codex",
		Cwd: "/tmp", Prompt: "p", Status: "succeeded", CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB().Exec(`DROP TABLE usage_records; PRAGMA user_version = 4`); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	var version int
	if err := s.DB().QueryRow(`PRAGMA user_version`).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if version != 5 {
		t.Fatalf("schema version = %d, want 5", version)
	}
	var name string
	if err := s.DB().QueryRow(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usage_records'`).Scan(&name); err != nil {
		t.Fatalf("usage_records missing: %v", err)
	}
	if _, err := s.GetTask(ctx, "01USAGELEDGERMIGRATE0000001"); err != nil {
		t.Fatalf("existing task unreadable after migration: %v", err)
	}
}

func TestUsageRecordsPersistAndValidate(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	task := Task{
		ID: "01USAGELEDGERRECORD00000001", Title: "usage", Agent: "codex",
		Cwd: "/tmp", Prompt: "p", Status: "succeeded", CreatedAt: NowMilli(),
	}
	if err := s.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}
	zero := 0
	input := 100
	reported := UsageRecord{
		TaskID:          task.ID,
		EventSeq:        1,
		OccurredAt:      NowMilli(),
		Agent:           "codex",
		InputTokens:     &input,
		CacheReadTokens: &zero,
		CacheStatus:     CacheStatusReported,
		InputSemantics:  InputSemanticsTotalIncludesCache,
		CostSource:      CostSourceUnknown,
	}
	if err := s.InsertUsageRecord(ctx, reported); err != nil {
		t.Fatal(err)
	}
	unknown := UsageRecord{
		TaskID:         task.ID,
		EventSeq:       2,
		OccurredAt:     NowMilli(),
		Agent:          "rawpty",
		CacheStatus:    CacheStatusUnknown,
		InputSemantics: InputSemanticsUnknown,
		CostSource:     CostSourceUnknown,
	}
	if err := s.InsertUsageRecord(ctx, unknown); err != nil {
		t.Fatal(err)
	}

	got, err := s.ListUsageRecords(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("records = %d, want 2", len(got))
	}
	if got[0].CacheReadTokens == nil || *got[0].CacheReadTokens != 0 || got[0].CacheStatus != CacheStatusReported {
		t.Fatalf("reported zero cache was not preserved: %+v", got[0])
	}
	if got[1].CacheReadTokens != nil || got[1].CacheStatus != CacheStatusUnknown {
		t.Fatalf("unknown cache was not preserved: %+v", got[1])
	}

	if err := s.InsertUsageRecord(ctx, reported); err == nil {
		t.Fatal("duplicate task_id/event_seq accepted")
	}

	negative := -1
	bad := reported
	bad.EventSeq = 3
	bad.InputTokens = &negative
	if err := s.InsertUsageRecord(ctx, bad); err == nil {
		t.Fatal("negative tokens accepted")
	}
	bad = reported
	bad.EventSeq = 3
	bad.CacheStatus = "invalid"
	if err := s.InsertUsageRecord(ctx, bad); err == nil {
		t.Fatal("invalid cache status accepted")
	}
}

func TestUsageRecordsCascadeWhenTaskDeleted(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	task := Task{
		ID: "01USAGELEDGERCASCADE000001", Title: "usage", Agent: "kin",
		Cwd: "/tmp", Prompt: "p", Status: "succeeded", CreatedAt: NowMilli(),
	}
	if err := s.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}
	if err := s.InsertUsageRecord(ctx, UsageRecord{
		TaskID: task.ID, EventSeq: 1, OccurredAt: NowMilli(), Agent: "kin",
		CacheStatus: CacheStatusUnsupported, InputSemantics: InputSemanticsUnknown,
		CostSource: CostSourceUnknown,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB().ExecContext(ctx, `DELETE FROM tasks WHERE id = ?`, task.ID); err != nil {
		t.Fatalf("delete task: %v", err)
	}
	var count int
	if err := s.DB().QueryRowContext(ctx, `SELECT COUNT(*) FROM usage_records WHERE task_id = ?`, task.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("usage records remain after task delete: %d", count)
	}
}
