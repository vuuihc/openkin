package routines

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/task"
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
		ID: "r1", Cwd: t.TempDir(), Agent: "kin", Model: "claude-sonnet-5-5", Prompt: "check",
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
	runs, err := st.ListTasks(ctx, store.ListTasksOpts{Scope: store.Unscoped(), RoutineID: "r1", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 1 {
		t.Fatalf("runs=%d want 1", len(runs))
	}
	if runs[0].RoutineID != "r1" {
		t.Fatalf("routine_id=%q", runs[0].RoutineID)
	}
	// The tick path carries the model end to end: the scan reads it, the
	// scheduler maps it, and the task row the run starts from holds it.
	if runs[0].Model == nil || *runs[0].Model != "claude-sonnet-5-5" {
		t.Fatalf("run model = %v, want the routine's model", runs[0].Model)
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
	runs, _ = st.ListTasks(ctx, store.ListTasksOpts{Scope: store.Unscoped(), RoutineID: "r1", Limit: 10})
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

func TestTickReservesOnlyInteractiveSlotWhenEngineHasOneWorker(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	e := task.NewEngineFromAdapters(st, map[string]adapter.Adapter{"kin": stubAdapter{}}, task.NewBus(), 1)
	t.Cleanup(e.Close)
	now := time.Now()
	ctx := context.Background()
	if err := st.InsertRoutine(ctx, store.Routine{
		ID: "r1", Cwd: t.TempDir(), Agent: "kin", Prompt: "p",
		IntervalSecs: 60, Enabled: true, NextDueAt: now.UnixMilli() - 1, CreatedAt: now.UnixMilli(),
	}); err != nil {
		t.Fatal(err)
	}
	sch := &Scheduler{Store: st, Engine: e, TotalConcurrency: 1}
	if err := sch.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	runs, err := st.ListTasks(ctx, store.ListTasksOpts{Scope: store.Unscoped(), RoutineID: "r1", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 0 {
		t.Fatalf("routine consumed the only worker slot: %d runs", len(runs))
	}
	health, err := st.RoutineHealthSnapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if health.DueBacklog != 1 {
		t.Fatalf("due backlog=%d want 1", health.DueBacklog)
	}
}

func TestTickDoesNotTreatRecoveredTerminalDispatchAsSuccess(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	e := task.NewEngineFromAdapters(st, map[string]adapter.Adapter{"kin": stubAdapter{}}, task.NewBus(), 2)
	t.Cleanup(e.Close)

	ctx := context.Background()
	fixed := time.Unix(1_700_000_000, 0)
	nowMs := fixed.UnixMilli()
	r := store.Routine{
		ID: "recovery-routine", Cwd: t.TempDir(), Agent: "kin", Prompt: "recover",
		IntervalSecs: 60, Enabled: true, NextDueAt: nowMs - 1, CreatedAt: nowMs - 1000,
	}
	if err := st.InsertRoutine(ctx, r); err != nil {
		t.Fatal(err)
	}
	if err := st.InsertTask(ctx, store.Task{
		ID: "recovered-task", Title: "recovered", Agent: "kin", Cwd: r.Cwd,
		Prompt: r.Prompt, Status: task.StatusFailed, CreatedAt: nowMs,
		RoutineID: r.ID,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := st.BeginRoutineDispatch(ctx, r.ID, r.NextDueAt, "recovered-task", nowMs); err != nil {
		t.Fatal(err)
	}

	sch := &Scheduler{
		Store: st, Engine: e, Clock: func() time.Time { return fixed }, TotalConcurrency: 2,
	}
	if err := sch.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	got, err := st.GetRoutine(ctx, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.LastOutcome != "failed" {
		t.Fatalf("last outcome=%q want failed", got.LastOutcome)
	}
	if !strings.Contains(got.LastError, "terminal task status") {
		t.Fatalf("last error=%q", got.LastError)
	}
	var state string
	if err := st.DB().QueryRowContext(ctx,
		`SELECT state FROM routine_dispatches WHERE routine_id = ? AND due_at = ?`,
		r.ID, r.NextDueAt,
	).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "failed" {
		t.Fatalf("dispatch state=%q want failed", state)
	}
}

func TestTickRecoversManualDispatchWithoutCreatingDuplicate(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	e := task.NewEngineFromAdapters(st, map[string]adapter.Adapter{"kin": stubAdapter{}}, task.NewBus(), 1)
	t.Cleanup(e.Close)

	ctx := context.Background()
	fixed := time.Unix(1_700_000_000, 0)
	nowMs := fixed.UnixMilli()
	r := store.Routine{
		ID: "manual-recovery", Cwd: t.TempDir(), Agent: "kin", Prompt: "manual",
		IntervalSecs: 60, Enabled: true, NextDueAt: nowMs + 60_000, CreatedAt: nowMs,
	}
	if err := st.InsertRoutine(ctx, r); err != nil {
		t.Fatal(err)
	}
	dueAt := nowMs*1000 + 1
	if _, _, err := st.BeginManualRoutineDispatch(ctx, r.ID, dueAt, "manual-task", nowMs); err != nil {
		t.Fatal(err)
	}
	if err := st.InsertTask(ctx, store.Task{
		ID: "manual-task", Title: "manual", Agent: "kin", Cwd: r.Cwd,
		Prompt: r.Prompt, Status: task.StatusQueued, CreatedAt: nowMs, RoutineID: r.ID,
	}); err != nil {
		t.Fatal(err)
	}

	sch := &Scheduler{
		Store: st, Engine: e, Clock: func() time.Time { return fixed }, TotalConcurrency: 2,
	}
	if err := sch.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	var state string
	if err := st.DB().QueryRowContext(ctx,
		`SELECT state FROM routine_dispatches WHERE routine_id = ? AND due_at = ?`,
		r.ID, dueAt,
	).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "dispatched" {
		t.Fatalf("dispatch state=%q want dispatched", state)
	}
	runs, err := st.ListTasks(ctx, store.ListTasksOpts{Scope: store.Unscoped(), RoutineID: r.ID, Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 1 || runs[0].ID != "manual-task" {
		t.Fatalf("runs=%+v", runs)
	}
}

// A routine's runs start on the model it remembers. An empty model is the
// agent's own default, so no model field is sent at all rather than "".
func TestRoutineCreateRequestCarriesTheModel(t *testing.T) {
	s := &Scheduler{}
	model := "claude-sonnet-5-5"
	req := s.routineCreateRequest(store.Routine{
		ID: "r1", Cwd: "/work/app", Agent: "claude-code", Model: model, Prompt: "go",
	}, "task-1")
	if req.Model == nil || *req.Model != model {
		t.Fatalf("model = %v, want %q", req.Model, model)
	}

	req = s.routineCreateRequest(store.Routine{
		ID: "r2", Cwd: "/work/app", Agent: "claude-code", Prompt: "go",
	}, "task-2")
	if req.Model != nil {
		t.Fatalf("model = %q, want none for the agent default", *req.Model)
	}
}

// A prompt that merely mentions "noteworthy:" in prose still needs the report
// trailer. The gap sweep's prompt does exactly that, and the old substring
// check treated the mention as "trailer already present": agents never emitted
// TL;DR/noteworthy, so sweep runs finished silently and no push was sent.
func TestRoutineCreateRequestAppendsReportTrailerUnlessItIsAlreadyThere(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	s := &Scheduler{Store: st}

	prose := "Report the signal: noteworthy: true when the user must act."
	req := s.routineCreateRequest(store.Routine{
		ID: "r1", Cwd: "/work/app", Agent: "claude-code", Prompt: prose,
	}, "task-1")
	if !strings.Contains(req.Prompt, task.ReportSignalMarker) {
		t.Fatalf("prompt missing report trailer: %q", req.Prompt)
	}
	if !strings.Contains(req.Prompt, prose) {
		t.Fatalf("prompt lost the routine instructions: %q", req.Prompt)
	}

	already := prose + task.ReportSignalTrailer
	req = s.routineCreateRequest(store.Routine{
		ID: "r2", Cwd: "/work/app", Agent: "claude-code", Prompt: already,
	}, "task-2")
	if got, want := strings.Count(req.Prompt, task.ReportSignalMarker), 1; got != want {
		t.Fatalf("trailer count = %d, want %d (must not double-append)", got, want)
	}
}
