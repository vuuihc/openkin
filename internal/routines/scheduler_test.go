package routines

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/vuuihc/kin/internal/adapter"
	"github.com/vuuihc/kin/internal/store"
	"github.com/vuuihc/kin/internal/task"
)

type stubAdapter struct{}

func (stubAdapter) Start(ctx context.Context, spec adapter.TaskSpec) (adapter.RunHandle, error) {
	return hangHandle{}, nil
}

type hangHandle struct{}

func (h hangHandle) Events() <-chan adapter.Event {
	ch := make(chan adapter.Event)
	close(ch)
	return ch
}
func (h hangHandle) Cancel() error { return nil }

func TestTickDispatchesDueAndAdvances(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })

	e := task.NewEngineFromAdapters(st, map[string]adapter.Adapter{
		"kin": stubAdapter{},
	}, task.NewBus(), 4)
	t.Cleanup(e.Close)

	ctx := context.Background()
	fixed := time.Unix(1_700_000_000, 0)
	nowMs := fixed.UnixMilli()

	r := store.Routine{
		ID: "r1", Cwd: t.TempDir(), Agent: "kin", Prompt: "check",
		IntervalSecs: 3600, Enabled: true,
		NextDueAt: nowMs - 1000, CreatedAt: nowMs - 10_000, Title: "T",
	}
	if err := st.InsertRoutine(ctx, r); err != nil {
		t.Fatal(err)
	}
	// Interactive task must remain unaffected.
	if err := st.InsertTask(ctx, store.Task{
		ID: "interactive", Title: "chat", Agent: "kin", Cwd: r.Cwd, Prompt: "hi",
		Status: "queued", CreatedAt: nowMs,
	}); err != nil {
		t.Fatal(err)
	}

	sch := &Scheduler{Store: st, Engine: e, Clock: func() time.Time { return fixed }}
	if err := sch.Tick(ctx); err != nil {
		t.Fatal(err)
	}

	// One routine-tagged task created.
	runs, err := st.ListTasks(ctx, store.ListTasksOpts{RoutineID: "r1", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 1 {
		t.Fatalf("runs=%d want 1", len(runs))
	}
	if runs[0].RoutineID != "r1" {
		t.Fatalf("routine_id=%q", runs[0].RoutineID)
	}

	// Interactive still present and untagged.
	it, err := st.GetTask(ctx, "interactive")
	if err != nil || it.RoutineID != "" {
		t.Fatalf("interactive=%+v err=%v", it, err)
	}

	got, err := st.GetRoutine(ctx, "r1")
	if err != nil {
		t.Fatal(err)
	}
	if got.NextDueAt <= nowMs {
		t.Fatalf("next_due_at not advanced: %d <= %d", got.NextDueAt, nowMs)
	}
	if got.LastRunAt == nil || *got.LastRunAt != nowMs {
		t.Fatalf("last_run_at=%v", got.LastRunAt)
	}

	// Second tick should not re-fire until next_due.
	if err := sch.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	runs, _ = st.ListTasks(ctx, store.ListTasksOpts{RoutineID: "r1", Limit: 10})
	if len(runs) != 1 {
		t.Fatalf("after second tick runs=%d", len(runs))
	}
}

func TestParseReportSignal(t *testing.T) {
	// Re-export path via task package.
	tldr, nw := task.ParseReportSignal("all good\nTLDR: 0 new PRs\nnoteworthy: false\n")
	if tldr != "0 new PRs" || nw {
		t.Fatalf("tldr=%q nw=%v", tldr, nw)
	}
	tldr, nw = task.ParseReportSignal("TLDR: auth middleware changed\nnoteworthy: true")
	if tldr != "auth middleware changed" || !nw {
		t.Fatalf("tldr=%q nw=%v", tldr, nw)
	}
}

// Ensure concurrent ticks do not panic (single-writer sqlite).
func TestTickConcurrentSafe(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	e := task.NewEngineFromAdapters(st, map[string]adapter.Adapter{"kin": stubAdapter{}}, task.NewBus(), 2)
	t.Cleanup(e.Close)
	ctx := context.Background()
	now := time.Now()
	_ = st.InsertRoutine(ctx, store.Routine{
		ID: "r1", Cwd: t.TempDir(), Agent: "kin", Prompt: "p",
		IntervalSecs: 60, Enabled: true, NextDueAt: now.UnixMilli() - 1, CreatedAt: now.UnixMilli(),
	})
	sch := &Scheduler{Store: st, Engine: e}
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = sch.Tick(ctx)
		}()
	}
	wg.Wait()
}
