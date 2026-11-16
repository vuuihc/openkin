package eval

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/task"
)

type evalAdapter struct{}

type evalHandle struct{ events chan adapter.Event }

func (h *evalHandle) Events() <-chan adapter.Event { return h.events }
func (h *evalHandle) Cancel() error                { return nil }

func (evalAdapter) Start(context.Context, adapter.TaskSpec) (adapter.RunHandle, error) {
	ch := make(chan adapter.Event, 3)
	ch <- adapter.Event{Type: "task_started", Payload: json.RawMessage(`{"session_id":"eval"}`)}
	ch <- adapter.Event{Type: "message", Payload: json.RawMessage(`{"content":"expected text"}`)}
	ch <- adapter.Event{Type: "result", Payload: json.RawMessage(`{"is_error":false,"tokens_in":2,"tokens_out":3}`)}
	close(ch)
	return &evalHandle{events: ch}, nil
}

func TestRunnerCreatesTasksAndReport(t *testing.T) {
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	eng := task.NewEngineFromAdapters(st, map[string]adapter.Adapter{"claude-code": evalAdapter{}}, task.NewBus(), 2)
	defer eng.Close()
	if err := eng.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	suiteDir := filepath.Join(dir, "suites", "smoke")
	if err := os.MkdirAll(suiteDir, 0o700); err != nil {
		t.Fatal(err)
	}
	suite := Suite{
		Name: "smoke", Version: "v1", Cases: []Case{{
			ID: "one", Cwd: dir, Agent: "claude-code", Prompt: "run",
			Expect: Expectation{TextContains: []string{"expected text"}},
		}},
	}
	data, _ := json.Marshal(suite)
	if err := os.WriteFile(filepath.Join(suiteDir, "suite.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	runner := &Runner{Store: st, Engine: eng, SuitesDir: filepath.Join(dir, "suites"), ArtifactsDir: filepath.Join(dir, "artifacts"), PollInterval: time.Millisecond}
	run, err := runner.Start(context.Background(), RunRequest{Suite: "smoke", Repetitions: 2})
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		got, getErr := st.GetEvalRun(context.Background(), run.ID)
		if getErr == nil && got.Status != "running" {
			if got.Status != "succeeded" || got.ReportArtifactID == "" {
				t.Fatalf("run=%+v", got)
			}
			results, err := st.ListEvalResults(context.Background(), run.ID)
			if err != nil || len(results) != 2 {
				t.Fatalf("results=%d err=%v", len(results), err)
			}
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("eval run did not finish")
}

func TestCountTurnsExcludesOrchestratorSummary(t *testing.T) {
	events := []store.Event{
		{Type: "result", Payload: json.RawMessage(`{"source":"worker","is_error":false}`)},
		{Type: "result", Payload: json.RawMessage(`{"source":"orchestrator","is_error":false}`)},
	}
	if got := countTurns(events, 0); got != 1 {
		t.Fatalf("countTurns=%d, want one provider result", got)
	}
	if got := countTurns([]store.Event{
		{Type: "result", Payload: json.RawMessage(`{"source":"orchestrator"}`)},
	}, 3); got != 3 {
		t.Fatalf("countTurns fallback=%d, want usage fallback", got)
	}
	if got := countTurns([]store.Event{
		{Type: "usage", Payload: json.RawMessage(`{"source":"controller","tokens_in":10}`)},
	}, 3); got != 0 {
		t.Fatalf("countTurns controller-only=%d, want zero provider turns", got)
	}
	if got := countTurns([]store.Event{
		{Type: "usage", Payload: json.RawMessage(`{"source":"codex","tokens_in":10}`)},
	}, 3); got != 1 {
		t.Fatalf("countTurns provider usage=%d, want one provider turn", got)
	}
	if got := countTurns([]store.Event{
		{Type: "usage", Payload: json.RawMessage(`{"source":"codex","tokens_in":10}`)},
		{Type: "result", Payload: json.RawMessage(`{"source":"worker"}`)},
	}, 3); got != 1 {
		t.Fatalf("countTurns mixed usage/result=%d, want usage count", got)
	}
}
