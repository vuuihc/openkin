package task

// KIN-NOTIFY-001: a routine report reaches the same pipeline, or stays silent.

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/notify"
	"github.com/vuuihc/openkin/internal/store"
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
	st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	ctx := context.Background()
	_ = st.SetSetting(ctx, "ui.base_url", "http://host:7777")

	now := time.Now().UnixMilli()
	if err := st.InsertRoutine(ctx, store.Routine{
		ID: "r1", Cwd: t.TempDir(), Agent: "claude-code", Prompt: "check",
		IntervalSecs: 60, Enabled: true, NextDueAt: now, CreatedAt: now, Title: "PRs",
	}); err != nil {
		t.Fatal(err)
	}

	rec := &notifyRecorder{}
	e := NewEngineFromAdapters(st, map[string]adapter.Adapter{
		"claude-code": resultAdapter{text: "done\nTLDR: auth middleware touched\nnoteworthy: true\n"},
	}, NewBus(), 4)
	t.Cleanup(e.Close)
	e.SetNotifier(testSender(st, rec))

	task, err := e.Create(ctx, CreateRequest{
		Agent: "claude-code", Cwd: t.TempDir(), Prompt: "p", RoutineID: "r1",
	})
	if err != nil {
		t.Fatal(err)
	}
	waitStatus(t, e, task.ID, StatusSucceeded, 3*time.Second)

	// The terminal status is written before the routine annotation that follows
	// it, so the flag has to be waited for on its own: polling the status and
	// then reading the row is a race the slower (race-enabled) build always
	// loses.
	var got store.Task
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		got, err = st.GetTask(ctx, task.ID)
		if err == nil && got.RoutineNoteworthy {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err != nil {
		t.Fatal(err)
	}
	if !got.RoutineNoteworthy || !got.RoutineUnread || got.RoutineTLDR != "auth middleware touched" {
		t.Fatalf("got %+v", got)
	}

	events := rec.waitFor(t, 1)
	if events[0].Kind != "routine" || events[0].Body != "auth middleware touched" {
		t.Fatalf("event=%+v", events[0])
	}
	if events[0].URL != "http://host:7777/tasks/"+task.ID {
		t.Fatalf("url=%q", events[0].URL)
	}
}

func TestRoutineSilentNoPush(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	ctx := context.Background()

	now := time.Now().UnixMilli()
	_ = st.InsertRoutine(ctx, store.Routine{
		ID: "r1", Cwd: t.TempDir(), Agent: "claude-code", Prompt: "check",
		IntervalSecs: 60, Enabled: true, NextDueAt: now, CreatedAt: now,
	})

	rec := &notifyRecorder{}
	e := NewEngineFromAdapters(st, map[string]adapter.Adapter{
		"claude-code": resultAdapter{text: "TLDR: 0 new PRs\nnoteworthy: false\n"},
	}, NewBus(), 4)
	t.Cleanup(e.Close)
	e.SetNotifier(testSender(st, rec))

	task, err := e.Create(ctx, CreateRequest{
		Agent: "claude-code", Cwd: t.TempDir(), Prompt: "p", RoutineID: "r1",
	})
	if err != nil {
		t.Fatal(err)
	}
	waitStatus(t, e, task.ID, StatusSucceeded, 3*time.Second)
	time.Sleep(200 * time.Millisecond)
	if events := rec.snapshot(); len(events) != 0 {
		t.Fatalf("silent run should not push, got %+v", events)
	}
	got, _ := st.GetTask(ctx, task.ID)
	if got.RoutineNoteworthy || !got.RoutineUnread || got.RoutineTLDR != "0 new PRs" {
		t.Fatalf("got %+v", got)
	}
}

// terminalOnlyNotifier exposes the task-ending half of a notifier but not its
// routine methods, which is the shape that sends the routine hooks down their
// fallback path. The fallback still renders through the real notify.Sender, so
// this test reads the copy a person would actually get.
type terminalOnlyNotifier struct{ sender *notify.Sender }

func (terminalOnlyNotifier) NotifyApproval(context.Context, string, string, string) {}

func (n terminalOnlyNotifier) NotifyTaskTerminal(ctx context.Context, taskID, taskTitle, status string) {
	n.sender.NotifyTaskTerminal(ctx, taskID, taskTitle, status)
}

// The routine fallbacks used to reuse the terminal notification with the
// machine words "noteworthy" and "disabled" as the status, which reached the
// banner as "Task <id> is noteworthy". They must read like the terminal states
// do; the enum stays in the event's Status field, where it is never shown.
func TestRoutineFallbackUsesHumanCopy(t *testing.T) {
	rec := &notifyRecorder{}
	e := &Engine{notify: terminalOnlyNotifier{sender: &notify.Sender{
		BaseURLOverride: "https://kin.example.com", Events: rec,
	}}}
	ctx := context.Background()

	e.pushRoutine(ctx, store.Task{ID: "task-1", Title: "Morning planning"}, true)
	e.pushRoutineFailure(ctx, store.Routine{ID: "routine-1", Title: "Nightly audit"}, "auto-disabled after 3 failures")

	events := rec.waitFor(t, 2)
	byID := map[string]notify.Event{}
	for _, ev := range events {
		low := strings.ToLower(ev.Title + " " + ev.Body)
		for _, leak := range []string{"noteworthy", "disabled"} {
			if strings.Contains(low, leak) {
				t.Fatalf("%q leaked into the banner: %q / %q", leak, ev.Title, ev.Body)
			}
		}
		if ev.Body == "" || ev.Body == ev.Title {
			t.Fatalf("banner reads as %q / %q", ev.Title, ev.Body)
		}
		byID[ev.ID] = ev
	}

	report := byID["task-1"]
	if report.Title != "Morning planning" || report.Body == "" {
		t.Fatalf("routine report banner = %q / %q", report.Title, report.Body)
	}
	if report.Status != "noteworthy" {
		t.Fatalf("routine report status = %q, want the machine token kept for dedupe", report.Status)
	}
	failure := byID["routine-1"]
	if failure.Title != "Nightly audit" || failure.Body == "" {
		t.Fatalf("routine failure banner = %q / %q", failure.Title, failure.Body)
	}
	if failure.Status != "disabled" {
		t.Fatalf("routine failure status = %q, want the machine token kept for dedupe", failure.Status)
	}
	if report.Body == failure.Body {
		t.Fatalf("report and failure read the same: %q", report.Body)
	}
}
