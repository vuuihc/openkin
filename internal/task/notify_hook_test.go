package task

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/vuuihc/kin/internal/adapter"
	"github.com/vuuihc/kin/internal/notify"
	"github.com/vuuihc/kin/internal/store"
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
	var hits atomic.Int32
	var click string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		click = r.Header.Get("Click")
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(200)
	}))
	t.Cleanup(srv.Close)

	st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	ctx := context.Background()
	_ = st.SetSetting(ctx, notify.KeyNtfyTopic, srv.URL)
	_ = st.SetSetting(ctx, notify.KeyBaseURL, "http://host:7777")

	e := NewEngineFromAdapters(st, map[string]adapter.Adapter{"claude-code": &hangAd{}}, NewBus(), 4)
	t.Cleanup(e.Close)
	e.SetNotifier(&notify.Sender{Store: st, Client: &http.Client{Timeout: 2 * time.Second}})

	task, err := e.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: t.TempDir(), Prompt: "p"})
	if err != nil {
		t.Fatal(err)
	}
	waitStatus(t, e, task.ID, StatusRunning, 2*time.Second)

	_, err = e.RequestApproval(ctx, CreateApprovalRequest{
		TaskID: task.ID, Kind: "tool_use", Payload: json.RawMessage(`{}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && hits.Load() == 0 {
		time.Sleep(20 * time.Millisecond)
	}
	if hits.Load() == 0 {
		t.Fatal("expected notification POST")
	}
	if click != "http://host:7777/approvals" {
		t.Fatalf("click=%q", click)
	}
}
