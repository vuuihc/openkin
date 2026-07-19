package task

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/vuuihc/kin/internal/adapter"
	"github.com/vuuihc/kin/internal/store"
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
