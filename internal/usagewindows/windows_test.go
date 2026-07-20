package usagewindows

import (
	"context"
	"net/http"
	"testing"
	"time"
)

func TestParseCodexHeaders(t *testing.T) {
	h := http.Header{}
	h.Set("x-codex-plan-type", "plus")
	h.Set("x-codex-primary-used-percent", "100")
	h.Set("x-codex-primary-window-minutes", "10080")
	h.Set("x-codex-primary-reset-at", "1784969219")
	h.Set("x-codex-secondary-used-percent", "0")
	h.Set("x-codex-secondary-window-minutes", "0") // inactive -> skipped

	prov := parseCodexHeaders(h)
	if prov.Provider != "codex" || prov.Plan != "plus" {
		t.Fatalf("provider/plan = %q/%q", prov.Provider, prov.Plan)
	}
	if len(prov.Windows) != 1 {
		t.Fatalf("want 1 window (secondary skipped), got %d: %+v", len(prov.Windows), prov.Windows)
	}
	w := prov.Windows[0]
	if w.Kind != "weekly" || w.UsedPercent != 100 || w.Status != "over" || w.ResetAt != 1784969219 {
		t.Fatalf("window = %+v", w)
	}
}

func TestParseCodexHeaders5hAndWeeklySorted(t *testing.T) {
	h := http.Header{}
	// Put weekly in "primary" and 5h in "secondary" to prove sorting is by kind.
	h.Set("x-codex-primary-used-percent", "12")
	h.Set("x-codex-primary-window-minutes", "10080")
	h.Set("x-codex-secondary-used-percent", "85")
	h.Set("x-codex-secondary-window-minutes", "300")

	prov := parseCodexHeaders(h)
	if len(prov.Windows) != 2 {
		t.Fatalf("want 2 windows, got %d", len(prov.Windows))
	}
	if prov.Windows[0].Kind != "5h" || prov.Windows[1].Kind != "weekly" {
		t.Fatalf("windows not sorted shortest-first: %+v", prov.Windows)
	}
	if prov.Windows[0].Status != "warn" {
		t.Fatalf("5h at 85%% should be warn, got %q", prov.Windows[0].Status)
	}
}

func TestParseClaudeHeaders(t *testing.T) {
	h := http.Header{}
	h.Set("anthropic-ratelimit-unified-5h-utilization", "0.67")
	h.Set("anthropic-ratelimit-unified-5h-reset", "1784449800")
	h.Set("anthropic-ratelimit-unified-7d-utilization", "0.12")
	h.Set("anthropic-ratelimit-unified-7d-reset", "1784890800")

	prov := parseClaudeHeaders(h, "pro")
	if prov.Provider != "claude" || prov.Plan != "pro" {
		t.Fatalf("provider/plan = %q/%q", prov.Provider, prov.Plan)
	}
	if len(prov.Windows) != 2 {
		t.Fatalf("want 2 windows, got %d", len(prov.Windows))
	}
	five := prov.Windows[0]
	if five.Kind != "5h" || five.ResetAt != 1784449800 {
		t.Fatalf("5h window = %+v", five)
	}
	if got := round2(five.UsedPercent); got != 67 {
		t.Fatalf("5h utilization 0.67 -> %v, want 67", got)
	}
	if five.Status != "ok" {
		t.Fatalf("67%% should be ok, got %q", five.Status)
	}
	week := prov.Windows[1]
	if week.Kind != "weekly" || round2(week.UsedPercent) != 12 {
		t.Fatalf("weekly window = %+v", week)
	}
}

func TestParseClaudeHeadersMissingSkipped(t *testing.T) {
	h := http.Header{}
	h.Set("anthropic-ratelimit-unified-5h-utilization", "0.5")
	prov := parseClaudeHeaders(h, "")
	if len(prov.Windows) != 1 || prov.Windows[0].Kind != "5h" {
		t.Fatalf("want only 5h window, got %+v", prov.Windows)
	}
}

func TestStatusFromPercentBoundaries(t *testing.T) {
	cases := map[float64]string{79: "ok", 80: "warn", 99.9: "warn", 100: "over", 150: "over"}
	for pct, want := range cases {
		if got := statusFromPercent(pct); got != want {
			t.Errorf("statusFromPercent(%v) = %q, want %q", pct, got, want)
		}
	}
}

func TestWindowKind(t *testing.T) {
	cases := map[int64]string{0: "", -5: "", 300: "5h", 299: "5h", 10080: "weekly", 1440: "weekly"}
	for min, want := range cases {
		if got := windowKind(min); got != want {
			t.Errorf("windowKind(%d) = %q, want %q", min, got, want)
		}
	}
}

// fakeProber returns a canned Provider and counts probes.
type fakeProber struct {
	id    string
	prov  Provider
	err   error
	calls int
}

func (f *fakeProber) ID() string { return f.id }
func (f *fakeProber) Probe(context.Context) (Provider, error) {
	f.calls++
	return f.prov, f.err
}

func TestServiceCachesWithinTTL(t *testing.T) {
	fp := &fakeProber{id: "codex", prov: Provider{Provider: "codex", Plan: "plus"}}
	svc := New(time.Minute, fp)
	now := time.Unix(1000, 0)
	svc.now = func() time.Time { return now }

	_ = svc.Statuses(context.Background())
	_ = svc.Statuses(context.Background())
	if fp.calls != 1 {
		t.Fatalf("expected 1 probe within TTL, got %d", fp.calls)
	}

	now = now.Add(2 * time.Minute) // past TTL
	_ = svc.Statuses(context.Background())
	if fp.calls != 2 {
		t.Fatalf("expected re-probe after TTL, got %d calls", fp.calls)
	}
}

func TestServiceFoldsErrorAndStampsTime(t *testing.T) {
	fp := &fakeProber{id: "claude", prov: Provider{}, err: errFake}
	svc := New(0, fp) // no cache
	now := time.Unix(2000, 0)
	svc.now = func() time.Time { return now }

	got := svc.Statuses(context.Background())
	if len(got) != 1 {
		t.Fatalf("want 1 provider, got %d", len(got))
	}
	p := got[0]
	if p.Provider != "claude" {
		t.Fatalf("provider id not backfilled: %q", p.Provider)
	}
	if p.Error != "boom" {
		t.Fatalf("error not folded: %q", p.Error)
	}
	if p.UpdatedAt != 2000 {
		t.Fatalf("UpdatedAt = %d, want 2000", p.UpdatedAt)
	}
}

var errFake = fakeErr("boom")

type fakeErr string

func (e fakeErr) Error() string { return string(e) }

func round2(f float64) float64 {
	return float64(int64(f*100+0.5)) / 100
}

func TestServiceDoesNotCacheErrors(t *testing.T) {
	fp := &fakeProber{id: "claude", prov: Provider{Error: "claude token expired; re-login"}}
	svc := New(time.Minute, fp)
	now := time.Unix(1000, 0)
	svc.now = func() time.Time { return now }

	_ = svc.Statuses(context.Background())
	if fp.calls != 1 {
		t.Fatalf("calls = %d", fp.calls)
	}
	// Still within TTL, but error must not be cached.
	_ = svc.Statuses(context.Background())
	if fp.calls != 2 {
		t.Fatalf("expected re-probe after error, got %d calls", fp.calls)
	}

	// Successful result is cached.
	fp.prov = Provider{Provider: "claude", Windows: []Window{{Kind: "5h", UsedPercent: 1, Status: "ok"}}}
	_ = svc.Statuses(context.Background())
	if fp.calls != 3 {
		t.Fatalf("calls after success = %d", fp.calls)
	}
	_ = svc.Statuses(context.Background())
	if fp.calls != 3 {
		t.Fatalf("expected cache hit after success, got %d calls", fp.calls)
	}
}
