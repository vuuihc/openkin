package rawpty_test

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/vuuihc/kin/internal/adapter"
	"github.com/vuuihc/kin/internal/adapter/rawpty"
	"github.com/vuuihc/kin/internal/store"
	"github.com/vuuihc/kin/internal/task"
)

func TestRawptyPrintfSucceeds(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	ad := rawpty.New()
	eng := task.NewEngineFromAdapters(st, map[string]adapter.Adapter{"rawpty": ad}, task.NewBus(), 4)
	defer eng.Close()
	_ = eng.Recover(context.Background())

	cwd := t.TempDir()
	created, err := eng.Create(context.Background(), task.CreateRequest{
		Agent:  "rawpty",
		Cwd:    cwd,
		Prompt: `printf 'kin-rawpty-ok\n'; exit 0`,
	})
	if err != nil {
		t.Fatal(err)
	}

	final := waitTerminal(t, eng, created.ID, 5*time.Second)
	if final.Status != task.StatusSucceeded {
		evs, _ := eng.Events(context.Background(), created.ID, 0)
		t.Fatalf("status=%s events=%v", final.Status, evs)
	}
	if final.ExitCode == nil || *final.ExitCode != 0 {
		t.Fatalf("exit_code=%v", final.ExitCode)
	}

	evs, err := eng.Events(context.Background(), created.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	var out strings.Builder
	sawResult := false
	for _, e := range evs {
		if e.Type == "raw_output" {
			out.Write(e.Payload)
		}
		if e.Type == "result" {
			sawResult = true
		}
	}
	if !sawResult {
		t.Fatal("missing result event")
	}
	if !strings.Contains(out.String(), "kin-rawpty-ok") {
		t.Fatalf("output missing marker: %s", out.String())
	}
	if final.CostUSD != nil {
		t.Fatalf("rawpty should have no cost, got %v", final.CostUSD)
	}
}

func TestRawptyCancel(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	ad := rawpty.New()
	eng := task.NewEngineFromAdapters(st, map[string]adapter.Adapter{"rawpty": ad}, task.NewBus(), 4)
	defer eng.Close()
	_ = eng.Recover(context.Background())

	created, err := eng.Create(context.Background(), task.CreateRequest{
		Agent:  "rawpty",
		Cwd:    t.TempDir(),
		Prompt: `sleep 30`,
	})
	if err != nil {
		t.Fatal(err)
	}

	// Wait until running.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		t0, _ := eng.Get(context.Background(), created.ID)
		if t0.Status == task.StatusRunning {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	canceled, err := eng.Cancel(context.Background(), created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if canceled.Status != task.StatusCanceled {
		// May still be running briefly until process dies; wait.
		final := waitTerminal(t, eng, created.ID, 8*time.Second)
		if final.Status != task.StatusCanceled {
			t.Fatalf("status=%s after cancel", final.Status)
		}
	} else {
		// Ensure process actually exits and engine settles.
		_ = waitStatus(t, eng, created.ID, task.StatusCanceled, 8*time.Second)
	}
}

func waitTerminal(t *testing.T, eng *task.Engine, id string, d time.Duration) store.Task {
	t.Helper()
	deadline := time.Now().Add(d)
	var final store.Task
	var err error
	for time.Now().Before(deadline) {
		final, err = eng.Get(context.Background(), id)
		if err != nil {
			t.Fatal(err)
		}
		if final.Status == task.StatusSucceeded || final.Status == task.StatusFailed || final.Status == task.StatusCanceled {
			return final
		}
		time.Sleep(20 * time.Millisecond)
	}
	evs, _ := eng.Events(context.Background(), id, 0)
	t.Fatalf("timeout waiting for terminal; status=%s events=%v", final.Status, evs)
	return final
}

func waitStatus(t *testing.T, eng *task.Engine, id, want string, d time.Duration) store.Task {
	t.Helper()
	deadline := time.Now().Add(d)
	var final store.Task
	for time.Now().Before(deadline) {
		final, _ = eng.Get(context.Background(), id)
		if final.Status == want {
			return final
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for %s; got %s", want, final.Status)
	return final
}
