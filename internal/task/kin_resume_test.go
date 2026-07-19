package task

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/vuuihc/kin/internal/adapter"
	"github.com/vuuihc/kin/internal/store"
)

func TestKinFollowUpUsesLivePromptOnly(t *testing.T) {
	ctx := context.Background()
	var specs []adapter.TaskSpec
	ad := &capturingAdapter{
		onStart: func(spec adapter.TaskSpec) {
			specs = append(specs, spec)
		},
		events: successEvents(),
	}
	e, st := testEngine(t, 4, ad)
	e.putAdapter("kin", ad)
	e.SetDefaultAgentFn(func() string { return "kin" })

	// Seed a prior durable transcript as if a previous kin turn completed.
	t1, err := e.Create(ctx, CreateRequest{Agent: "kin", Cwd: "/tmp", Prompt: "first question"})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, t1.ID, StatusSucceeded, 2*time.Second)

	if err := st.ReplaceKinMessages(ctx, t1.ID, []store.KinMessage{
		{Role: "user", Content: "first question"},
		{Role: "assistant", Content: "first answer"},
	}); err != nil {
		t.Fatal(err)
	}

	t2, err := e.FollowUp(ctx, t1.ID, "second question")
	if err != nil {
		t.Fatal(err)
	}
	if t2.Prompt != "second question" {
		t.Fatalf("want live prompt only, got %q", t2.Prompt)
	}
	if strings.Contains(t2.Prompt, "prior context") || strings.Contains(t2.Prompt, "[Recent turns]") {
		t.Fatalf("should not rebuild pack for same-kin follow-up: %q", t2.Prompt)
	}

	// Transcript must remain (not cleared).
	msgs, err := st.LoadKinMessages(ctx, t1.ID)
	if err != nil || len(msgs) != 2 {
		t.Fatalf("transcript cleared? err=%v len=%d", err, len(msgs))
	}

	_ = waitStatus(t, e, t1.ID, StatusSucceeded, 2*time.Second)
	if len(specs) < 2 {
		t.Fatalf("expected second start, specs=%d", len(specs))
	}
	last := specs[len(specs)-1]
	if last.Prompt != "second question" {
		t.Fatalf("adapter prompt=%q", last.Prompt)
	}
}

func TestHandoffClearsKinTranscript(t *testing.T) {
	ctx := context.Background()
	kinAd := &fakeAdapter{events: successEvents()}
	claudeAd := &fakeAdapter{events: successEvents()}
	e, st := testEngine(t, 4, kinAd)
	e.putAdapter("kin", kinAd)
	e.putAdapter("claude-code", claudeAd)

	t1, err := e.Create(ctx, CreateRequest{Agent: "kin", Cwd: "/tmp", Prompt: "hi"})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, t1.ID, StatusSucceeded, 2*time.Second)
	_ = st.ReplaceKinMessages(ctx, t1.ID, []store.KinMessage{
		{Role: "user", Content: "hi"},
		{Role: "assistant", Content: "yo"},
	})

	t2, err := e.FollowUpWith(ctx, t1.ID, FollowUpRequest{Prompt: "take over", Agent: "claude-code"})
	if err != nil {
		t.Fatal(err)
	}
	if t2.Agent != "claude-code" {
		t.Fatalf("agent=%s", t2.Agent)
	}
	msgs, _ := st.LoadKinMessages(ctx, t1.ID)
	if len(msgs) != 0 {
		t.Fatalf("kin transcript should clear on handoff, len=%d", len(msgs))
	}
	if !strings.Contains(t2.Prompt, "prior context") && !strings.Contains(t2.Prompt, "User request:") {
		t.Fatalf("handoff should inject pack: %q", t2.Prompt)
	}
}
