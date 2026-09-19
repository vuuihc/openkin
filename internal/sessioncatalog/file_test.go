package sessioncatalog

import (
	"context"
	"fmt"
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

func TestFileCatalogUsesFirstVisiblePromptWhenTitleIsOpaque(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "session.jsonl")
	content := `{"payload":{"type":"session_meta","session_id":"6d8f4e35-3b8f-4a6a-8e1a-7ce0fca2d6f4","cwd":"/tmp/kin"}}
{"payload":{"type":"message","session_id":"6d8f4e35-3b8f-4a6a-8e1a-7ce0fca2d6f4","role":"user","content":"Fix the sidebar session title"},"ordinal":"1"}
{"payload":{"type":"message","session_id":"6d8f4e35-3b8f-4a6a-8e1a-7ce0fca2d6f4","role":"assistant","content":"Done"},"ordinal":"2"}
`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	catalog := &FileCatalog{AgentID: "codex", Format: FormatCodex, Roots: []string{root}}
	sessions, err := catalog.List(context.Background(), agent.SessionQuery{Limit: 10})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(sessions) != 1 {
		t.Fatalf("sessions=%d, want 1", len(sessions))
	}
	if sessions[0].Title != "Fix the sidebar session title" {
		t.Fatalf("title=%q, want first visible prompt", sessions[0].Title)
	}
}

func TestFileCatalogDisambiguatesDuplicatePromptTitles(t *testing.T) {
	root := t.TempDir()
	for _, ref := range []string{
		"6d8f4e35-3b8f-4a6a-8e1a-7ce0fca2d6f4",
		"6d8f4e35-4c9f-4b7b-9f2b-8df1gdb3e7g5",
	} {
		path := filepath.Join(root, ref+".jsonl")
		content := fmt.Sprintf(
			"{\"payload\":{\"type\":\"session_meta\",\"session_id\":%q,\"cwd\":\"/tmp/kin\"}}\n"+
				"{\"payload\":{\"type\":\"message\",\"session_id\":%q,\"role\":\"user\",\"content\":\"Review the sidebar\"},\"ordinal\":\"1\"}\n",
			ref, ref,
		)
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	catalog := &FileCatalog{AgentID: "codex", Format: FormatCodex, Roots: []string{root}}
	sessions, err := catalog.List(context.Background(), agent.SessionQuery{Limit: 10})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(sessions) != 2 || sessions[0].Title == sessions[1].Title ||
		!strings.Contains(sessions[0].Title, " · ") ||
		!strings.Contains(sessions[1].Title, " · ") {
		t.Fatalf("sessions=%+v, want distinct prompt titles", sessions)
	}
}

func TestFileCatalogCodexFiltersInternalUserContext(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "codex-context.jsonl")
	content := `{"payload":{"type":"session_meta","session_id":"codex-context","cwd":"/tmp/project"}}
{"payload":{"type":"message","session_id":"codex-context","role":"developer","content":[{"type":"input_text","text":"developer bootstrap"}]},"ordinal":"1"}
{"payload":{"type":"message","session_id":"codex-context","role":"user","internal_chat_message_metadata_passthrough":{"content_item_kinds":["plugins.recommendations","environments.environment_context"]},"content":[{"type":"input_text","text":"plugin recommendations and environment context"}]},"ordinal":"2"}
{"payload":{"type":"message","session_id":"codex-context","role":"user","internal_chat_message_metadata_passthrough":{"content_item_kinds":["user.text"]},"content":[{"type":"input_text","text":"actual user question"}]},"ordinal":"3"}
{"payload":{"type":"message","session_id":"codex-context","role":"user","content":[{"type":"input_text","text":"follow-up question"}]},"ordinal":"4"}
{"payload":{"type":"message","session_id":"codex-context","role":"assistant","content":[{"type":"output_text","text":"answer"}]},"ordinal":"5"}
`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	catalog := &FileCatalog{AgentID: "codex", Format: FormatCodex, Roots: []string{root}}
	page, err := catalog.ReadHistory(context.Background(), "codex-context", agent.HistoryQuery{Limit: 10})
	if err != nil {
		t.Fatalf("ReadHistory: %v", err)
	}
	if len(page.Items) != 3 {
		t.Fatalf("items=%d, want 3: %+v", len(page.Items), page.Items)
	}
	if page.Items[0].Role != "user" || page.Items[0].Text != "actual user question" ||
		page.Items[1].Role != "user" || page.Items[1].Text != "follow-up question" ||
		page.Items[2].Role != "assistant" || page.Items[2].Text != "answer" {
		t.Fatalf("items=%+v", page.Items)
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

func TestFileCatalogClaudeFiltersInternalContextButKeepsUserText(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "claude-context.jsonl")
	longReminder := "<system-reminder>" + strings.Repeat("internal system instruction. ", 4) + "</system-reminder>"
	longLiteral := "<system-reminder>" + strings.Repeat("literal user example. ", 4) + "</system-reminder>"
	content := `{"type":"system","sessionId":"claude-context","subtype":"init"}
{"type":"user","sessionId":"claude-context","uuid":"meta","isMeta":true,"message":{"role":"user","content":"hidden bootstrap"}}
{"type":"user","sessionId":"claude-context","uuid":"sidechain","isSidechain":true,"message":{"role":"user","content":"hidden sidechain"}}
{"type":"user","sessionId":"claude-context","uuid":"summary","isCompactSummary":true,"message":{"role":"user","content":"hidden compact summary"}}
` + `{"type":"user","sessionId":"claude-context","uuid":"wrapped","entrypoint":"sdk-cli","message":{"role":"user","content":"` + longReminder + `actual user question"}}
` + `{"type":"user","sessionId":"claude-context","uuid":"literal","entrypoint":"cli","message":{"role":"user","content":"Please show ` + longLiteral + ` exactly."}}
{"type":"assistant","sessionId":"claude-context","uuid":"answer","message":{"role":"assistant","content":[{"type":"text","text":"answer"}]}}
`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	catalog := &FileCatalog{AgentID: "claude-code", Format: FormatClaude, Roots: []string{root}}
	page, err := catalog.ReadHistory(context.Background(), "claude-context", agent.HistoryQuery{Limit: 10})
	if err != nil {
		t.Fatalf("ReadHistory: %v", err)
	}
	if len(page.Items) != 3 {
		t.Fatalf("items=%d, want 3: %+v", len(page.Items), page.Items)
	}
	if page.Items[0].Role != "user" || page.Items[0].Text != "actual user question" ||
		page.Items[1].Role != "user" ||
		page.Items[1].Text != "Please show "+longLiteral+" exactly." ||
		page.Items[2].Role != "assistant" || page.Items[2].Text != "answer" {
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

func TestFileCatalogDroidNormalizesMetadataAndEvents(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "droid-session.jsonl")
	content := `{"type":"session_start","id":"droid-1","cwd":"/tmp/droid","title":"Droid session"}
{"type":"message","id":"m1","timestamp":"2026-09-19T10:00:00Z","message":{"role":"user","content":[{"type":"text","text":"inspect workspace"}]}}
{"type":"message","id":"m2","timestamp":"2026-09-19T10:00:01Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"checking"},{"type":"tool_use","id":"call-1","name":"shell","input":{"cmd":"pwd","token":"secret-value"}},{"type":"text","text":"done"}]}}
{"type":"message","id":"m3","timestamp":"2026-09-19T10:00:02Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-1","content":" /tmp/droid "}]}}
`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	catalog := &FileCatalog{AgentID: "droid", Format: FormatDroid, Roots: []string{root}}
	sessions, err := catalog.List(context.Background(), agent.SessionQuery{Limit: 10})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(sessions) != 1 || sessions[0].ExternalRef != "droid-1" ||
		sessions[0].Cwd != "/tmp/droid" || sessions[0].Title != "Droid session" {
		t.Fatalf("sessions=%+v", sessions)
	}

	page, err := catalog.ReadHistory(context.Background(), "droid-1", agent.HistoryQuery{Limit: 10})
	if err != nil {
		t.Fatalf("ReadHistory: %v", err)
	}
	if len(page.Items) != 5 {
		t.Fatalf("items=%d, want 5: %+v", len(page.Items), page.Items)
	}
	if page.Items[0].Role != "user" || page.Items[0].Text != "inspect workspace" {
		t.Fatalf("user item=%+v", page.Items[0])
	}
	if page.Items[1].Kind != "reasoning" || page.Items[2].Kind != "tool_call" ||
		page.Items[2].ToolName != "shell" || strings.Contains(page.Items[2].Text, "secret-value") ||
		page.Items[3].Text != "done" {
		t.Fatalf("assistant items=%+v", page.Items)
	}
	if page.Items[4].Kind != "tool_result" || !strings.Contains(page.Items[4].Text, "/tmp/droid") {
		t.Fatalf("tool result=%+v", page.Items[4])
	}
	if err := CheckConformance(context.Background(), catalog, "droid-1"); err != nil {
		t.Fatalf("catalog conformance: %v", err)
	}
}

func TestFileCatalogDroidAcceptsClaudeShapedMessages(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "droid-claude-shaped.jsonl")
	content := `{"type":"user","sessionId":"droid-2","cwd":"/tmp/droid","uuid":"u1","message":{"role":"user","content":"hello"}}
{"type":"assistant","sessionId":"droid-2","uuid":"a1","message":{"role":"assistant","content":[{"type":"text","text":"answer"},{"type":"tool_use","id":"tool-1","name":"shell","input":{"cmd":"pwd"}}]}}
`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	catalog := &FileCatalog{AgentID: "droid", Format: FormatDroid, Roots: []string{root}}
	sessions, err := catalog.List(context.Background(), agent.SessionQuery{Limit: 10})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(sessions) != 1 || sessions[0].ExternalRef != "droid-2" {
		t.Fatalf("sessions=%+v", sessions)
	}
	page, err := catalog.ReadHistory(context.Background(), "droid-2", agent.HistoryQuery{Limit: 10})
	if err != nil {
		t.Fatalf("ReadHistory: %v", err)
	}
	if len(page.Items) != 3 || page.Items[2].Kind != "tool_call" {
		t.Fatalf("items=%+v", page.Items)
	}
}

func TestFileCatalogDroidDerivesRefFromSessionFilename(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "droid-file-ref.jsonl")
	content := `{"type":"user","uuid":"u1","message":{"role":"user","content":"hello"}}
{"type":"assistant","uuid":"a1","message":{"role":"assistant","content":"answer"}}
`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	catalog := &FileCatalog{AgentID: "droid", Format: FormatDroid, Roots: []string{root}}
	sessions, err := catalog.List(context.Background(), agent.SessionQuery{Limit: 10})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(sessions) != 1 || sessions[0].ExternalRef != "droid-file-ref" {
		t.Fatalf("sessions=%+v", sessions)
	}
}
