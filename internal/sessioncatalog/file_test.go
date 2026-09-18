package sessioncatalog

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/vuuihc/openkin/internal/agent"
)

func TestFileCatalogCodexListAndHistoryCursor(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "session.jsonl")
	content := `{"payload":{"type":"session_meta","session_id":"codex-1","cwd":"/tmp/project","title":"Codex session"}}
{"payload":{"type":"message","session_id":"codex-1","role":"user","content":"hello"},"ordinal":"1"}
{"payload":{"type":"message","session_id":"codex-1","role":"assistant","content":[{"text":"world"}]},"ordinal":"2"}
`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	catalog := &FileCatalog{AgentID: "codex", Format: FormatCodex, Roots: []string{root}}
	ctx := context.Background()
	sessions, err := catalog.List(ctx, agent.SessionQuery{Limit: 10, Cwd: "/tmp/project"})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(sessions) != 1 {
		t.Fatalf("sessions=%d, want 1", len(sessions))
	}
	if sessions[0].ExternalRef != "codex-1" || sessions[0].Cwd != "/tmp/project" ||
		sessions[0].Title != "Codex session" {
		t.Fatalf("session=%+v", sessions[0])
	}
	if sessions[0].SourceURI == "" || sessions[0].ContentDigest != "" {
		t.Fatalf("unexpected session metadata: %+v", sessions[0])
	}

	first, err := catalog.ReadHistory(ctx, "codex-1", agent.HistoryQuery{Limit: 1})
	if err != nil {
		t.Fatalf("first history page: %v", err)
	}
	if len(first.Items) != 1 || first.Items[0].Role != "user" || first.Items[0].Text != "hello" {
		t.Fatalf("first page=%+v", first)
	}
	if first.NextCursor == "" {
		t.Fatal("first page has no cursor")
	}
	second, err := catalog.ReadHistory(ctx, "codex-1", agent.HistoryQuery{
		Cursor: first.NextCursor,
		Limit:  10,
	})
	if err != nil {
		t.Fatalf("second history page: %v", err)
	}
	if len(second.Items) != 1 || second.Items[0].Role != "assistant" || second.Items[0].Text != "world" {
		t.Fatalf("second page=%+v", second)
	}
	if second.NextCursor != "" {
		t.Fatalf("last page cursor=%q, want empty", second.NextCursor)
	}
}

func TestFileCatalogClaudeSkipsNonMessages(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "session.jsonl")
	content := `{"type":"system","sessionId":"claude-1","cwd":"/tmp/claude"}
{"type":"user","sessionId":"claude-1","cwd":"/tmp/claude","uuid":"u1","message":{"role":"user","content":"question"}}
{"type":"assistant","sessionId":"claude-1","cwd":"/tmp/claude","uuid":"a1","message":{"role":"assistant","content":[{"type":"text","text":"answer"}]}}
`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	catalog := &FileCatalog{AgentID: "claude-code", Format: FormatClaude, Roots: []string{root}}
	page, err := catalog.ReadHistory(context.Background(), "claude-1", agent.HistoryQuery{Limit: 10})
	if err != nil {
		t.Fatalf("ReadHistory: %v", err)
	}
	if len(page.Items) != 2 {
		t.Fatalf("items=%d, want 2", len(page.Items))
	}
	if page.Items[0].Text != "question" || page.Items[1].Text != "answer" {
		t.Fatalf("items=%+v", page.Items)
	}
}
