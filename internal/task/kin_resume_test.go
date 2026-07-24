package task

import (
	"context"
	"encoding/json"
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
	if !strings.HasPrefix(last.Prompt, "second question") {
		t.Fatalf("adapter prompt should start with live turn, got %q", last.Prompt)
	}
	if !strings.Contains(last.Prompt, replyLanguageInstruction(responseLanguageEnglish)) {
		t.Fatalf("adapter prompt missing English reply policy: %q", last.Prompt)
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


func TestFollowUpAfterOrchestrateResumesWithSeededTranscript(t *testing.T) {
	ctx := context.Background()
	var specs []adapter.TaskSpec
	kinAd := &capturingAdapter{
		onStart: func(spec adapter.TaskSpec) {
			specs = append(specs, spec)
		},
		events: successEvents(),
	}
	claudeAd := &fakeAdapter{events: []adapter.Event{
		{Type: "task_started", Payload: json.RawMessage(`{"session_id":"w1"}`)},
		{Type: "message", Payload: json.RawMessage(`{"role":"assistant","content":[{"type":"text","text":"CLAUDE_DID_THE_WORK: fixed tests"}],"partial":false}`)},
		{Type: "result", Payload: json.RawMessage(`{"is_error":false,"result":"CLAUDE_DID_THE_WORK: fixed tests"}`)},
	}}
	e, st := testEngine(t, 4, kinAd)
	e.putAdapter("kin", kinAd)
	e.putAdapter("claude-code", claudeAd)
	e.SetDefaultAgentFn(func() string { return "kin" })

	// First turn on kin (so SessionHooks path is active).
	t1, err := e.Create(ctx, CreateRequest{Agent: "kin", Cwd: "/tmp", Prompt: "start here"})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, t1.ID, StatusSucceeded, 3*time.Second)

	// Seed pre-orchestrate history (simulates a real Kin turn).
	if err := st.ReplaceKinMessages(ctx, t1.ID, []store.KinMessage{
		{Role: "user", Content: "start here"},
		{Role: "assistant", Content: "ready"},
	}); err != nil {
		t.Fatal(err)
	}

	// @claude orchestrates: clears transcript at entry, must re-seed after summary.
	t2, err := e.FollowUp(ctx, t1.ID, "@claude-code fix the failing tests")
	if err != nil {
		t.Fatal(err)
	}
	if plan, ok := e.shouldOrchestrate(t2); !ok || !plan.HasSubAgents() {
		t.Fatalf("expected orchestrate, ok=%v plan=%+v", ok, plan)
	}
	_ = waitStatus(t, e, t1.ID, StatusSucceeded, 5*time.Second)

	msgs, err := st.LoadKinMessages(ctx, t1.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) < 2 {
		t.Fatalf("expected seeded transcript after orchestration, got %d msgs: %+v", len(msgs), msgs)
	}
	joined := ""
	for _, m := range msgs {
		joined += m.Role + ":" + m.Content + "\n"
	}
	if !strings.Contains(joined, "@claude-code") && !strings.Contains(joined, "fix the failing") {
		t.Fatalf("seeded user turn missing live request:\n%s", joined)
	}
	if !strings.Contains(joined, "CLAUDE_DID_THE_WORK") {
		t.Fatalf("seeded assistant summary missing worker findings:\n%s", joined)
	}

	// Plain follow-up back to Kin must same-agent resume (live prompt only) and
	// kinagent will load the seeded prior — engine must NOT rebuild an empty pack.
	specs = nil
	t3, err := e.FollowUp(ctx, t1.ID, "上一轮 Claude 做了什么？")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(t3.Prompt, "prior context") || strings.Contains(t3.Prompt, "[Recent turns]") {
		t.Fatalf("with seeded transcript, should live-prompt resume, got %q", t3.Prompt)
	}
	if t3.Prompt != "上一轮 Claude 做了什么？" {
		t.Fatalf("want live prompt only, got %q", t3.Prompt)
	}
	_ = waitStatus(t, e, t1.ID, StatusSucceeded, 3*time.Second)
}

func TestFollowUpEmptyManagedTranscriptFallsBackToPack(t *testing.T) {
	ctx := context.Background()
	kinAd := &fakeAdapter{events: successEvents()}
	e, st := testEngine(t, 4, kinAd)
	e.putAdapter("kin", kinAd)
	e.SetDefaultAgentFn(func() string { return "kin" })

	t1, err := e.Create(ctx, CreateRequest{Agent: "kin", Cwd: "/tmp", Prompt: "first question about packing"})
	if err != nil {
		t.Fatal(err)
	}
	_ = waitStatus(t, e, t1.ID, StatusSucceeded, 2*time.Second)

	// Simulate orchestrate clear without seed (the bug state).
	if err := st.ClearKinMessages(ctx, t1.ID); err != nil {
		t.Fatal(err)
	}

	t2, err := e.FollowUp(ctx, t1.ID, "继续上次的工作")
	if err != nil {
		t.Fatal(err)
	}
	if t2.Prompt == "继续上次的工作" {
		t.Fatal("empty managed transcript must not live-prompt-only resume")
	}
	if !strings.Contains(t2.Prompt, "prior context") && !strings.Contains(t2.Prompt, "User request:") {
		t.Fatalf("expected sealed pack handoff wrapper, got %q", t2.Prompt)
	}
	// Recent user-visible content from events should appear.
	if !strings.Contains(t2.Prompt, "first question") && !strings.Contains(t2.Prompt, "hi") {
		t.Fatalf("pack should include prior event text, got %q", t2.Prompt)
	}
}
