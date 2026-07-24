package task

import (
	"context"
	"encoding/json"
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

func TestParseReportSignalVariants(t *testing.T) {
	cases := []struct {
		in   string
		tldr string
		nw   bool
	}{
		{"hello\nTLDR: nothing new\nnoteworthy: false\n", "nothing new", false},
		{"TLDR: auth changed\nnoteworthy: true", "auth changed", true},
		{"noteworthy: yes\nTLDR:  x  \n", "x", true},
		{"no signal here", "", false},
	}
	for _, c := range cases {
		tldr, nw := ParseReportSignal(c.in)
		if tldr != c.tldr || nw != c.nw {
			t.Fatalf("in=%q got (%q,%v) want (%q,%v)", c.in, tldr, nw, c.tldr, c.nw)
		}
	}
}

type resultAdapter struct {
	text string
}

func (a resultAdapter) Start(ctx context.Context, spec adapter.TaskSpec) (adapter.RunHandle, error) {
	return &resultHandle{text: a.text}, nil
}

type resultHandle struct{ text string }

func (h *resultHandle) Events() <-chan adapter.Event {
	ch := make(chan adapter.Event, 2)
	payload, _ := json.Marshal(map[string]any{
		"text":     h.text,
		"is_error": false,
	})
	ch <- adapter.Event{Type: "result", Payload: payload}
	close(ch)
	return ch
}
func (h *resultHandle) Cancel() error { return nil }

func TestRoutineCompletionNoteworthyPush(t *testing.T) {
	var hits atomic.Int32
	var body atomic.Value
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		buf := make([]byte, 4096)
		n, _ := r.Body.Read(buf)
		body.Store(string(buf[:n]))
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

	now := time.Now().UnixMilli()
	if err := st.InsertRoutine(ctx, store.Routine{
		ID: "r1", Cwd: t.TempDir(), Agent: "claude-code", Prompt: "check",
		IntervalSecs: 60, Enabled: true, NextDueAt: now, CreatedAt: now, Title: "PRs",
	}); err != nil {
		t.Fatal(err)
	}

	e := NewEngineFromAdapters(st, map[string]adapter.Adapter{
		"claude-code": resultAdapter{text: "done\nTLDR: auth middleware touched\nnoteworthy: true\n"},
	}, NewBus(), 4)
	t.Cleanup(e.Close)
	e.SetNotifier(&notify.Sender{Store: st, Client: &http.Client{Timeout: 2 * time.Second}})

	task, err := e.Create(ctx, CreateRequest{
		Agent: "claude-code", Cwd: t.TempDir(), Prompt: "p", RoutineID: "r1",
	})
	if err != nil {
		t.Fatal(err)
	}
	waitStatus(t, e, task.ID, StatusSucceeded, 3*time.Second)

	got, err := st.GetTask(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !got.RoutineNoteworthy || !got.RoutineUnread || got.RoutineTLDR != "auth middleware touched" {
		t.Fatalf("got %+v", got)
	}

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && hits.Load() == 0 {
		time.Sleep(20 * time.Millisecond)
	}
	if hits.Load() == 0 {
		t.Fatal("expected noteworthy push")
	}
}

func TestRoutineSilentNoPush(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
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

	now := time.Now().UnixMilli()
	_ = st.InsertRoutine(ctx, store.Routine{
		ID: "r1", Cwd: t.TempDir(), Agent: "claude-code", Prompt: "check",
		IntervalSecs: 60, Enabled: true, NextDueAt: now, CreatedAt: now,
	})

	e := NewEngineFromAdapters(st, map[string]adapter.Adapter{
		"claude-code": resultAdapter{text: "TLDR: 0 new PRs\nnoteworthy: false\n"},
	}, NewBus(), 4)
	t.Cleanup(e.Close)
	e.SetNotifier(&notify.Sender{Store: st, Client: &http.Client{Timeout: 2 * time.Second}})

	task, err := e.Create(ctx, CreateRequest{
		Agent: "claude-code", Cwd: t.TempDir(), Prompt: "p", RoutineID: "r1",
	})
	if err != nil {
		t.Fatal(err)
	}
	waitStatus(t, e, task.ID, StatusSucceeded, 3*time.Second)
	time.Sleep(200 * time.Millisecond)
	if hits.Load() != 0 {
		t.Fatalf("silent run should not push, hits=%d", hits.Load())
	}
	got, _ := st.GetTask(ctx, task.ID)
	if got.RoutineNoteworthy || !got.RoutineUnread || got.RoutineTLDR != "0 new PRs" {
		t.Fatalf("got %+v", got)
	}
}
