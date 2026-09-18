package sessioncatalog

import (
	"context"
	"os"
	"path/filepath"
	"strings"
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
{"type":"assistant","sessionId":"claude-1","cwd":"/tmp/claude","uuid":"a1","message":{"role":"assistant","content":[{"type":"text","text":"answer"},{"type":"tool_use","name":"shell","input":{"apiKey":"secret-value"}}]}}
`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	catalog := &FileCatalog{AgentID: "claude-code", Format: FormatClaude, Roots: []string{root}}
	page, err := catalog.ReadHistory(context.Background(), "claude-1", agent.HistoryQuery{Limit: 10})
	if err != nil {
		t.Fatalf("ReadHistory: %v", err)
	}
	if len(page.Items) != 3 {
		t.Fatalf("items=%d, want 3", len(page.Items))
	}
	if page.Items[0].Text != "question" ||
		page.Items[1].Kind != "message" ||
		page.Items[1].Text != "answer" ||
		page.Items[2].Kind != "tool_call" ||
		page.Items[2].Role != "tool" ||
		page.Items[2].ToolName != "shell" ||
		strings.Contains(page.Items[2].Text, "secret-value") ||
		!strings.Contains(page.Items[2].Text, "[redacted]") {
		t.Fatalf("items=%+v", page.Items)
	}
}

func TestFileCatalogClaudeHistoryCursorKeepsSplitContentBlocks(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "cursor-session.jsonl")
	content := `{"type":"user","sessionId":"claude-cursor","uuid":"u1","message":{"role":"user","content":"question"}}
{"type":"assistant","sessionId":"claude-cursor","uuid":"a1","message":{"role":"assistant","content":[{"type":"text","text":"answer"},{"type":"tool_use","name":"shell","input":{"cmd":"pwd"}}]}}
`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	catalog := &FileCatalog{AgentID: "claude-code", Format: FormatClaude, Roots: []string{root}}
	first, err := catalog.ReadHistory(context.Background(), "claude-cursor", agent.HistoryQuery{Limit: 2})
	if err != nil {
		t.Fatalf("first ReadHistory: %v", err)
	}
	if len(first.Items) != 2 || first.Items[1].Text != "answer" {
		t.Fatalf("first page=%+v", first)
	}
	wantCursor := first.SourceRev + "|1:1"
	if first.NextCursor != wantCursor {
		t.Fatalf("first cursor=%q, want %s", first.NextCursor, wantCursor)
	}
	second, err := catalog.ReadHistory(context.Background(), "claude-cursor", agent.HistoryQuery{
		Cursor: first.NextCursor,
		Limit:  2,
	})
	if err != nil {
		t.Fatalf("second ReadHistory: %v", err)
	}
	if len(second.Items) != 1 || second.Items[0].Kind != "tool_call" {
		t.Fatalf("second page=%+v", second)
	}
	if second.NextCursor != "" {
		t.Fatalf("second cursor=%q, want empty", second.NextCursor)
	}
}

func TestFileCatalogClaudeNormalizesToolResultBlocks(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "tool-session.jsonl")
	content := `{"type":"user","sessionId":"claude-tools","uuid":"u1","message":{"role":"user","content":"run it"}}
{"type":"assistant","sessionId":"claude-tools","uuid":"a1","message":{"role":"assistant","content":[{"type":"tool_use","id":"tool-1","name":"shell","input":{"cmd":"pwd"}}]}}
{"type":"user","sessionId":"claude-tools","uuid":"u2","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool-1","content":"workspace"}]}}
`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	catalog := &FileCatalog{AgentID: "claude-code", Format: FormatClaude, Roots: []string{root}}
	page, err := catalog.ReadHistory(context.Background(), "claude-tools", agent.HistoryQuery{Limit: 10})
	if err != nil {
		t.Fatalf("ReadHistory: %v", err)
	}
	if len(page.Items) != 3 {
		t.Fatalf("items=%d, want 3: %+v", len(page.Items), page.Items)
	}
	if page.Items[1].Kind != "tool_call" || page.Items[1].Role != "tool" ||
		page.Items[1].ToolName != "shell" || page.Items[1].MessageID != "tool-1" {
		t.Fatalf("tool call=%+v", page.Items[1])
	}
	if page.Items[2].Kind != "tool_result" || page.Items[2].Role != "tool" ||
		!strings.Contains(page.Items[2].Text, "workspace") {
		t.Fatalf("tool result=%+v", page.Items[2])
	}
}

func TestFileCatalogCodexNormalizesToolEvents(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "tool-session.jsonl")
	content := `{"payload":{"type":"session_meta","session_id":"codex-tools","cwd":"/tmp/project"}}
{"payload":{"type":"function_call","call_id":"call-1","name":"shell","arguments":"{\"cmd\":\"curl --token raw-token --token=equal-token --token=\\\"quoted-token\\\"\",\"argv\":[\"--token\",\"array-token\"],\"apiKey\":\"secret-value\",\"access_key\":\"access-secret\",\"credential\":\"credential-secret\",\"env\":\"ANTHROPIC_API_KEY=env-secret\",\"header\":\"X-API-Key: header-secret\",\"auth\":\"Authorization: Bearer bearer-secret\",\"quoted\":\"API_KEY=\\\"quoted-secret\\\"\"}"},"ordinal":"1"}
{"payload":{"type":"function_call_output","call_id":"call-1","output":"/tmp/project"},"ordinal":"2"}
{"payload":{"type":"reasoning","summary":[{"text":"Checking the workspace"}]},"ordinal":"3"}
`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	catalog := &FileCatalog{AgentID: "codex", Format: FormatCodex, Roots: []string{root}}
	page, err := catalog.ReadHistory(context.Background(), "codex-tools", agent.HistoryQuery{Limit: 10})
	if err != nil {
		t.Fatalf("ReadHistory: %v", err)
	}
	if len(page.Items) != 3 {
		t.Fatalf("items=%d, want 3: %+v", len(page.Items), page.Items)
	}
	if page.Items[0].Kind != "tool_call" || page.Items[0].Role != "tool" ||
		page.Items[0].ToolName != "shell" {
		t.Fatalf("tool call=%+v", page.Items[0])
	}
	if strings.Contains(page.Items[0].Text, "secret-value") ||
		strings.Contains(page.Items[0].Text, "raw-token") ||
		strings.Contains(page.Items[0].Text, "equal-token") ||
		strings.Contains(page.Items[0].Text, "quoted-token") ||
		strings.Contains(page.Items[0].Text, "array-token") ||
		strings.Contains(page.Items[0].Text, "access-secret") ||
		strings.Contains(page.Items[0].Text, "credential-secret") ||
		strings.Contains(page.Items[0].Text, "env-secret") ||
		strings.Contains(page.Items[0].Text, "header-secret") ||
		strings.Contains(page.Items[0].Text, "bearer-secret") ||
		strings.Contains(page.Items[0].Text, "quoted-secret") ||
		!strings.Contains(page.Items[0].Text, "[redacted]") {
		t.Fatalf("tool call was not redacted: %q", page.Items[0].Text)
	}
	if page.Items[1].Kind != "tool_result" || page.Items[1].Role != "tool" {
		t.Fatalf("tool result=%+v", page.Items[1])
	}
	if page.Items[2].Kind != "reasoning" || page.Items[2].Role != "assistant" {
		t.Fatalf("reasoning=%+v", page.Items[2])
	}
}
