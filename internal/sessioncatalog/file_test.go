package sessioncatalog

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
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

func TestFileCatalogClaudeHistoryPagesBackwardFromTheEnd(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "tail-session.jsonl")
	content := `{"type":"user","sessionId":"claude-tail","uuid":"u1","message":{"role":"user","content":"first"}}
{"type":"assistant","sessionId":"claude-tail","uuid":"a1","message":{"role":"assistant","content":[{"type":"text","text":"one"},{"type":"text","text":"two"},{"type":"text","text":"three"}]}}
{"type":"user","sessionId":"claude-tail","uuid":"u2","message":{"role":"user","content":"second"}}
{"type":"assistant","sessionId":"claude-tail","uuid":"a2","message":{"role":"assistant","content":"last"}}
`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	catalog := &FileCatalog{AgentID: "claude-code", Format: FormatClaude, Roots: []string{root}}
	ctx := context.Background()

	tail, err := catalog.ReadHistory(ctx, "claude-tail", agent.HistoryQuery{Tail: true, Limit: 2})
	if err != nil {
		t.Fatalf("tail ReadHistory: %v", err)
	}
	if len(tail.Items) != 2 || tail.Items[0].Text != "second" || tail.Items[1].Text != "last" {
		t.Fatalf("tail page=%+v", tail)
	}
	if tail.NextCursor != "" {
		t.Fatalf("tail page next cursor=%q, want empty", tail.NextCursor)
	}
	if tail.PrevCursor == "" {
		t.Fatal("tail page has no previous cursor")
	}

	older, err := catalog.ReadHistory(ctx, "claude-tail", agent.HistoryQuery{
		Before: tail.PrevCursor,
		Limit:  10,
	})
	if err != nil {
		t.Fatalf("older ReadHistory: %v", err)
	}
	if len(older.Items) != 4 {
		t.Fatalf("older page has %d items, want 4: %+v", len(older.Items), older.Items)
	}
	want := []string{"first", "one", "two", "three"}
	for index, text := range want {
		if older.Items[index].Text != text {
			t.Fatalf("older item %d=%q, want %q", index, older.Items[index].Text, text)
		}
	}
	if older.PrevCursor != "" {
		t.Fatalf("older page prev cursor=%q, want empty", older.PrevCursor)
	}
}

func TestFileCatalogBackwardPageKeepsWholeRecords(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "chunk-session.jsonl")
	content := `{"type":"user","sessionId":"claude-chunks","uuid":"u1","message":{"role":"user","content":"question"}}
{"type":"assistant","sessionId":"claude-chunks","uuid":"a1","message":{"role":"assistant","content":[{"type":"text","text":"one"},{"type":"text","text":"two"},{"type":"text","text":"three"}]}}
`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	catalog := &FileCatalog{AgentID: "claude-code", Format: FormatClaude, Roots: []string{root}}

	// One item of budget cannot hold the last record's three chunks, so the page
	// keeps the record whole rather than opening with half a message.
	page, err := catalog.ReadHistory(context.Background(), "claude-chunks", agent.HistoryQuery{Tail: true, Limit: 1})
	if err != nil {
		t.Fatalf("tail ReadHistory: %v", err)
	}
	if len(page.Items) != 3 {
		t.Fatalf("tail page has %d items, want the whole 3-chunk record: %+v", len(page.Items), page.Items)
	}
	for index, text := range []string{"one", "two", "three"} {
		if page.Items[index].Text != text {
			t.Fatalf("tail item %d=%q, want %q", index, page.Items[index].Text, text)
		}
	}
	if page.PrevCursor == "" {
		t.Fatal("tail page has no previous cursor")
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

// A message this layer had to cut says so, and one it did not says nothing.
//
// The flag is the difference between a transcript that ends and one that was
// stopped: a reader shown the first 64 Ki characters of a message has no other
// way to tell, because the text that arrives looks complete either way. The cap
// is counted in runes here, so the flag has to be raised against the same unit —
// a message of 64 Ki Chinese characters is a whole message and not a cut one.
func TestFileCatalogMarksTheMessagesItHadToCut(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "session.jsonl")
	long := strings.Repeat("deep", maxHistoryText)
	wide := strings.Repeat("深", maxHistoryText)
	content := fmt.Sprintf(
		`{"payload":{"type":"session_meta","session_id":"codex-1","cwd":"/tmp/project"}}
{"payload":{"type":"message","session_id":"codex-1","role":"user","content":"short"}}
{"payload":{"type":"message","session_id":"codex-1","role":"assistant","content":%q}}
{"payload":{"type":"message","session_id":"codex-1","role":"user","content":%q}}
`, long, wide)
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	catalog := &FileCatalog{AgentID: "codex", Format: FormatCodex, Roots: []string{root}}
	page, err := catalog.ReadHistory(context.Background(), "codex-1", agent.HistoryQuery{Limit: 10})
	if err != nil {
		t.Fatalf("ReadHistory: %v", err)
	}
	if len(page.Items) != 3 {
		t.Fatalf("items=%d, want the three messages", len(page.Items))
	}
	if page.Items[0].Truncated {
		t.Fatalf("a message that fits was marked as cut: %+v", page.Items[0])
	}
	if !page.Items[1].Truncated {
		t.Fatal("a message three times the cap was not marked as cut")
	}
	if got := len([]rune(page.Items[1].Text)); got != maxHistoryText {
		t.Fatalf("the cut message is %d runes, want the cap %d", got, maxHistoryText)
	}
	if !strings.HasPrefix(long, strings.TrimSuffix(page.Items[1].Text, "…")) {
		t.Fatal("the cut message is not the beginning of what the provider recorded")
	}
	// Counted in runes, not bytes: the same number of characters in Chinese is
	// three times the bytes and still one whole message.
	if page.Items[2].Truncated {
		t.Fatalf("a message at the cap in characters was treated as bytes: %+v", page.Items[2])
	}
}

// A recorded source is read as named, without a walk of the whole catalog.
//
// This is the difference between a phone opening a large session and a page
// that sits on a skeleton: the row that asked for the page already knows the
// file, and rediscovering it means parsing thousands of records in every other
// transcript first.
func TestFileCatalogReadsANamedSourceWithoutDiscovery(t *testing.T) {
	root := t.TempDir()
	codexFile(t, root, "aaa-first.jsonl", "codex-first", "first session")
	target := codexFile(t, root, "zzz-target.jsonl", "codex-target", "")
	if err := os.WriteFile(target, []byte(
		`{"payload":{"type":"session_meta","session_id":"codex-target","cwd":"/tmp/project"}}
{"payload":{"type":"message","session_id":"codex-target","role":"user","content":"the newest message"}}
`), 0o600); err != nil {
		t.Fatal(err)
	}

	// One file is all discovery may return, and the target sorts after it: the
	// catalog cannot name the target on its own, which is how this test tells a
	// read that used the hint from one that quietly walked the tree.
	catalog := &FileCatalog{AgentID: "codex", Format: FormatCodex, Roots: []string{root}, MaxFiles: 1}
	if _, err := catalog.Inspect(context.Background(), "codex-target"); err == nil {
		t.Fatal("the fixture does not hide the target from discovery")
	}
	page, err := catalog.ReadHistory(context.Background(), "codex-target", agent.HistoryQuery{
		Tail:      true,
		Limit:     10,
		SourceURI: "file://" + target,
	})
	if err != nil {
		t.Fatalf("ReadHistory with a named source: %v", err)
	}
	if len(page.Items) != 1 || page.Items[0].Text != "the newest message" {
		t.Fatalf("page=%+v, want the target session's message", page)
	}
	if page.Items[0].ExternalRef != "codex-target" {
		t.Fatalf("item ref=%q, want the one that was asked for", page.Items[0].ExternalRef)
	}
}

// A hint that names anything else is dropped rather than trusted.
//
// The value travels from a stored row and, on the device path, over a wire. A
// stale row or a buggy caller must cost a rediscovery; reading another
// session's transcript under this session's name would be a silent lie about
// what the person is looking at.
func TestFileCatalogRefusesSourceHintsItCouldNotHaveFound(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	codexFile(t, root, "a.jsonl", "codex-a", "session a")
	b := codexFile(t, root, "b.jsonl", "codex-b", "session b")
	c := codexFile(t, outside, "c.jsonl", "codex-c", "session c")
	// The same session's ref, in a copy outside the catalog. A hint is allowed
	// to skip the walk that finds a file, not to widen what counts as one.
	codexFile(t, outside, "copy.jsonl", "codex-a", "outside copy")
	link := filepath.Join(root, "link.jsonl")
	if err := os.Symlink(b, link); err != nil {
		t.Fatal(err)
	}

	catalog := &FileCatalog{AgentID: "codex", Format: FormatCodex, Roots: []string{root}}
	read := func(t *testing.T, ref, hint string) (agent.HistoryPage, error) {
		t.Helper()
		return catalog.ReadHistory(context.Background(), ref, agent.HistoryQuery{Limit: 10, SourceURI: hint})
	}

	cases := []struct {
		name string
		ref  string
		hint string
		// want is the text discovery answers for ref, empty when discovery
		// cannot name it either.
		want string
	}{
		{name: "another session in the same root", ref: "codex-a", hint: "file://" + b, want: "session a"},
		{name: "a file outside every root", ref: "codex-a", hint: "file://" + c, want: "session a"},
		{name: "a same-ref copy outside every root", ref: "codex-a", hint: "file://" + filepath.Join(outside, "copy.jsonl"), want: "session a"},
		{name: "a traversal out of a root", ref: "codex-a", hint: "file://" + filepath.Join(root, "..", filepath.Base(outside), "c.jsonl"), want: "session a"},
		{name: "a symlink", ref: "codex-b", hint: "file://" + link, want: "session b"},
		{name: "a file discovery cannot name", ref: "codex-c", hint: "file://" + c, want: ""},
		{name: "a file that is gone", ref: "codex-a", hint: "file://" + filepath.Join(root, "gone.jsonl"), want: "session a"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			page, err := read(t, tc.ref, tc.hint)
			if tc.want == "" {
				if err == nil {
					t.Fatalf("a hint discovery could not have produced read %d items", len(page.Items))
				}
				return
			}
			if err != nil {
				t.Fatalf("ReadHistory: %v", err)
			}
			if len(page.Items) != 1 || page.Items[0].Text != tc.want {
				t.Fatalf("items=%+v, want %q from discovery", page.Items, tc.want)
			}
		})
	}
}

// codexFile writes one minimal Codex session and returns its path.
func codexFile(t *testing.T, dir, name, ref, prompt string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	content := fmt.Sprintf(
		`{"payload":{"type":"session_meta","session_id":%q,"cwd":"/tmp/project"}}`+"\n"+
			`{"payload":{"type":"message","session_id":%q,"role":"user","content":%q}}`+"\n",
		ref, ref, prompt,
	)
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// A named source does not lift the catalog's own size bound.
//
// The bound is what keeps one oversized file from becoming the cost of every
// question about the catalog. A hint may skip the walk that finds a file; it
// may not make the file one this catalog would have refused to index.
func TestFileCatalogAppliesItsSizeBoundToANamedSource(t *testing.T) {
	root := t.TempDir()
	path := codexFile(t, root, "session.jsonl", "codex-1", "a message long enough to pass the bound")
	catalog := &FileCatalog{
		AgentID: "codex", Format: FormatCodex, Roots: []string{root}, MaxFileBytes: 16,
	}
	if _, err := catalog.ReadHistory(context.Background(), "codex-1", agent.HistoryQuery{
		Limit: 10, SourceURI: "file://" + path,
	}); err == nil {
		t.Fatal("a named source over the size bound was read")
	}
}

// A sidechain is not the conversation.
//
// A subagent's transcript records the parent session's id, so the ref check
// alone would accept it. Discovery never enters these directories, and a hint
// that names one must be refused for the same reason: the reader would be
// shown a tool's side conversation as the session itself.
func TestFileCatalogRefusesSidechainAndLinkedDirectories(t *testing.T) {
	root := t.TempDir()
	codexFile(t, root, "session.jsonl", "codex-1", "the conversation")
	sidechainDir := filepath.Join(root, "session", "subagents")
	if err := os.MkdirAll(sidechainDir, 0o700); err != nil {
		t.Fatal(err)
	}
	sidechain := codexFile(t, sidechainDir, "agent.jsonl", "codex-1", "the sidechain")

	outside := t.TempDir()
	copied := codexFile(t, outside, "copy.jsonl", "codex-1", "a copy outside")
	linkDir := filepath.Join(root, "linked")
	if err := os.Symlink(outside, linkDir); err != nil {
		t.Fatal(err)
	}
	// A link whose target is inside the roots but inside a skipped directory:
	// containment alone accepts it, so only the resolved skipped-component
	// check refuses it.
	sidechainAlias := filepath.Join(root, "alias")
	if err := os.Symlink(sidechainDir, sidechainAlias); err != nil {
		t.Fatal(err)
	}

	catalog := &FileCatalog{AgentID: "codex", Format: FormatCodex, Roots: []string{root}}
	for name, hint := range map[string]string{
		"a subagent transcript":         sidechain,
		"a directory symlink":           filepath.Join(linkDir, filepath.Base(copied)),
		"a link to a skipped directory": filepath.Join(sidechainAlias, "agent.jsonl"),
	} {
		t.Run(name, func(t *testing.T) {
			page, err := catalog.ReadHistory(context.Background(), "codex-1", agent.HistoryQuery{
				Limit: 10, SourceURI: "file://" + hint,
			})
			if err != nil {
				t.Fatalf("ReadHistory: %v", err)
			}
			if len(page.Items) != 1 || page.Items[0].Text != "the conversation" {
				t.Fatalf("items=%+v, want discovery's page rather than the hinted file", page.Items)
			}
		})
	}
}

// The two ways of finding a file answer the same page.
//
// The optimization is only safe if a hinted read is byte-for-byte what a walk
// would have produced: the same revision, the same cursors, the same messages.
// A field reconstructed from the row rather than the metadata scan drifts here
// and nowhere else, and a drifting cursor is a page that skips or repeats.
func TestFileCatalogHintAndDiscoveryReadTheSamePage(t *testing.T) {
	root := t.TempDir()
	path := codexFile(t, root, "session.jsonl", "codex-1", "one")
	extra := `{"payload":{"type":"message","session_id":"codex-1","role":"assistant","content":"two"}}
{"payload":{"type":"message","session_id":"codex-1","role":"user","content":"three"}}
`
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString(extra); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}

	catalog := &FileCatalog{AgentID: "codex", Format: FormatCodex, Roots: []string{root}}
	ctx := context.Background()
	discovered, err := catalog.ReadHistory(ctx, "codex-1", agent.HistoryQuery{Tail: true, Limit: 2})
	if err != nil {
		t.Fatalf("discovery tail: %v", err)
	}
	hinted, err := catalog.ReadHistory(ctx, "codex-1", agent.HistoryQuery{
		Tail: true, Limit: 2, SourceURI: "file://" + path,
	})
	if err != nil {
		t.Fatalf("hinted tail: %v", err)
	}
	if !reflect.DeepEqual(discovered, hinted) {
		t.Fatalf("the named source answered a different page:\n discovered=%+v\n hinted=%+v", discovered, hinted)
	}
	if discovered.PrevCursor == "" {
		t.Fatal("the fixture does not exercise a backward cursor")
	}
	olderDiscovered, err := catalog.ReadHistory(ctx, "codex-1", agent.HistoryQuery{
		Before: discovered.PrevCursor, Limit: 2,
	})
	if err != nil {
		t.Fatalf("discovery older: %v", err)
	}
	olderHinted, err := catalog.ReadHistory(ctx, "codex-1", agent.HistoryQuery{
		Before: discovered.PrevCursor, Limit: 2, SourceURI: "file://" + path,
	})
	if err != nil {
		t.Fatalf("hinted older: %v", err)
	}
	if !reflect.DeepEqual(olderDiscovered, olderHinted) {
		t.Fatalf("the older page differs: discovered=%+v hinted=%+v", olderDiscovered, olderHinted)
	}
}

// A file is named by the ref its records end with, as the metadata scan names
// it. A provider's forked file can mention two ids; answering a hint for the
// earlier one would serve a file discovery associates with the later session.
func TestFileCatalogNamesAFileByTheLastRefItRecords(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "session.jsonl")
	content := `{"payload":{"type":"session_meta","session_id":"codex-old","cwd":"/tmp/project"}}
{"payload":{"type":"message","session_id":"codex-old","role":"user","content":"one"}}
{"payload":{"type":"session_meta","session_id":"codex-new","cwd":"/tmp/project"}}
{"payload":{"type":"message","session_id":"codex-new","role":"user","content":"two"}}
`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	catalog := &FileCatalog{AgentID: "codex", Format: FormatCodex, Roots: []string{root}}
	sessions, err := catalog.List(context.Background(), agent.SessionQuery{Limit: 10})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(sessions) != 1 || sessions[0].ExternalRef != "codex-new" {
		t.Fatalf("sessions=%+v, want the file under its last ref", sessions)
	}
	if _, err := catalog.ReadHistory(context.Background(), "codex-old", agent.HistoryQuery{
		Limit: 10, SourceURI: "file://" + path,
	}); err == nil {
		t.Fatal("a hint for the earlier ref read a file discovery names by the later one")
	}
	page, err := catalog.ReadHistory(context.Background(), "codex-new", agent.HistoryQuery{
		Limit: 10, SourceURI: "file://" + path,
	})
	if err != nil {
		t.Fatalf("ReadHistory for the last ref: %v", err)
	}
	if len(page.Items) != 2 {
		t.Fatalf("items=%+v, want both messages", page.Items)
	}
}

// The tail reader and a whole-file scan agree on what a page is.
//
// Opening a session at its end is the common case, so it is answered from the
// end of the file. The page still has to be the page the scan would have kept:
// a suffix of whole records, no message split in half, and no boundary where
// two pages overlap or a message between them is lost.
func TestFileCatalogTailPagesAreTheSuffixTheScanWouldKeep(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "tail.jsonl")
	var b strings.Builder
	var want []string
	for i := 0; i < 12; i++ {
		blocks := 1 + i%3
		parts := make([]string, 0, blocks)
		for j := 0; j < blocks; j++ {
			text := fmt.Sprintf("r%d-b%d", i, j)
			want = append(want, text)
			parts = append(parts, fmt.Sprintf(`{"type":"text","text":%q}`, text))
		}
		role := "user"
		if i%2 == 1 {
			role = "assistant"
		}
		fmt.Fprintf(&b,
			`{"type":%q,"sessionId":"tail-session","uuid":"u%d","message":{"role":%q,"content":[%s]}}`+"\n",
			role, i, role, strings.Join(parts, ","))
	}
	if err := os.WriteFile(path, []byte(b.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	catalog := &FileCatalog{AgentID: "claude-code", Format: FormatClaude, Roots: []string{root}}
	ctx := context.Background()

	var pages [][]string
	before := ""
	for fetched := 0; ; fetched++ {
		if fetched > 20 {
			t.Fatal("the page walk does not end")
		}
		page, err := catalog.ReadHistory(ctx, "tail-session", agent.HistoryQuery{
			Tail: before == "", Before: before, Limit: 5,
		})
		if err != nil {
			t.Fatalf("page %d: %v", fetched, err)
		}
		pages = append(pages, itemTexts(page.Items))
		if page.PrevCursor == "" {
			break
		}
		before = page.PrevCursor
	}

	// Record boundaries in item positions: the fixture's records hold one to
	// three blocks each, and that is what the scan keeps whole.
	var ends []int
	next := 0
	for i := 0; i < 12; i++ {
		next += 1 + i%3
		ends = append(ends, next)
	}

	// Every page must be the suffix the whole-file scan would keep for the
	// boundary the newer page left behind — not merely some slice that tiles.
	// pages[0] is the tail, so it ends at the end of the transcript and each
	// following page ends where the one before it begins.
	end := len(want)
	for index, page := range pages {
		if len(page) == 0 {
			t.Fatalf("page %d is empty", index)
		}
		if len(page) > end || !reflect.DeepEqual(page, want[end-len(page):end]) {
			t.Fatalf("page %d=%v is not the entries before item %d", index, page, end)
		}
		// The maximal suffix ending at end: whole records, newest first, added
		// while they fit; the newest record is kept even when it alone exceeds
		// the limit.
		begin, total := end, 0
		for r := len(ends) - 1; r >= 0; r-- {
			if ends[r] > end {
				continue
			}
			from := 0
			if r > 0 {
				from = ends[r-1]
			}
			size := ends[r] - from
			if total > 0 && total+size > 5 {
				break
			}
			total += size
			begin = from
			if begin == 0 {
				break
			}
		}
		if got := end - begin; got != len(page) {
			t.Fatalf("page %d has %d items, the scan keeps %d before item %d", index, len(page), got, end)
		}
		end = begin
	}
	if end != 0 {
		t.Fatalf("the page walk stops at item %d, not 0", end)
	}
}

// A record larger than the first window does not hide the page behind it.
//
// The window starts small so an ordinary session costs one small read, and it
// grows until the page is decided. A record that alone fills a window must be
// re-read at the wider size, not counted twice.
func TestFileCatalogTailPageGrowsItsWindowForALongRecord(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "long.jsonl")
	pad := strings.Repeat("p", 1<<20)
	content := fmt.Sprintf(
		`{"type":"user","sessionId":"long-session","uuid":"u0","message":{"role":"user","content":"first"}}`+"\n"+
			`{"type":"assistant","sessionId":"long-session","uuid":"a0","padding":%q,"message":{"role":"assistant","content":"big"}}`+"\n"+
			`{"type":"user","sessionId":"long-session","uuid":"u1","message":{"role":"user","content":"last"}}`+"\n",
		pad,
	)
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	catalog := &FileCatalog{AgentID: "claude-code", Format: FormatClaude, Roots: []string{root}}
	ctx := context.Background()

	page, err := catalog.ReadHistory(ctx, "long-session", agent.HistoryQuery{Tail: true, Limit: 2})
	if err != nil {
		t.Fatalf("tail: %v", err)
	}
	if len(page.Items) != 2 || page.Items[0].Text != "big" || page.Items[1].Text != "last" {
		t.Fatalf("tail page=%v, want [big last]", itemTexts(page.Items))
	}
	if page.PrevCursor == "" {
		t.Fatal("tail page has no previous cursor")
	}
	older, err := catalog.ReadHistory(ctx, "long-session", agent.HistoryQuery{
		Before: page.PrevCursor, Limit: 2,
	})
	if err != nil {
		t.Fatalf("older: %v", err)
	}
	if len(older.Items) != 1 || older.Items[0].Text != "first" {
		t.Fatalf("older page=%v, want [first]", itemTexts(older.Items))
	}
	if older.PrevCursor != "" {
		t.Fatalf("older prev cursor=%q, want empty", older.PrevCursor)
	}
}

// A page cut in the middle of a record names the half it kept, and the page
// before it starts with the half it did not.
func TestFileCatalogReadsTheOlderHalfOfACutRecord(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "cut.jsonl")
	content := `{"type":"assistant","sessionId":"cut-session","uuid":"a0","message":{"role":"assistant","content":[{"type":"text","text":"b0"},{"type":"text","text":"b1"},{"type":"text","text":"b2"}]}}
{"type":"user","sessionId":"cut-session","uuid":"u1","message":{"role":"user","content":"newer"}}
`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	rev := sourceRevision(st)
	catalog := &FileCatalog{AgentID: "claude-code", Format: FormatClaude, Roots: []string{root}}
	ctx := context.Background()

	// The answer that named this cursor had to keep only the record's third
	// block, so this page begins with the first two.
	page, err := catalog.ReadHistory(ctx, "cut-session", agent.HistoryQuery{
		Before: encodeHistoryOffsetCursor(rev, 0, 2), Limit: 10,
	})
	if err != nil {
		t.Fatalf("before: %v", err)
	}
	if got := itemTexts(page.Items); !reflect.DeepEqual(got, []string{"b0", "b1"}) {
		t.Fatalf("older half=%v, want [b0 b1]", got)
	}
	if page.PrevCursor != "" {
		t.Fatalf("prev cursor=%q, want empty", page.PrevCursor)
	}

	// A block past the record's end is a cursor from a rewritten source; the
	// whole-file scan keeps the whole record there, and so does this reader.
	whole, err := catalog.ReadHistory(ctx, "cut-session", agent.HistoryQuery{
		Before: encodeHistoryOffsetCursor(rev, 0, 9), Limit: 10,
	})
	if err != nil {
		t.Fatalf("before past the end: %v", err)
	}
	if got := itemTexts(whole.Items); !reflect.DeepEqual(got, []string{"b0", "b1", "b2"}) {
		t.Fatalf("past-end page=%v, want the whole record", got)
	}
}

// A source that does not end in a newline, or uses CRLF, still pages.
func TestFileCatalogTailPageReadsAwkwardSources(t *testing.T) {
	root := t.TempDir()
	catalog := &FileCatalog{AgentID: "claude-code", Format: FormatClaude, Roots: []string{root}}
	ctx := context.Background()
	one := `{"type":"user","sessionId":%q,"uuid":"u0","message":{"role":"user","content":"one"}}`
	two := `{"type":"assistant","sessionId":%q,"uuid":"a0","message":{"role":"assistant","content":"two"}}`
	cases := []struct {
		name    string
		ref     string
		content string
	}{
		{"no trailing newline", "no-newline", fmt.Sprintf(one+"\n"+two, "no-newline", "no-newline")},
		{"crlf", "crlf-session", fmt.Sprintf(one+"\r\n"+two+"\r\n", "crlf-session", "crlf-session")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(root, tc.ref+".jsonl")
			if err := os.WriteFile(path, []byte(tc.content), 0o600); err != nil {
				t.Fatal(err)
			}
			page, err := catalog.ReadHistory(ctx, tc.ref, agent.HistoryQuery{
				Tail: true, Limit: 10, SourceURI: "file://" + path,
			})
			if err != nil {
				t.Fatalf("tail: %v", err)
			}
			if got := itemTexts(page.Items); !reflect.DeepEqual(got, []string{"one", "two"}) {
				t.Fatalf("page=%v, want [one two]", got)
			}
			if page.PrevCursor != "" {
				t.Fatalf("prev cursor=%q, want empty", page.PrevCursor)
			}
		})
	}
}

// A byte cursor from another revision is refused, and a line cursor is still
// read by the scan that counts lines.
func TestFileCatalogCursorShapesStayApart(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "shapes.jsonl")
	content := `{"type":"user","sessionId":"shape-session","uuid":"u0","message":{"role":"user","content":"one"}}
{"type":"assistant","sessionId":"shape-session","uuid":"a0","message":{"role":"assistant","content":"two"}}
{"type":"user","sessionId":"shape-session","uuid":"u1","message":{"role":"user","content":"three"}}
`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	rev := sourceRevision(st)
	catalog := &FileCatalog{AgentID: "claude-code", Format: FormatClaude, Roots: []string{root}}
	ctx := context.Background()

	if _, err := catalog.ReadHistory(ctx, "shape-session", agent.HistoryQuery{
		Before: encodeHistoryOffsetCursor("other-rev", 10, 0), Limit: 5,
	}); err == nil || !strings.Contains(err.Error(), "stale") {
		t.Fatalf("a byte cursor from another revision returned %v, want stale", err)
	}

	page, err := catalog.ReadHistory(ctx, "shape-session", agent.HistoryQuery{
		Before: encodeHistoryCursor(rev, 2, 0), Limit: 5,
	})
	if err != nil {
		t.Fatalf("line cursor: %v", err)
	}
	if got := itemTexts(page.Items); !reflect.DeepEqual(got, []string{"one", "two"}) {
		t.Fatalf("line-cursor page=%v, want [one two]", got)
	}

	// The whole transcript fits in one page, so there is nothing older to name:
	// an offset of zero is the start of the file, not a page before it.
	whole, err := catalog.ReadHistory(ctx, "shape-session", agent.HistoryQuery{Tail: true, Limit: 10})
	if err != nil {
		t.Fatalf("tail: %v", err)
	}
	if len(whole.Items) != 3 || whole.PrevCursor != "" {
		t.Fatalf("whole-file tail=%d items, prev=%q; want 3 items and no prev",
			len(whole.Items), whole.PrevCursor)
	}
}

func itemTexts(items []agent.HistoryItem) []string {
	out := make([]string, 0, len(items))
	for _, item := range items {
		out = append(out, item.Text)
	}
	return out
}
