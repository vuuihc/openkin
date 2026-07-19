package codex_test

import (
	"context"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/vuuihc/kin/internal/adapter"
	"github.com/vuuihc/kin/internal/adapter/codex"
	"github.com/vuuihc/kin/internal/store"
	"github.com/vuuihc/kin/internal/task"
)

// TestFakeCodexIntegration drives the codex adapter with a fake binary that
// replays canned JSONL — never needs a real `codex` install.
func TestFakeCodexIntegration(t *testing.T) {
	fake := writeFakeCodex(t)

	st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	// Seed default price table so engine can compute cost.
	if err := st.SetSetting(context.Background(), store.KeyPriceTable, store.DefaultPriceTableJSON); err != nil {
		t.Fatal(err)
	}

	ad := &codex.Adapter{Binary: fake}
	eng := task.NewEngineFromAdapters(st, map[string]adapter.Adapter{"codex": ad}, task.NewBus(), 4)
	defer eng.Close()
	if err := eng.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}

	model := codex.DefaultModel
	created, err := eng.Create(context.Background(), task.CreateRequest{
		Agent:  "codex",
		Cwd:    t.TempDir(),
		Prompt: "summarize this repo",
		Model:  &model,
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
	if final.SessionRef == nil || *final.SessionRef == "" {
		t.Fatal("missing session_ref (thread_id)")
	}
	if final.TokensIn != 1000 || final.TokensOut != 50 {
		t.Fatalf("tokens in=%d out=%d want 1000/50", final.TokensIn, final.TokensOut)
	}
	// Default table: gpt-5-codex in=1.25 out=10.0 per 1M tokens
	// cost = 1000/1e6*1.25 + 50/1e6*10.0 = 0.00125 + 0.0005 = 0.00175
	wantCost := 1000.0/1e6*1.25 + 50.0/1e6*10.0
	if final.CostUSD == nil || math.Abs(*final.CostUSD-wantCost) > 1e-9 {
		t.Fatalf("cost=%v want %v", final.CostUSD, wantCost)
	}

	evs, err := eng.Events(context.Background(), created.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	var types []string
	for _, e := range evs {
		types = append(types, e.Type)
	}
	if !contains(types, "task_started") || !contains(types, "message") || !contains(types, "result") {
		t.Fatalf("event types=%v", types)
	}
}

func writeFakeCodex(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "fake-codex")
	if runtime.GOOS == "windows" {
		path += ".bat"
	}
	// Replay a minimal successful transcript.
	script := `#!/bin/sh
# Fake Codex CLI for integration tests (exec --json JSONL).
# Args are ignored; always emit the same canned stream.
cat <<'EOF'
{"type":"thread.started","thread_id":"fake-thread-42"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Looks good."}}
{"type":"item.started","item":{"id":"item_2","type":"command_execution","command":"bash -lc echo hi","aggregated_output":"","exit_code":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"bash -lc echo hi","aggregated_output":"hi\n","exit_code":0,"status":"completed"}}
{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":0,"output_tokens":50,"reasoning_output_tokens":0}}
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
