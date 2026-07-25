package task

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"github.com/vuuihc/kin/internal/adapter"
	"github.com/vuuihc/kin/internal/store"
	"github.com/vuuihc/kin/internal/usagewindows"
)

func TestNormalizeLimitPolicy(t *testing.T) {
	cases := map[string]string{
		"": "wait", "WAIT": "wait", "sticky": "wait",
		"ask": "ask", "switch": "switch", "nope": "wait",
	}
	for in, want := range cases {
		if got := NormalizeLimitPolicy(in); got != want {
			t.Errorf("NormalizeLimitPolicy(%q)=%q want %q", in, got, want)
		}
	}
}

func TestDefaultPolicyAutoWaits(t *testing.T) {
	ad := &multiRunAdapter{}
	e := limitTestEngine(t, map[string]adapter.Adapter{"claude-code": ad})
	// default wait, short reset_at in multiRunAdapter
	ctx := context.Background()
	task, err := e.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: "/tmp", Prompt: "x"})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusFailed, 3*time.Second)
	// Should auto-continue without user action.
	final := waitStatus(t, e, task.ID, StatusSucceeded, 8*time.Second)
	if final.Status != StatusSucceeded {
		t.Fatalf("status=%s", final.Status)
	}
}

func TestSwitchPolicyHandoff(t *testing.T) {
	ad := &multiRunAdapter{}
	codex := &fakeAdapter{events: []adapter.Event{
		{Type: "message", Payload: mustJSON(map[string]any{
			"role": "assistant", "content": []map[string]string{{"type": "text", "text": "codex"}}, "partial": false,
		})},
		{Type: "result", Payload: mustJSON(map[string]any{"is_error": false, "result": "ok"})},
	}}
	e := limitTestEngine(t, map[string]adapter.Adapter{
		"claude-code": ad,
		"codex":       codex,
	})
	setLimitPolicy(t, e, LimitPolicySwitch)
	ctx := context.Background()
	task, err := e.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: "/tmp", Prompt: "x"})
	if err != nil {
		t.Fatal(err)
	}
	// After limit, policy switches to codex and should succeed.
	final := waitStatus(t, e, task.ID, StatusSucceeded, 5*time.Second)
	if final.Agent != "codex" {
		// Agent may update after handoff; re-get
		got, _ := e.Get(ctx, task.ID)
		if got.Agent != "codex" {
			t.Fatalf("agent=%s status=%s", got.Agent, final.Status)
		}
	}
}

type stubWindows struct {
	providers []usagewindows.Provider
}

func (s stubWindows) Statuses(ctx context.Context) []usagewindows.Provider {
	return s.providers
}

func TestPreflightBlocksOverWindow(t *testing.T) {
	ad := &multiRunAdapter{}
	e := limitTestEngine(t, map[string]adapter.Adapter{"claude-code": ad})
	setLimitPolicy(t, e, LimitPolicyAsk)
	e.SetUsageWindows(stubWindows{providers: []usagewindows.Provider{{
		Provider: "claude",
		Windows: []usagewindows.Window{{
			Kind: "5h", UsedPercent: 100, Status: "over", ResetAt: time.Now().Add(time.Hour).Unix(),
		}},
	}}})
	ctx := context.Background()
	task, err := e.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: "/tmp", Prompt: "x"})
	if err != nil {
		t.Fatal(err)
	}
	final := waitStatus(t, e, task.ID, StatusFailed, 3*time.Second)
	if final.Status != StatusFailed {
		t.Fatalf("status=%s", final.Status)
	}
	if ad.calls != 0 {
		t.Fatalf("adapter should not start when preflight blocks, calls=%d", ad.calls)
	}
	evs, _ := e.Events(ctx, task.ID, 0)
	var hit bool
	for _, ev := range evs {
		if ev.Type == "limit_hit" {
			hit = true
			var m map[string]any
			_ = json.Unmarshal(ev.Payload, &m)
			if m["source"] != "usage_window" {
				t.Fatalf("source=%v", m["source"])
			}
		}
	}
	if !hit {
		t.Fatal("expected limit_hit from preflight")
	}
}

func TestRecoverLimitWaitsRearms(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	ad := &multiRunAdapter{}
	e := NewEngineFromAdapters(st, map[string]adapter.Adapter{"claude-code": ad}, NewBus(), 2)
	t.Cleanup(e.Close)
	// Seed a failed task with waiting limit_hit and past reset.
	ctx := context.Background()
	task, err := e.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: "/tmp", Prompt: "x"})
	if err != nil {
		t.Fatal(err)
	}
	setLimitPolicy(t, e, LimitPolicyAsk)
	_ = waitStatus(t, e, task.ID, StatusFailed, 3*time.Second)
	// Manually stamp waiting with past reset and recover.
	resetAt := time.Now().Add(-time.Second).Unix()
	if _, err := e.LimitContinue(ctx, task.ID, LimitContinueRequest{Action: "wait", ResetAt: resetAt}); err != nil {
		t.Fatal(err)
	}
	// Cancel existing timer and re-arm via recover to simulate restart.
	e.cancelLimitWait(task.ID)
	// Reset adapter call count baseline
	callsBefore := ad.calls
	e.recoverLimitWaits(ctx)
	final := waitStatus(t, e, task.ID, StatusSucceeded, 8*time.Second)
	if final.Status != StatusSucceeded {
		t.Fatalf("status=%s", final.Status)
	}
	if ad.calls <= callsBefore {
		t.Fatalf("expected re-armed continue, calls before=%d after=%d", callsBefore, ad.calls)
	}
}
