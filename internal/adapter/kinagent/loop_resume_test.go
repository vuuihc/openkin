package kinagent

import (
	"strings"
	"testing"

	"github.com/vuuihc/kin/internal/provider"
)

func TestBuildInitialMessagesColdStart(t *testing.T) {
	msgs := buildInitialMessages("SYS", "hello", nil)
	if len(msgs) != 2 {
		t.Fatalf("len=%d", len(msgs))
	}
	if msgs[0].Role != provider.RoleSystem || msgs[0].Content != "SYS" {
		t.Fatalf("system %+v", msgs[0])
	}
	if msgs[1].Role != provider.RoleUser || msgs[1].Content != "hello" {
		t.Fatalf("user %+v", msgs[1])
	}
}

func TestBuildInitialMessagesAppendOnly(t *testing.T) {
	prior := []provider.Message{
		{Role: provider.RoleSystem, Content: "OLD_SYS"},
		{Role: provider.RoleUser, Content: "first"},
		{Role: provider.RoleAssistant, Content: "reply1"},
	}
	msgs := buildInitialMessages("NEW_SYS", "second", prior)
	if len(msgs) != 4 {
		t.Fatalf("len=%d %+v", len(msgs), msgs)
	}
	if msgs[0].Content != "NEW_SYS" {
		t.Fatalf("system rebound: %q", msgs[0].Content)
	}
	// Prior user/assistant preserved in order; live user appended.
	if msgs[1].Content != "first" || msgs[2].Content != "reply1" || msgs[3].Content != "second" {
		t.Fatalf("order/content %+v", msgs)
	}
	// No rebuilt handoff blob.
	joined := ""
	for _, m := range msgs {
		joined += m.Content + "\n"
	}
	if strings.Contains(joined, "--- prior context ---") {
		t.Fatal("should not inject handoff pack on resume")
	}
}
