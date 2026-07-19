package store

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"
)

// ---- AgentLimit tests ----

func TestAgentLimitsRoundTrip(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	// Absent key returns empty map, not error.
	got, err := s.GetAgentLimits(ctx)
	if err != nil {
		t.Fatalf("GetAgentLimits on empty: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("expected empty map, got %v", got)
	}

	// Round-trip a valid limit map.
	spendLimit := 10.0
	tokensLimit := int64(500000)
	limits := map[string]AgentLimit{
		"claude-code": {SpendUSDDaily: &spendLimit, TokensDaily: &tokensLimit},
		"codex":       {},
	}
	if err := s.SetAgentLimits(ctx, limits); err != nil {
		t.Fatalf("SetAgentLimits: %v", err)
	}
	got, err = s.GetAgentLimits(ctx)
	if err != nil {
		t.Fatalf("GetAgentLimits after set: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 limits, got %v", got)
	}
	cl := got["claude-code"]
	if cl.SpendUSDDaily == nil || *cl.SpendUSDDaily != 10.0 {
		t.Fatalf("claude-code spend limit = %v", cl.SpendUSDDaily)
	}
	if cl.TokensDaily == nil || *cl.TokensDaily != 500000 {
		t.Fatalf("claude-code tokens limit = %v", cl.TokensDaily)
	}
	if got["codex"].SpendUSDDaily != nil || got["codex"].TokensDaily != nil {
		t.Fatalf("codex should have no limits, got %v", got["codex"])
	}
}

func TestAgentLimitsValidation(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	// Reject negative spend.
	negSpend := -1.0
	if err := s.SetAgentLimits(ctx, map[string]AgentLimit{
		"bad-agent": {SpendUSDDaily: &negSpend},
	}); err == nil {
		t.Fatal("expected error for negative spend limit")
	}

	// Reject negative tokens.
	negTokens := int64(-100)
	if err := s.SetAgentLimits(ctx, map[string]AgentLimit{
		"bad-agent": {TokensDaily: &negTokens},
	}); err == nil {
		t.Fatal("expected error for negative tokens limit")
	}
}

func TestAgentLimitStatusesAggregation(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	// Timestamps in local time for day-boundary tests.
	now := time.Now()
	todayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.Local)
	todayMid := todayStart.Add(12 * time.Hour)
	yesterdayMid := todayStart.Add(-12 * time.Hour)

	todayMS := todayMid.UnixMilli()
	yesterdayMS := yesterdayMid.UnixMilli()

	// Insert tasks (needed for usage_records FK).
	for _, task := range []Task{
		{ID: "01AGENTLIMIT0000000000001", Title: "t1", Agent: "claude-code", Cwd: "/tmp", Prompt: "p", Status: "succeeded", CreatedAt: todayMS},
		{ID: "01AGENTLIMIT0000000000002", Title: "t2", Agent: "codex", Cwd: "/tmp", Prompt: "p", Status: "succeeded", CreatedAt: yesterdayMS},
		{ID: "01AGENTLIMIT0000000000003", Title: "t3", Agent: "grok", Cwd: "/tmp", Prompt: "p", Status: "succeeded", CreatedAt: todayMS},
	} {
		if err := s.InsertTask(ctx, task); err != nil {
			t.Fatal(err)
		}
	}

	input, output := 300, 100
	cost := 0.05
	// Today's usage for claude-code.
	if err := s.InsertUsageRecord(ctx, UsageRecord{
		TaskID: "01AGENTLIMIT0000000000001", EventSeq: 1, OccurredAt: todayMS,
		Agent: "claude-code", InputTokens: &input, OutputTokens: &output,
		CostUSD: &cost, CacheStatus: CacheStatusUnknown,
		InputSemantics: InputSemanticsUnknown, CostSource: CostSourceProvider,
	}); err != nil {
		t.Fatal(err)
	}
	// Yesterday's usage for codex — must NOT appear in today's totals.
	yesterdayCost := 9.99
	yesterdayInput := 1000000
	if err := s.InsertUsageRecord(ctx, UsageRecord{
		TaskID: "01AGENTLIMIT0000000000002", EventSeq: 1, OccurredAt: yesterdayMS,
		Agent: "codex", InputTokens: &yesterdayInput, CostUSD: &yesterdayCost,
		CacheStatus: CacheStatusUnknown, InputSemantics: InputSemanticsUnknown,
		CostSource: CostSourceProvider,
	}); err != nil {
		t.Fatal(err)
	}
	// Today's grok — usage but no limit configured.
	grokInput := 50
	if err := s.InsertUsageRecord(ctx, UsageRecord{
		TaskID: "01AGENTLIMIT0000000000003", EventSeq: 1, OccurredAt: todayMS,
		Agent: "grok", InputTokens: &grokInput,
		CacheStatus: CacheStatusUnknown, InputSemantics: InputSemanticsUnknown,
		CostSource: CostSourceUnknown,
	}); err != nil {
		t.Fatal(err)
	}

	// Configure limits for claude-code only.
	spendLimit := 0.10
	tokensLimit := int64(1000)
	if err := s.SetAgentLimits(ctx, map[string]AgentLimit{
		"claude-code": {SpendUSDDaily: &spendLimit, TokensDaily: &tokensLimit},
	}); err != nil {
		t.Fatal(err)
	}

	statuses, err := s.AgentLimitStatuses(ctx)
	if err != nil {
		t.Fatal(err)
	}

	// Index by agent.
	byAgent := map[string]AgentLimitStatus{}
	for _, st := range statuses {
		byAgent[st.Agent] = st
	}

	// claude-code: used 0.05 spend (50% of 0.10) → ok, used 400 tokens (40% of 1000) → ok.
	cl := byAgent["claude-code"]
	if cl.UsedSpendUSD < 0.049 || cl.UsedSpendUSD > 0.051 {
		t.Fatalf("claude-code spend = %v", cl.UsedSpendUSD)
	}
	if cl.UsedTokens != 400 { // 300 input + 100 output
		t.Fatalf("claude-code tokens = %d", cl.UsedTokens)
	}
	if cl.Status != "ok" {
		t.Fatalf("claude-code status = %q", cl.Status)
	}

	// grok: usage today, no limit → should appear with nil limits, status ok.
	gr := byAgent["grok"]
	if gr.LimitSpendUSD != nil || gr.LimitTokens != nil {
		t.Fatalf("grok should have no limits: %+v", gr)
	}
	if gr.Status != "ok" {
		t.Fatalf("grok status = %q", gr.Status)
	}

	// codex: yesterday's usage must NOT appear in today's totals; no limit.
	if _, ok := byAgent["codex"]; ok {
		t.Fatalf("codex appeared in today's statuses (yesterday usage should be excluded): %+v", byAgent)
	}
}

func TestAgentLimitStatusesZeroUsage(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	// Agent has a limit but zero usage today → should appear with used=0 and status=ok.
	spendLimit := 5.0
	if err := s.SetAgentLimits(ctx, map[string]AgentLimit{
		"no-usage-agent": {SpendUSDDaily: &spendLimit},
	}); err != nil {
		t.Fatal(err)
	}

	statuses, err := s.AgentLimitStatuses(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(statuses) != 1 {
		t.Fatalf("expected 1 status, got %v", statuses)
	}
	st := statuses[0]
	if st.Agent != "no-usage-agent" {
		t.Fatalf("wrong agent: %s", st.Agent)
	}
	if st.UsedSpendUSD != 0 {
		t.Fatalf("expected 0 spend, got %v", st.UsedSpendUSD)
	}
	if st.Status != "ok" {
		t.Fatalf("expected ok, got %q", st.Status)
	}
}

func TestAgentLimitStatusesThresholds(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	now := time.Now()
	todayMid := time.Date(now.Year(), now.Month(), now.Day(), 12, 0, 0, 0, time.Local).UnixMilli()

	// Three agents — one at 79%, one at 80%, one at 100%.
	limit := 10.0
	tasks := []Task{
		{ID: "01THRESHOLD000000000000001", Title: "t1", Agent: "agent-79", Cwd: "/tmp", Prompt: "p", Status: "succeeded", CreatedAt: todayMid},
		{ID: "01THRESHOLD000000000000002", Title: "t2", Agent: "agent-80", Cwd: "/tmp", Prompt: "p", Status: "succeeded", CreatedAt: todayMid},
		{ID: "01THRESHOLD000000000000003", Title: "t3", Agent: "agent-100", Cwd: "/tmp", Prompt: "p", Status: "succeeded", CreatedAt: todayMid},
	}
	for _, task := range tasks {
		if err := s.InsertTask(ctx, task); err != nil {
			t.Fatal(err)
		}
	}
	costs := map[string]float64{
		"01THRESHOLD000000000000001": 7.9,  // 79% of 10
		"01THRESHOLD000000000000002": 8.0,  // 80% of 10
		"01THRESHOLD000000000000003": 10.0, // 100% of 10
	}
	seq := 1
	for taskID, cost := range costs {
		c := cost
		if err := s.InsertUsageRecord(ctx, UsageRecord{
			TaskID: taskID, EventSeq: seq, OccurredAt: todayMid,
			Agent:          tasks[seq-1].Agent,
			CostUSD:        &c,
			CacheStatus:    CacheStatusUnknown,
			InputSemantics: InputSemanticsUnknown,
			CostSource:     CostSourceProvider,
		}); err != nil {
			t.Fatal(err)
		}
		seq++
	}

	if err := s.SetAgentLimits(ctx, map[string]AgentLimit{
		"agent-79":  {SpendUSDDaily: &limit},
		"agent-80":  {SpendUSDDaily: &limit},
		"agent-100": {SpendUSDDaily: &limit},
	}); err != nil {
		t.Fatal(err)
	}

	statuses, err := s.AgentLimitStatuses(ctx)
	if err != nil {
		t.Fatal(err)
	}
	byAgent := map[string]AgentLimitStatus{}
	for _, st := range statuses {
		byAgent[st.Agent] = st
	}

	if byAgent["agent-79"].Status != "ok" {
		t.Fatalf("79%% should be ok, got %q", byAgent["agent-79"].Status)
	}
	if byAgent["agent-80"].Status != "warn" {
		t.Fatalf("80%% should be warn, got %q", byAgent["agent-80"].Status)
	}
	if byAgent["agent-100"].Status != "over" {
		t.Fatalf("100%% should be over, got %q", byAgent["agent-100"].Status)
	}
}

func TestAgentLimitStatusesSeverityMax(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	now := time.Now()
	todayMid := time.Date(now.Year(), now.Month(), now.Day(), 12, 0, 0, 0, time.Local).UnixMilli()

	if err := s.InsertTask(ctx, Task{
		ID: "01SEVERITYMAX000000000001", Title: "t", Agent: "mixed-agent",
		Cwd: "/tmp", Prompt: "p", Status: "succeeded", CreatedAt: todayMid,
	}); err != nil {
		t.Fatal(err)
	}

	// Spend at 50% (ok), tokens at 90% (warn) → overall warn.
	cost := 5.0
	input, output := 450, 0
	if err := s.InsertUsageRecord(ctx, UsageRecord{
		TaskID: "01SEVERITYMAX000000000001", EventSeq: 1, OccurredAt: todayMid,
		Agent: "mixed-agent", CostUSD: &cost, InputTokens: &input, OutputTokens: &output,
		CacheStatus: CacheStatusUnknown, InputSemantics: InputSemanticsUnknown,
		CostSource: CostSourceProvider,
	}); err != nil {
		t.Fatal(err)
	}

	spendLimit := 10.0
	tokensLimit := int64(500)
	if err := s.SetAgentLimits(ctx, map[string]AgentLimit{
		"mixed-agent": {SpendUSDDaily: &spendLimit, TokensDaily: &tokensLimit},
	}); err != nil {
		t.Fatal(err)
	}

	statuses, err := s.AgentLimitStatuses(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(statuses) != 1 || statuses[0].Status != "warn" {
		t.Fatalf("expected warn (tokens at 90%%), got %+v", statuses)
	}
}

func TestAgentLimitStatusesDayBoundary(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	now := time.Now()
	todayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.Local)
	yesterdayMS := todayStart.Add(-1 * time.Millisecond).UnixMilli()

	if err := s.InsertTask(ctx, Task{
		ID: "01DAYBOUNDARY00000000001", Title: "t", Agent: "boundary-agent",
		Cwd: "/tmp", Prompt: "p", Status: "succeeded", CreatedAt: yesterdayMS,
	}); err != nil {
		t.Fatal(err)
	}

	cost := 50.0
	if err := s.InsertUsageRecord(ctx, UsageRecord{
		TaskID: "01DAYBOUNDARY00000000001", EventSeq: 1, OccurredAt: yesterdayMS,
		Agent: "boundary-agent", CostUSD: &cost,
		CacheStatus: CacheStatusUnknown, InputSemantics: InputSemanticsUnknown,
		CostSource: CostSourceProvider,
	}); err != nil {
		t.Fatal(err)
	}

	spendLimit := 10.0
	if err := s.SetAgentLimits(ctx, map[string]AgentLimit{
		"boundary-agent": {SpendUSDDaily: &spendLimit},
	}); err != nil {
		t.Fatal(err)
	}

	statuses, err := s.AgentLimitStatuses(ctx)
	if err != nil {
		t.Fatal(err)
	}
	// Agent has limit but yesterday's $50 must NOT count — used=0, status=ok.
	if len(statuses) != 1 {
		t.Fatalf("expected 1 status, got %v", statuses)
	}
	st := statuses[0]
	if st.UsedSpendUSD != 0 {
		t.Fatalf("yesterday's cost leaked into today: %v", st.UsedSpendUSD)
	}
	if st.Status != "ok" {
		t.Fatalf("expected ok, got %q", st.Status)
	}
}

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
	// Downgrade to a v4-shaped schema: no usage_records, no workspace columns.
	// Fresh DBs already include later columns; strip them so migration 005/006 can apply.
	if _, err := s.DB().Exec(`
		DROP TABLE usage_records;
		ALTER TABLE tasks DROP COLUMN workspace_mode;
		ALTER TABLE tasks DROP COLUMN workspace_source_root;
		ALTER TABLE tasks DROP COLUMN workspace_root;
		ALTER TABLE tasks DROP COLUMN execution_cwd;
		ALTER TABLE tasks DROP COLUMN workspace_scope;
		ALTER TABLE tasks DROP COLUMN workspace_base_oid;
		ALTER TABLE tasks DROP COLUMN workspace_branch;
		DROP TABLE IF EXISTS task_checkpoints;
		PRAGMA user_version = 4;
	`); err != nil {
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
	if version != schemaVersion {
		t.Fatalf("schema version = %d, want %d", version, schemaVersion)
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
