package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/vuuihc/kin/internal/store"
)

func TestUsageSummaryAggregation(t *testing.T) {
	s, token := newTestServer(t)
	h := s.Handler()
	ctx := context.Background()

	// Seed tasks across days and agents.
	now := time.Now().UTC()
	day0 := time.Date(now.Year(), now.Month(), now.Day(), 12, 0, 0, 0, time.UTC).UnixMilli()
	day1 := day0 - 24*60*60*1000

	costA := 0.10
	costB := 0.05
	seed := []store.Task{
		{
			ID: "01USAGE00000000000000000001", Title: "c1", Agent: "claude-code",
			Cwd: "/tmp", Prompt: "p", Status: "succeeded",
			TokensIn: 100, TokensOut: 20, CostUSD: &costA, CreatedAt: day0,
		},
		{
			ID: "01USAGE00000000000000000002", Title: "c2", Agent: "claude-code",
			Cwd: "/tmp", Prompt: "p", Status: "succeeded",
			TokensIn: 50, TokensOut: 10, CostUSD: &costB, CreatedAt: day0,
		},
		{
			ID: "01USAGE00000000000000000003", Title: "x1", Agent: "codex",
			Cwd: "/tmp", Prompt: "p", Status: "succeeded",
			TokensIn: 1000, TokensOut: 50, CostUSD: ptr(0.00175), CreatedAt: day0,
		},
		{
			ID: "01USAGE00000000000000000004", Title: "r1", Agent: "rawpty",
			Cwd: "/tmp", Prompt: "printf hi", Status: "succeeded",
			TokensIn: 0, TokensOut: 0, CreatedAt: day1,
		},
		{
			ID: "01USAGE00000000000000000005", Title: "old", Agent: "claude-code",
			Cwd: "/tmp", Prompt: "p", Status: "succeeded",
			TokensIn: 999, TokensOut: 999, CostUSD: ptr(9.0),
			CreatedAt: day0 - 40*24*60*60*1000, // outside 30d window
		},
	}
	for _, task := range seed {
		if err := s.Store.InsertTask(ctx, task); err != nil {
			t.Fatal(err)
		}
	}

	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/usage/summary?days=30", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
	var rows []store.UsageRow
	if err := json.Unmarshal(rr.Body.Bytes(), &rows); err != nil {
		t.Fatal(err)
	}
	if len(rows) < 2 {
		t.Fatalf("want ≥2 rows, got %v", rows)
	}

	// Index by date|agent
	type key struct{ d, a string }
	m := map[key]store.UsageRow{}
	for _, r := range rows {
		m[key{r.Date, r.Agent}] = r
	}
	today := time.UnixMilli(day0).UTC().Format("2006-01-02")
	yest := time.UnixMilli(day1).UTC().Format("2006-01-02")

	cl := m[key{today, "claude-code"}]
	if cl.Tasks != 2 || cl.TokensIn != 150 || cl.TokensOut != 30 {
		t.Fatalf("claude today: %+v", cl)
	}
	if cl.CostUSD == nil || *cl.CostUSD < 0.14 || *cl.CostUSD > 0.16 {
		t.Fatalf("claude cost=%v", cl.CostUSD)
	}
	cx := m[key{today, "codex"}]
	if cx.Tasks != 1 || cx.TokensIn != 1000 {
		t.Fatalf("codex today: %+v", cx)
	}
	rp := m[key{yest, "rawpty"}]
	if rp.Tasks != 1 {
		t.Fatalf("rawpty yest: %+v", rp)
	}

	// Outside window must not appear as a lone old day with 999 tokens only from that task.
	for _, r := range rows {
		if r.TokensIn == 999 {
			t.Fatalf("old task leaked into window: %+v", r)
		}
	}

	// Auth required
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/usage/summary", nil))
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("no auth: %d", rr.Code)
	}
}

func TestTaskUsageEndpoint(t *testing.T) {
	s, token := newTestServer(t)
	h := s.Handler()
	ctx := context.Background()
	task := store.Task{
		ID: "01APITASKUSAGE000000000001", Title: "usage", Agent: "codex",
		Cwd: "/tmp", Prompt: "p", Status: "succeeded", CreatedAt: store.NowMilli(),
	}
	if err := s.Store.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}
	input, output, cached := 100, 10, 0
	if err := s.Store.InsertUsageRecord(ctx, store.UsageRecord{
		TaskID: task.ID, EventSeq: 1, OccurredAt: store.NowMilli(), Agent: "codex",
		InputTokens: &input, OutputTokens: &output, CacheReadTokens: &cached,
		CacheStatus: store.CacheStatusReported, InputSemantics: store.InputSemanticsTotalIncludesCache,
		CostSource: store.CostSourceUnknown,
	}); err != nil {
		t.Fatal(err)
	}

	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/tasks/"+task.ID+"/usage", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
	var usage store.TaskUsage
	if err := json.Unmarshal(rr.Body.Bytes(), &usage); err != nil {
		t.Fatal(err)
	}
	if usage.TokensIn != 100 || usage.CacheHitRate == nil || *usage.CacheHitRate != 0 || usage.CacheStatus != store.CacheStatusReported {
		t.Fatalf("usage = %+v", usage)
	}

	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/tasks/missing/usage", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusNotFound {
		t.Fatalf("missing status = %d", rr.Code)
	}
}

func TestPriceTableSettingValidation(t *testing.T) {
	s, token := newTestServer(t)
	h := s.Handler()

	// Valid
	body := `{"price_table":"{\"gpt-5-codex\":{\"in\":1.25,\"out\":10}}"}`
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPut, "/api/settings", bytes.NewReader([]byte(body)))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("valid put: %d %s", rr.Code, rr.Body.String())
	}
	var got map[string]string
	_ = json.Unmarshal(rr.Body.Bytes(), &got)
	if got["price_table"] == "" {
		t.Fatal("price_table missing from GET snapshot")
	}

	// Invalid JSON
	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPut, "/api/settings", bytes.NewReader([]byte(`{"price_table":"not-json"}`)))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("invalid json: %d", rr.Code)
	}

	// GET returns default when unset (fresh store has no price_table until we set it;
	// after invalid put it should still have the valid one from earlier).
	// Open a fresh server for default check.
	s2, token2 := newTestServer(t)
	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/settings", nil)
	req.Header.Set("Authorization", "Bearer "+token2)
	s2.Handler().ServeHTTP(rr, req)
	got = map[string]string{}
	_ = json.Unmarshal(rr.Body.Bytes(), &got)
	if _, err := store.ParsePriceTable(got["price_table"]); err != nil {
		t.Fatalf("default price_table: %v body=%q", err, got["price_table"])
	}
}

func ptr(f float64) *float64 { return &f }
