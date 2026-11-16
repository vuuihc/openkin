package routines

import (
	"context"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/task"
)

// A routine's runs continue one agent session by default, and start over only
// when the routine says so.
//
// The run is still its own task and its own feed row; what is carried is the
// provider session id, which is what lets the agent see what previous runs
// found without the console embedding a second copy of the conversation.

func TestRoutineRunContinuesThePreviousSession(t *testing.T) {
	ref := "sess-previous"
	foreign := "other-machine"
	self := "this-machine"
	modelA := "model-a"

	for _, tc := range []struct {
		name         string
		mode         string
		previous     *store.Task
		routineModel string
		previousCwd  string
		previousStat string
		wantSession  string
		wantFreshRun bool
	}{
		{
			name:        "continue mode resumes the newest run's session",
			mode:        store.ConversationContinue,
			previous:    &store.Task{Agent: "kin", SessionRef: &ref},
			wantSession: ref,
		},
		{
			name:        "empty legacy mode also continues",
			mode:        "",
			previous:    &store.Task{Agent: "kin", SessionRef: &ref},
			wantSession: ref,
		},
		{
			name: "a session stamped by this machine continues",
			mode: store.ConversationContinue,
			previous: &store.Task{
				Agent: "kin", SessionRef: &ref, SessionRefDeviceID: &self,
			},
			wantSession: ref,
		},
		{
			name:         "fresh mode starts a new session",
			mode:         store.ConversationFresh,
			previous:     &store.Task{Agent: "kin", SessionRef: &ref},
			wantSession:  "",
			wantFreshRun: true,
		},
		{
			name:        "a different agent's session is not carried",
			mode:        store.ConversationContinue,
			previous:    &store.Task{Agent: "claude-code", SessionRef: &ref},
			wantSession: "",
		},
		{
			name: "a session minted on another machine is not carried",
			mode: store.ConversationContinue,
			previous: &store.Task{
				Agent: "kin", SessionRef: &ref, SessionRefDeviceID: &foreign,
			},
			wantSession: "",
		},
		{
			name:        "a run that never got a session has nothing to carry",
			mode:        store.ConversationContinue,
			previous:    &store.Task{Agent: "kin"},
			wantSession: "",
		},
		{
			name:        "a run from another directory is not resumed there",
			mode:        store.ConversationContinue,
			previous:    &store.Task{Agent: "kin", SessionRef: &ref},
			previousCwd: "/work/elsewhere",
			wantSession: "",
		},
		{
			name:         "a run on another model is not carried onto the new one",
			mode:         store.ConversationContinue,
			previous:     &store.Task{Agent: "kin", SessionRef: &ref},
			routineModel: "model-b",
			wantSession:  "",
		},
		{
			name:         "a run on the same model is carried",
			mode:         store.ConversationContinue,
			previous:     &store.Task{Agent: "kin", SessionRef: &ref, Model: &modelA},
			routineModel: modelA,
			wantSession:  ref,
		},
		{
			name:         "a live run is not resumed in parallel",
			mode:         store.ConversationContinue,
			previous:     &store.Task{Agent: "kin", SessionRef: &ref},
			previousStat: task.StatusRunning,
			wantSession:  "",
		},
		{
			name:         "a waiting-for-approval run is not resumed in parallel",
			mode:         store.ConversationContinue,
			previous:     &store.Task{Agent: "kin", SessionRef: &ref},
			previousStat: task.StatusWaitingApproval,
			wantSession:  "",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			st, err := store.Open(":memory:")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = st.Close() })
			engine := task.NewEngineFromAdapters(st, map[string]adapter.Adapter{
				"kin":         stubAdapter{},
				"claude-code": stubAdapter{},
			}, task.NewBus(), 4)
			t.Cleanup(engine.Close)

			ctx := context.Background()
			fixed := time.Unix(1_700_000_000, 0)
			nowMs := fixed.UnixMilli()
			routine := store.Routine{
				ID: "conv-routine", Cwd: t.TempDir(), Agent: "kin", Model: tc.routineModel,
				Prompt: "go", IntervalSecs: 3600, Enabled: true, NextDueAt: nowMs + 3600_000,
				CreatedAt: nowMs - 10_000, Title: "Conv", ConversationMode: tc.mode,
			}
			if err := st.InsertRoutine(ctx, routine); err != nil {
				t.Fatal(err)
			}
			if tc.previous != nil {
				previous := *tc.previous
				previous.ID = "previous-run"
				previous.Title = "previous"
				previous.Cwd = routine.Cwd
				if tc.previousCwd != "" {
					previous.Cwd = tc.previousCwd
				}
				previous.Prompt = "earlier"
				previous.Status = task.StatusSucceeded
				if tc.previousStat != "" {
					previous.Status = tc.previousStat
				}
				previous.CreatedAt = nowMs - 5_000
				previous.RoutineID = routine.ID
				if err := st.InsertTask(ctx, previous); err != nil {
					t.Fatal(err)
				}
			}

			// Two routine slots so a run can be dispatched while the fixture's
			// live run still holds one; otherwise the lane refuses first and
			// the session guard under test never runs.
			total, concurrency := 2, 0
			if tc.previousStat != "" {
				total, concurrency = 3, 2
			}
			sch := &Scheduler{
				Store: st, Engine: engine, Clock: func() time.Time { return fixed },
				DeviceID: self, TotalConcurrency: total, Concurrency: concurrency,
			}
			created, err := sch.RunNow(ctx, routine.ID)
			if err != nil {
				t.Fatal(err)
			}
			var got string
			if created.SessionRef != nil {
				got = *created.SessionRef
			}
			if got != tc.wantSession {
				t.Fatalf("session_ref = %q, want %q", got, tc.wantSession)
			}
			if tc.wantFreshRun && created.SessionRef != nil {
				t.Fatalf("fresh run carried session_ref %q", *created.SessionRef)
			}
			// The run is still its own row in the feed: continuation is at the
			// session layer, not a second turn hidden inside the previous task.
			if created.RoutineID != routine.ID || created.ID == "previous-run" {
				t.Fatalf("created run = %+v, want a new routine-tagged task", created)
			}
		})
	}
}

// The scheduled path uses the same resolution as Run now: a routine that fires
// on its own must not lose the context its manual runs kept.
func TestScheduledRoutineRunContinuesThePreviousSession(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	engine := task.NewEngineFromAdapters(st, map[string]adapter.Adapter{
		"kin": stubAdapter{},
	}, task.NewBus(), 2)
	t.Cleanup(engine.Close)

	ctx := context.Background()
	fixed := time.Unix(1_700_000_000, 0)
	nowMs := fixed.UnixMilli()
	routine := store.Routine{
		ID: "scheduled-conv", Cwd: t.TempDir(), Agent: "kin", Prompt: "go",
		IntervalSecs: 3600, Enabled: true, NextDueAt: nowMs - 1,
		CreatedAt: nowMs - 10_000, Title: "Scheduled",
	}
	if err := st.InsertRoutine(ctx, routine); err != nil {
		t.Fatal(err)
	}
	ref := "sess-scheduled"
	if err := st.InsertTask(ctx, store.Task{
		ID: "prior-run", Title: "prior", Agent: "kin", Cwd: routine.Cwd,
		Prompt: "earlier", Status: task.StatusSucceeded, CreatedAt: nowMs - 5_000,
		RoutineID: routine.ID, SessionRef: &ref,
	}); err != nil {
		t.Fatal(err)
	}

	sch := &Scheduler{
		Store: st, Engine: engine, Clock: func() time.Time { return fixed },
		TotalConcurrency: 2,
	}
	if err := sch.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	runs, err := st.ListTasks(ctx, store.ListTasksOpts{
		Scope: store.Unscoped(), RoutineID: routine.ID, Limit: 10,
	})
	if err != nil {
		t.Fatal(err)
	}
	var created *store.Task
	for i := range runs {
		if runs[i].ID != "prior-run" {
			created = &runs[i]
			break
		}
	}
	if created == nil {
		t.Fatalf("tick created no run: %+v", runs)
	}
	if created.SessionRef == nil || *created.SessionRef != ref {
		t.Fatalf("session_ref = %v, want %q", created.SessionRef, ref)
	}
}
