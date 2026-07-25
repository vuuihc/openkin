package task

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/vuuihc/kin/internal/adapter"
	"github.com/vuuihc/kin/internal/store"
)

// multiRunAdapter fails with a rate-limit on the first Start, then succeeds.
type multiRunAdapter struct {
	calls int
}

func (a *multiRunAdapter) Start(ctx context.Context, spec adapter.TaskSpec) (adapter.RunHandle, error) {
	a.calls++
	ch := make(chan adapter.Event, 8)
	h := &fakeHandle{ch: ch, cancelCh: make(chan struct{})}
	call := a.calls
	go func() {
		defer close(ch)
		select {
		case <-h.cancelCh:
			return
		default:
		}
		if call == 1 {
			ch <- adapter.Event{
				Type: "error",
				Payload: mustJSON(map[string]any{
					"message":  "You've hit your usage limit. Try again in 1 minutes.",
					"kind":     "rate_limited",
					"provider": "claude",
					"reset_at": time.Now().Add(30 * time.Second).Unix(),
				}),
			}
			ch <- adapter.Event{
				Type: "result",
				Payload: mustJSON(map[string]any{
					"is_error": true,
					"result":   "rate limited",
					"kind":     "rate_limited",
				}),
			}
			return
		}
		ch <- adapter.Event{
			Type: "message",
			Payload: mustJSON(map[string]any{
				"role":    "assistant",
				"content": []map[string]string{{"type": "text", "text": "ok after wait"}},
				"partial": false,
			}),
		}
		ch <- adapter.Event{
			Type:    "result",
			Payload: mustJSON(map[string]any{"is_error": false, "result": "ok"}),
		}
	}()
	return h, nil
}

func mustJSON(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}

func limitTestEngine(t *testing.T, adapters map[string]adapter.Adapter) *Engine {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	e := NewEngineFromAdapters(st, adapters, NewBus(), 2)
	t.Cleanup(e.Close)
	if err := e.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	return e
}

func TestLimitHitEmittedOnRateLimit(t *testing.T) {
	ad := &multiRunAdapter{}
	e := limitTestEngine(t, map[string]adapter.Adapter{"claude-code": ad})
	ctx := context.Background()

	task, err := e.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: "/tmp", Prompt: "do work"})
	if err != nil {
		t.Fatal(err)
	}
	final := waitStatus(t, e, task.ID, StatusFailed, 3*time.Second)
	if final.Status != StatusFailed {
		t.Fatalf("status=%s", final.Status)
	}

	evs, err := e.Events(ctx, task.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	var hit *store.Event
	for i := range evs {
		if evs[i].Type == "limit_hit" {
			hit = &evs[i]
		}
	}
	if hit == nil {
		t.Fatalf("expected limit_hit event, events=%v", limitEventTypes(evs))
	}
	info, ok := adapter.DetectRateLimitPayload(hit.Payload)
	if !ok || info.Kind != adapter.RateLimitKind {
		t.Fatalf("payload=%s", string(hit.Payload))
	}
}

func TestLimitContinueContinueRetries(t *testing.T) {
	ad := &multiRunAdapter{}
	e := limitTestEngine(t, map[string]adapter.Adapter{"claude-code": ad})
	ctx := context.Background()

	task, err := e.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: "/tmp", Prompt: "do work"})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusFailed, 3*time.Second)

	t2, err := e.LimitContinue(ctx, task.ID, LimitContinueRequest{Action: "continue"})
	if err != nil {
		t.Fatal(err)
	}
	final := waitStatus(t, e, t2.ID, StatusSucceeded, 3*time.Second)
	if final.Status != StatusSucceeded {
		t.Fatalf("status=%s", final.Status)
	}
	if ad.calls < 2 {
		t.Fatalf("adapter calls=%d want >=2", ad.calls)
	}
}

func TestLimitContinueSwitchHandoff(t *testing.T) {
	ad := &multiRunAdapter{}
	codex := &fakeAdapter{events: []adapter.Event{
		{Type: "message", Payload: mustJSON(map[string]any{
			"role": "assistant", "content": []map[string]string{{"type": "text", "text": "codex ok"}}, "partial": false,
		})},
		{Type: "result", Payload: mustJSON(map[string]any{"is_error": false, "result": "ok"})},
	}}
	e := limitTestEngine(t, map[string]adapter.Adapter{
		"claude-code": ad,
		"codex":       codex,
	})
	ctx := context.Background()

	task, err := e.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: "/tmp", Prompt: "do work"})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusFailed, 3*time.Second)

	t2, err := e.LimitContinue(ctx, task.ID, LimitContinueRequest{Action: "switch", Agent: "codex"})
	if err != nil {
		t.Fatal(err)
	}
	if t2.Agent != "codex" {
		t.Fatalf("agent=%s", t2.Agent)
	}
	final := waitStatus(t, e, t2.ID, StatusSucceeded, 3*time.Second)
	if final.Status != StatusSucceeded {
		t.Fatalf("status=%s", final.Status)
	}
}

func TestLimitContinueWaitArmsTimer(t *testing.T) {
	ad := &multiRunAdapter{}
	e := limitTestEngine(t, map[string]adapter.Adapter{"claude-code": ad})
	ctx := context.Background()

	task, err := e.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: "/tmp", Prompt: "do work"})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusFailed, 3*time.Second)

	// reset in the past so grace (2s) alone governs the wait.
	resetAt := time.Now().Add(-1 * time.Second).Unix()
	if _, err := e.LimitContinue(ctx, task.ID, LimitContinueRequest{Action: "wait", ResetAt: resetAt}); err != nil {
		t.Fatal(err)
	}

	final := waitStatus(t, e, task.ID, StatusSucceeded, 6*time.Second)
	if final.Status != StatusSucceeded {
		t.Fatalf("status=%s after wait auto-continue", final.Status)
	}
	if ad.calls < 2 {
		t.Fatalf("calls=%d", ad.calls)
	}
}

func TestLimitContinueDismiss(t *testing.T) {
	ad := &multiRunAdapter{}
	e := limitTestEngine(t, map[string]adapter.Adapter{"claude-code": ad})
	ctx := context.Background()

	task, err := e.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: "/tmp", Prompt: "do work"})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, task.ID, StatusFailed, 3*time.Second)

	if _, err := e.LimitContinue(ctx, task.ID, LimitContinueRequest{Action: "dismiss"}); err != nil {
		t.Fatal(err)
	}
	evs, _ := e.Events(ctx, task.ID, 0)
	var dismissed bool
	for _, ev := range evs {
		if ev.Type != "limit_hit" {
			continue
		}
		var m map[string]any
		_ = json.Unmarshal(ev.Payload, &m)
		if m["status"] == "dismissed" {
			dismissed = true
		}
	}
	if !dismissed {
		t.Fatalf("expected dismissed limit_hit, types=%v", limitEventTypes(evs))
	}
}

func limitEventTypes(evs []store.Event) string {
	var b strings.Builder
	for i, ev := range evs {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(ev.Type)
	}
	return b.String()
}
