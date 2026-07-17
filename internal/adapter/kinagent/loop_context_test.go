package kinagent

import (
	"errors"
	"strings"
	"testing"

	"github.com/vuuihc/kin/internal/provider"
)

func TestLooksLikeContextOverflow(t *testing.T) {
	cases := []struct {
		err  string
		want bool
	}{
		{"context_length_exceeded", true},
		{"This model's maximum context length is 128000 tokens", true},
		{"prompt is too long", true},
		{"invalid api key", false},
		{"", false},
	}
	for _, c := range cases {
		var err error
		if c.err != "" {
			err = errors.New(c.err)
		}
		if got := looksLikeContextOverflow(err); got != c.want {
			t.Fatalf("%q: got %v want %v", c.err, got, c.want)
		}
	}
}

func TestOverflowCompactMessagesCollapsesTools(t *testing.T) {
	msgs := []provider.Message{
		{Role: provider.RoleSystem, Content: "sys"},
		{Role: provider.RoleUser, Content: "do work"},
	}
	for i := 0; i < 8; i++ {
		msgs = append(msgs,
			provider.Message{Role: provider.RoleAssistant, Content: "call", ToolCalls: []provider.ToolCall{{ID: "t", Type: "function"}}},
			provider.Message{Role: provider.RoleTool, Name: "bash", Content: strings.Repeat("OUT\n", 50), ToolCallID: "t"},
		)
	}
	// Safety-net path only — collapses oversized tool bodies.
	out := overflowCompactMessages(msgs, 1000)
	collapsed := 0
	for _, m := range out {
		if m.Role == provider.RoleTool && strings.Contains(m.Content, "full output dropped from context") {
			collapsed++
		}
	}
	if collapsed < 4 {
		t.Fatalf("expected tools collapsed on overflow, got %d collapsed; sample=%q", collapsed, out[3].Content)
	}
}

