package task

// KIN-NOTIFY-001: an approval reaches the node's one notification pipeline.

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/store"
)

type hangAd struct{}
type hangH struct{ ch chan adapter.Event }

func (h *hangH) Events() <-chan adapter.Event { return h.ch }
func (h *hangH) Cancel() error                { return nil }
func (a *hangAd) Start(ctx context.Context, spec adapter.TaskSpec) (adapter.RunHandle, error) {
	ch := make(chan adapter.Event)
	go func() { <-ctx.Done(); close(ch) }()
	return &hangH{ch: ch}, nil
}

func TestNotifyOnApproval(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	ctx := context.Background()
	_ = st.SetSetting(ctx, "ui.base_url", "http://host:7777")

	rec := &notifyRecorder{}
	e := NewEngineFromAdapters(st, map[string]adapter.Adapter{"claude-code": &hangAd{}}, NewBus(), 4)
	t.Cleanup(e.Close)
	e.SetNotifier(testSender(st, rec))

	task, err := e.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: t.TempDir(), Prompt: "p"})
	if err != nil {
		t.Fatal(err)
	}
	waitStatus(t, e, task.ID, StatusRunning, 2*time.Second)

	appr, err := e.RequestApproval(ctx, CreateApprovalRequest{
		TaskID: task.ID, Kind: "tool_use", Payload: json.RawMessage(`{}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	events := rec.waitFor(t, 1)
	// The link has to name the approval this call created, not the inbox in
	// general: that is the whole difference between a push you can act on from
	// the lock screen and one that makes you go looking.
	want := "http://host:7777/inbox?focus=" + appr.ID
	if events[0].URL != want {
		t.Fatalf("url=%q, want focus on %s", events[0].URL, appr.ID)
	}
	if events[0].Kind != "approval" || events[0].ID != appr.ID {
		t.Fatalf("event=%+v", events[0])
	}
}
