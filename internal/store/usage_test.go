package store

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"
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

func TestAppendUsageEventIsAtomic(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	task := Task{
		ID: "01USAGEATOMIC00000000000001", Title: "usage", Agent: "codex",
		Cwd: "/tmp", Prompt: "p", Status: "running", CreatedAt: NowMilli(),
	}
	if err := s.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}
	input, output, cached := 100, 10, 80
	record := UsageRecord{
		Agent: "codex", InputTokens: &input, OutputTokens: &output,
		CacheReadTokens: &cached, CacheStatus: CacheStatusReported,
		InputSemantics: InputSemanticsTotalIncludesCache, CostSource: CostSourceUnknown,
	}
	event, gotTask, err := s.AppendUsageEvent(ctx, task.ID, "usage", json.RawMessage(`{"input_tokens":100}`), record)
	if err != nil {
		t.Fatal(err)
	}
	if event.Type != "usage" || event.Seq != 1 {
		t.Fatalf("event = %+v", event)
	}
	if gotTask.TokensIn != 100 || gotTask.TokensOut != 10 {
		t.Fatalf("task tokens = %d/%d", gotTask.TokensIn, gotTask.TokensOut)
	}
	records, err := s.ListUsageRecords(ctx, task.ID)
	if err != nil || len(records) != 1 || records[0].EventSeq != event.Seq {
		t.Fatalf("records = %+v err=%v", records, err)
	}

	bad := record
	negative := -1
	bad.InputTokens = &negative
	if _, _, err := s.AppendUsageEvent(ctx, task.ID, "usage", json.RawMessage(`{"input_tokens":-1}`), bad); err == nil {
		t.Fatal("invalid usage accepted")
	}
	events, err := s.ListEvents(ctx, task.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 {
		t.Fatalf("failed transaction left %d events", len(events))
	}
}

func TestUsageSummariesRespectCacheSemanticsAndLegacyFallback(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	now := time.Now().UTC()
	today := time.Date(now.Year(), now.Month(), now.Day(), 12, 0, 0, 0, time.UTC).UnixMilli()
	yesterday := today - 24*60*60*1000
	for _, task := range []Task{
		{ID: "01USAGESUMMARYREPORTED00001", Title: "reported", Agent: "codex", Cwd: "/tmp", Prompt: "p", Status: "succeeded", CreatedAt: today},
		{ID: "01USAGESUMMARYUNKNOWN000002", Title: "unknown", Agent: "codex", Cwd: "/tmp", Prompt: "p", Status: "succeeded", CreatedAt: today},
		{ID: "01USAGESUMMARYLEGACY0000003", Title: "legacy", Agent: "codex", Cwd: "/tmp", Prompt: "p", Status: "succeeded", TokensIn: 50, TokensOut: 5, CreatedAt: today},
	} {
		if err := s.InsertTask(ctx, task); err != nil {
			t.Fatal(err)
		}
	}
	input, output, cached := 100, 10, 80
	if err := s.InsertUsageRecord(ctx, UsageRecord{
		TaskID: "01USAGESUMMARYREPORTED00001", EventSeq: 1, OccurredAt: yesterday, Agent: "codex",
		Model: strPtr("gpt-5-codex"), InputTokens: &input, OutputTokens: &output, CacheReadTokens: &cached,
		CacheStatus: CacheStatusReported, InputSemantics: InputSemanticsTotalIncludesCache, CostSource: CostSourcePriceTable,
	}); err != nil {
		t.Fatal(err)
	}
	unknownInput := 40
	if err := s.InsertUsageRecord(ctx, UsageRecord{
		TaskID: "01USAGESUMMARYUNKNOWN000002", EventSeq: 1, OccurredAt: yesterday, Agent: "codex",
		InputTokens: &unknownInput, CacheStatus: CacheStatusUnknown,
		InputSemantics: InputSemanticsUnknown, CostSource: CostSourceUnknown,
	}); err != nil {
		t.Fatal(err)
	}

	rows, err := s.UsageSummary(ctx, 2)
	if err != nil {
		t.Fatal(err)
	}
	var ledger, legacy *UsageRow
	for i := range rows {
		if rows[i].Date == time.UnixMilli(yesterday).UTC().Format("2006-01-02") {
			ledger = &rows[i]
		}
		if rows[i].Date == time.UnixMilli(today).UTC().Format("2006-01-02") {
			legacy = &rows[i]
		}
	}
	if ledger == nil || ledger.TokensIn != 140 || ledger.CacheReadTokens != 80 || ledger.RequestCount != 2 {
		t.Fatalf("ledger aggregate = %+v", ledger)
	}
	if ledger.CacheHitRate == nil || *ledger.CacheHitRate != 0.8 || ledger.CacheEligibleInputTokens != 100 || ledger.CacheCoverage == nil || *ledger.CacheCoverage < 0.71 || *ledger.CacheCoverage > 0.72 || ledger.CacheStatus != CacheStatusMixed {
		t.Fatalf("ledger cache aggregate = %+v", ledger)
	}
	if legacy == nil || legacy.TokensIn != 50 || legacy.CacheHitRate != nil || legacy.CacheStatus != CacheStatusUnknown {
		t.Fatalf("legacy aggregate = %+v", legacy)
	}

	taskUsage, err := s.TaskUsage(ctx, "01USAGESUMMARYREPORTED00001")
	if err != nil {
		t.Fatal(err)
	}
	if taskUsage.CacheHitRate == nil || *taskUsage.CacheHitRate != 0.8 || len(taskUsage.ModelSubtotals) != 1 || taskUsage.ModelSubtotals[0].Model != "gpt-5-codex" {
		t.Fatalf("task usage = %+v", taskUsage)
	}
}

func strPtr(s string) *string { return &s }
