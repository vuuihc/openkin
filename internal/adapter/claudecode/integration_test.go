package claudecode_test

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/adapter/claudecode"
	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/task"
)

// TestFakeAgentIntegration runs a task end-to-end with a shell script that
// emits canned stream-json — CI never needs real `claude`.
func TestFakeAgentIntegration(t *testing.T) {
	fake := writeFakeClaude(t)

	st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	ad := &claudecode.Adapter{Binary: fake}
	eng := task.NewEngineFromAdapters(st, map[string]adapter.Adapter{"claude-code": ad}, task.NewBus(), 4)
	defer eng.Close()
	if err := eng.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}

	created, err := eng.Create(context.Background(), task.CreateRequest{
		Agent:  "claude-code",
		Cwd:    t.TempDir(),
		Prompt: "hello from fake agent",
	})
	if err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(5 * time.Second)
	var final store.Task
	for time.Now().Before(deadline) {
		final, err = eng.Get(context.Background(), created.ID)
		if err != nil {
			t.Fatal(err)
		}
		if final.Status == task.StatusSucceeded || final.Status == task.StatusFailed {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if final.Status != task.StatusSucceeded {
		evs, _ := eng.Events(context.Background(), created.ID, 0)
		t.Fatalf("status=%s events=%v", final.Status, evs)
	}
	if final.CostUSD == nil || *final.CostUSD <= 0 {
		t.Fatalf("cost=%v", final.CostUSD)
	}
	if final.TokensIn == 0 || final.TokensOut == 0 {
		t.Fatalf("tokens in=%d out=%d", final.TokensIn, final.TokensOut)
	}
	if final.SessionRef == nil || *final.SessionRef == "" {
		t.Fatal("missing session_ref")
	}

	evs, err := eng.Events(context.Background(), created.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	var types []string
	for _, e := range evs {
		types = append(types, e.Type)
	}
	// Expect init → message(s) → result sequence.
	if !contains(types, "task_started") || !contains(types, "message") || !contains(types, "result") {
		t.Fatalf("event types=%v", types)
	}
}

// TestFakeAgentIntegrationEmitsToolResult proves the end-to-end contract the
// console relies on: a tool call and its result arrive as their own stored
// events with matching ids, so the step can close while the turn continues.
func TestFakeAgentIntegrationEmitsToolResult(t *testing.T) {
	fake := writeFakeClaudeToolStream(t)

	st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	ad := &claudecode.Adapter{Binary: fake}
	eng := task.NewEngineFromAdapters(st, map[string]adapter.Adapter{"claude-code": ad}, task.NewBus(), 4)
	defer eng.Close()
	if err := eng.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}

	created, err := eng.Create(context.Background(), task.CreateRequest{
		Agent:  "claude-code",
		Cwd:    t.TempDir(),
		Prompt: "read the readme",
	})
	if err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(5 * time.Second)
	var final store.Task
	for time.Now().Before(deadline) {
		final, err = eng.Get(context.Background(), created.ID)
		if err != nil {
			t.Fatal(err)
		}
		if final.Status == task.StatusSucceeded || final.Status == task.StatusFailed {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	evs, err := eng.Events(context.Background(), created.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if final.Status != task.StatusSucceeded {
		t.Fatalf("status=%s events=%v", final.Status, evs)
	}

	var toolUseID, resultID string
	var resultOK *bool
	for _, e := range evs {
		switch e.Type {
		case "tool_use":
			var payload struct {
				Content struct {
					ID string `json:"id"`
				} `json:"content"`
			}
			if err := json.Unmarshal(e.Payload, &payload); err != nil {
				t.Fatalf("tool_use payload: %v", err)
			}
			toolUseID = payload.Content.ID
		case "tool_result":
			var payload struct {
				ToolUseID string `json:"tool_use_id"`
				OK        *bool  `json:"ok"`
			}
			if err := json.Unmarshal(e.Payload, &payload); err != nil {
				t.Fatalf("tool_result payload: %v", err)
			}
			resultID = payload.ToolUseID
			resultOK = payload.OK
		}
	}
	if toolUseID == "" {
		t.Fatalf("no tool_use event in %v", evs)
	}
	if resultID == "" {
		t.Fatalf("no tool_result event in %v", evs)
	}
	if resultID != toolUseID {
		t.Fatalf("tool_result id=%q does not pair with tool_use id=%q", resultID, toolUseID)
	}
	if resultOK == nil || !*resultOK {
		t.Fatalf("tool_result ok=%v, want true", resultOK)
	}
}

func TestMissingBinaryFails(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	ad := &claudecode.Adapter{
		Binary: "claude-not-installed-xyz",
		LookPath: func(file string) (string, error) {
			return "", exec.ErrNotFound
		},
	}
	eng := task.NewEngineFromAdapters(st, map[string]adapter.Adapter{"claude-code": ad}, task.NewBus(), 4)
	defer eng.Close()
	_ = eng.Recover(context.Background())

	created, err := eng.Create(context.Background(), task.CreateRequest{
		Agent: "claude-code", Cwd: t.TempDir(), Prompt: "x",
	})
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	var final store.Task
	for time.Now().Before(deadline) {
		final, _ = eng.Get(context.Background(), created.ID)
		if final.Status == task.StatusFailed {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if final.Status != task.StatusFailed {
		t.Fatalf("status=%s", final.Status)
	}
	evs, _ := eng.Events(context.Background(), created.ID, 0)
	found := false
	for _, e := range evs {
		if e.Type == "error" {
			found = true
		}
	}
	if !found {
		t.Fatalf("want error event, got %v", evs)
	}
}

func writeFakeClaude(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "fake-claude")
	if runtime.GOOS == "windows" {
		path += ".bat"
	}
	script := `#!/bin/sh
# Fake Claude Code agent for integration tests (stream-json).
cat <<'EOF'
{"type":"system","subtype":"init","session_id":"fake-session-1","cwd":"/tmp"}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hi there"}]}}
{"type":"result","subtype":"success","is_error":false,"result":"Hi there","session_id":"fake-session-1","total_cost_usd":0.00123,"usage":{"input_tokens":100,"output_tokens":10}}
EOF
`
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

// writeFakeClaudeToolStream emits a turn that calls one tool and receives its
// result while the turn is still running, then ends.
func writeFakeClaudeToolStream(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "fake-claude-tools")
	if runtime.GOOS == "windows" {
		path += ".bat"
	}
	script := `#!/bin/sh
cat <<'EOF'
{"type":"system","subtype":"init","session_id":"fake-session-tool","cwd":"/tmp"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Let me read that."}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_fake_01","name":"Read","input":{"file_path":"/tmp/repo/README.md"}}]}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_fake_01","content":"# Kin\n"}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Done."}]}}
{"type":"result","subtype":"success","is_error":false,"result":"Done.","session_id":"fake-session-tool","total_cost_usd":0.00123,"usage":{"input_tokens":100,"output_tokens":10}}
EOF
`
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func contains(ss []string, want string) bool {
	for _, s := range ss {
		if s == want {
			return true
		}
	}
	return false
}
