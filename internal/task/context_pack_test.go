package task

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/store"
)

func TestHandoffContextKeepsRecentTurns(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	ctx := context.Background()

	task := store.Task{
		ID:        "01TESTCONTEXT00000000000000",
		Title:     "ctx",
		Agent:     "kin",
		Cwd:       "/tmp",
		Prompt:    "start",
		Status:    StatusSucceeded,
		CreatedAt: store.NowMilli(),
	}
	if err := st.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}

	// Flood with large older assistant messages.
	for i := 0; i < 30; i++ {
		payload, _ := json.Marshal(map[string]any{
			"role":    "assistant",
			"content": []map[string]string{{"type": "text", "text": strings.Repeat("OLD ", 200)}},
			"partial": false,
			"source":  "kin",
			"visibility": map[string]bool{
				"user": true,
				"task": true,
			},
		})
		if _, err := st.AppendEvent(ctx, task.ID, "message", payload); err != nil {
			t.Fatal(err)
		}
	}
	// Adjacent recent turns that must survive packing.
	for _, msg := range []struct {
		role, text string
	}{
		{"user", "RECENT_USER_TURN about context packing"},
		{"assistant", "RECENT_ASSISTANT_REPLY we will fix newest-first"},
	} {
		payload, _ := json.Marshal(map[string]any{
			"role":    msg.role,
			"content": []map[string]string{{"type": "text", "text": msg.text}},
			"partial": false,
			"agent":   msg.role,
			"speaker": msg.role,
			"source":  "follow_up",
			"visibility": map[string]bool{
				"user": true,
				"task": true,
			},
		})
		if _, err := st.AppendEvent(ctx, task.ID, "message", payload); err != nil {
			t.Fatal(err)
		}
	}

	e := NewEngineFromAdapters(st, map[string]adapter.Adapter{}, NewBus(), 1)
	got := e.handoffContext(ctx, task.ID)
	if got == "" {
		t.Fatal("empty handoff context")
	}
	if !strings.Contains(got, "RECENT_USER_TURN") {
		t.Fatalf("recent user missing from pack:\n%s", got)
	}
	if !strings.Contains(got, "RECENT_ASSISTANT_REPLY") {
		t.Fatalf("recent assistant missing from pack:\n%s", got)
	}
	// Chronological within pack.
	if strings.Index(got, "RECENT_USER_TURN") > strings.Index(got, "RECENT_ASSISTANT_REPLY") {
		t.Fatalf("order wrong:\n%s", got)
	}
}

// The subagent panel may show what a worker said; the host must not start
// reading it.
//
// Handoff context is what a cross-agent continuation hands the next agent, so a
// worker's narration reaching it is not a UI change -- it changes what the
// orchestrator knows on the next turn. Worker findings reach the host through the
// orchestrator's own summary, and that route is asserted here too, so a fix that
// just silenced everything would fail this test as well.
func TestWorkerNarrationStaysOutOfTheHostHandoffContext(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	ctx := context.Background()

	task := store.Task{
		ID:        "01TESTHANDOFFWORKER000000000",
		Title:     "handoff",
		Agent:     "kin",
		Cwd:       "/tmp",
		Prompt:    "start",
		Status:    StatusSucceeded,
		CreatedAt: store.NowMilli(),
	}
	if err := st.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}

	appendMsg := func(payload map[string]any) {
		t.Helper()
		b, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := st.AppendEvent(ctx, task.ID, "message", b); err != nil {
			t.Fatal(err)
		}
	}

	appendMsg(map[string]any{
		"role": "user", "speaker": "user", "source": "follow_up", "partial": false,
		"content":    []map[string]string{{"type": "text", "text": "HOST_ASKED_FOR_THE_PARSE_FIX"}},
		"visibility": map[string]bool{"user": true, "task": true},
	})
	// A worker's streamed narration, exactly as forwardWorkerEvents stamps it.
	appendMsg(map[string]any{
		"role": "assistant", "speaker": "codex", "agent": "codex", "source": "codex",
		"partial": false, "model": "gpt-5.5-codex",
		"content":    []map[string]string{{"type": "text", "text": "WORKER_NARRATION_I_AM_READING_THE_PARSER_NOW"}},
		"visibility": map[string]bool{"user": false, "task": true},
	})
	// What the host is meant to see instead.
	appendMsg(map[string]any{
		"role": "assistant", "speaker": "kin", "source": "orchestrator", "partial": false,
		"content":    []map[string]string{{"type": "text", "text": "ORCHESTRATOR_SUMMARY_worker_fixed_the_parser"}},
		"visibility": map[string]bool{"user": true, "task": true},
	})

	e := NewEngineFromAdapters(st, map[string]adapter.Adapter{}, NewBus(), 1)
	got := e.handoffContext(ctx, task.ID)
	if !strings.Contains(got, "HOST_ASKED_FOR_THE_PARSE_FIX") {
		t.Fatalf("the user's own message is missing:\n%s", got)
	}
	if !strings.Contains(got, "ORCHESTRATOR_SUMMARY_worker_fixed_the_parser") {
		t.Fatalf("the orchestrator summary is missing, so the host lost the worker's findings:\n%s", got)
	}
	if strings.Contains(got, "WORKER_NARRATION") {
		t.Fatalf("a worker's narration reached the host's handoff context:\n%s", got)
	}
}
