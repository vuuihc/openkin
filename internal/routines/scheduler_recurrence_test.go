package routines

import (
	"context"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/task"
)

// A routine with a wall-clock rule fires at that time, not one interval after
// the last run. These tests pin the three behaviours that make the difference
// visible: the next due instant, a spent "once" rule, and a rule the build
// cannot read.

func recurrenceHarness(t *testing.T, now time.Time) (*store.Store, *Scheduler) {
	t.Helper()
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	e := task.NewEngineFromAdapters(st, map[string]adapter.Adapter{"kin": stubAdapter{}}, task.NewBus(), 4)
	t.Cleanup(e.Close)
	return st, &Scheduler{Store: st, Engine: e, Clock: func() time.Time { return now }}
}

func insertDueRecurringRoutine(t *testing.T, st *store.Store, id, rule string, dueAt time.Time) {
	t.Helper()
	if err := st.InsertRoutine(context.Background(), store.Routine{
		ID: id, Cwd: t.TempDir(), Agent: "kin", Prompt: "check",
		IntervalSecs: 3600, Enabled: true, Recurrence: rule,
		NextDueAt: dueAt.UnixMilli(), CreatedAt: dueAt.Add(-time.Hour).UnixMilli(), Title: "T",
	}); err != nil {
		t.Fatal(err)
	}
}

func routineRuns(t *testing.T, st *store.Store, id string) int {
	t.Helper()
	runs, err := st.ListTasks(context.Background(), store.ListTasksOpts{
		Scope: store.Unscoped(), RoutineID: id, Limit: 10,
	})
	if err != nil {
		t.Fatal(err)
	}
	return len(runs)
}

func TestTickSchedulesByTheWallClockRuleNotTheInterval(t *testing.T) {
	// 09:00 in Shanghai; the daemon clock is that afternoon.
	now := time.Date(2026, time.March, 2, 14, 0, 0, 0, mustLoad(t, "Asia/Shanghai"))
	st, sch := recurrenceHarness(t, now)
	rule := `{"kind":"daily","hour":9,"minute":0,"time_zone":"Asia/Shanghai"}`
	insertDueRecurringRoutine(t, st, "r-daily", rule, now.Add(-time.Hour))

	if err := sch.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if n := routineRuns(t, st, "r-daily"); n != 1 {
		t.Fatalf("runs = %d, want 1", n)
	}
	got, err := st.GetRoutine(context.Background(), "r-daily")
	if err != nil {
		t.Fatal(err)
	}
	// Tomorrow at 09:00 — not now + 3600s, and with no jitter, because the
	// user asked for a time of day.
	want := time.Date(2026, time.March, 3, 9, 0, 0, 0, mustLoad(t, "Asia/Shanghai")).UnixMilli()
	if got.NextDueAt != want {
		t.Fatalf("next_due_at = %d (%v), want %d (%v)",
			got.NextDueAt, time.UnixMilli(got.NextDueAt), want, time.UnixMilli(want))
	}
}

func TestOnceRoutineIsRetiredAfterItFires(t *testing.T) {
	now := time.Date(2026, time.March, 2, 14, 0, 0, 0, time.UTC)
	st, sch := recurrenceHarness(t, now)
	rule := `{"kind":"once","at":` + strconv.FormatInt(now.Add(-time.Minute).UnixMilli(), 10) + `,"time_zone":"UTC"}`
	insertDueRecurringRoutine(t, st, "r-once", rule, now.Add(-time.Minute))

	if err := sch.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if n := routineRuns(t, st, "r-once"); n != 1 {
		t.Fatalf("runs = %d, want 1", n)
	}
	got, err := st.GetRoutine(context.Background(), "r-once")
	if err != nil {
		t.Fatal(err)
	}
	if got.Enabled {
		t.Fatal("a once routine stayed enabled after firing; it would never be due again")
	}
	if got.LastOutcome != "dispatched" {
		t.Fatalf("last_outcome = %q", got.LastOutcome)
	}

	// A second tick must not resurrect it.
	if err := sch.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if n := routineRuns(t, st, "r-once"); n != 1 {
		t.Fatalf("after second tick runs = %d, want 1", n)
	}
}

func TestUnreadableRuleDoesNotRunAtTheWrongTime(t *testing.T) {
	now := time.Date(2026, time.March, 2, 14, 0, 0, 0, time.UTC)
	st, sch := recurrenceHarness(t, now)
	// A dropped weekday makes the rule invalid. Falling back to the interval
	// would run it at an arbitrary time; a "once" rule would repeat forever.
	insertDueRecurringRoutine(t, st, "r-bad", `{"kind":"weekly","hour":9}`, now.Add(-time.Hour))

	if err := sch.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if n := routineRuns(t, st, "r-bad"); n != 0 {
		t.Fatalf("runs = %d, want 0", n)
	}
	got, err := st.GetRoutine(context.Background(), "r-bad")
	if err != nil {
		t.Fatal(err)
	}
	if !got.Enabled {
		t.Fatal("an unreadable rule disabled the routine instead of reporting it")
	}
	if got.LastOutcome != "failed" || !strings.Contains(got.LastError, "recurrence") {
		t.Fatalf("outcome = %q, error = %q", got.LastOutcome, got.LastError)
	}
}

func TestSkipPolicyMeasuresTheRulesOwnPeriod(t *testing.T) {
	// A monthly routine three days late is on time by its own calendar. With
	// the interval's threshold (one hour) the skip policy would drop it.
	now := time.Date(2026, time.March, 4, 12, 0, 0, 0, mustLoad(t, "Asia/Shanghai"))
	st, sch := recurrenceHarness(t, now)
	rule := `{"kind":"monthly","hour":9,"days":[1],"time_zone":"Asia/Shanghai"}`
	insertDueRecurringRoutine(t, st, "r-monthly", rule, now.AddDate(0, 0, -3))
	if err := st.UpdateRoutine(context.Background(), "r-monthly", store.RoutinePatch{
		MissedRunPolicy: stringPtr("skip"),
	}); err != nil {
		t.Fatal(err)
	}

	if err := sch.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if n := routineRuns(t, st, "r-monthly"); n != 1 {
		t.Fatalf("runs = %d, want 1: a three-day-late monthly run is not a missed run", n)
	}
}
