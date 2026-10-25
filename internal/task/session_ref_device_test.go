package task

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/store"
)

// The ref is only resolvable by the machine whose agent minted it, so the
// resumability question is entirely about provenance (ADR 0022 D6). This is the
// single judgement both callers share — the follow-up gate in approvals.go and
// the spec builder in engine.go — so it is tested directly rather than through
// either of them.
func TestSessionRefResumableIsAboutTheMachineThatMintedTheRef(t *testing.T) {
	e, _ := testEngine(t, 4, &fakeAdapter{events: successEvents()})
	e.SetRemoteRunner("this-machine", nil)

	ref := "s1"
	cases := []struct {
		name string
		task store.Task
		want bool
	}{
		{
			name: "minted here, runs here",
			task: store.Task{SessionRef: &ref, SessionRefDeviceID: strPtr("this-machine")},
			want: true,
		},
		{
			name: "minted elsewhere, runs here",
			task: store.Task{SessionRef: &ref, SessionRefDeviceID: strPtr("other-machine")},
			want: false,
		},
		{
			name: "minted on the machine that will run it",
			task: store.Task{
				SessionRef: &ref, SessionRefDeviceID: strPtr("other-machine"),
				ExecutingDeviceID: "other-machine",
			},
			want: true,
		},
		{
			name: "minted here, but the turn now runs elsewhere",
			task: store.Task{
				SessionRef: &ref, SessionRefDeviceID: strPtr("this-machine"),
				ExecutingDeviceID: "other-machine",
			},
			want: false,
		},
		{
			// Rows written before the column existed were all written by this
			// daemon. Reading "unknown" as "elsewhere" would throw away the
			// continuity of every conversation that predates the column.
			name: "no provenance at all (a row from before the column)",
			task: store.Task{SessionRef: &ref},
			want: true,
		},
		{
			name: "no ref",
			task: store.Task{SessionRefDeviceID: strPtr("this-machine")},
			want: false,
		},
		{
			name: "blank ref",
			task: store.Task{SessionRef: strPtr("  "), SessionRefDeviceID: strPtr("this-machine")},
			want: false,
		},
		{
			// A daemon with no device id of its own: `isRemoteDevice` reads ""
			// as "here", and this must agree with it or the two disagree on
			// every row of a standalone install.
			name: "blank provenance on a task with no executing device",
			task: store.Task{SessionRef: &ref, SessionRefDeviceID: strPtr("")},
			want: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := e.sessionRefResumable(tc.task); got != tc.want {
				t.Fatalf("sessionRefResumable = %v, want %v", got, tc.want)
			}
		})
	}
}

// The user-visible half of the same rule. Refusing to resume is only half the
// fix: a turn that declines the ref and then runs with a bare prompt is the
// silent context restart this exists to prevent — the agent answers as if the
// conversation never happened, and nothing says so.
func TestFollowUpOnARefFromAnotherMachineRebuildsInsteadOfRunningBare(t *testing.T) {
	ctx := context.Background()
	ad := &fakeAdapter{events: successEvents()}
	e, st := testEngine(t, 4, ad)
	e.SetRemoteRunner("this-machine", nil)

	created, err := e.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: "/tmp", Prompt: "first"})
	if err != nil {
		t.Fatal(err)
	}
	waitStatus(t, e, created.ID, StatusSucceeded, 2*time.Second)

	// The row a device-scoped binding produces: this task is executed here, but
	// its ref was minted by another machine's agent.
	if err := st.UpdateTask(ctx, created.ID, store.TaskPatch{
		SessionRef:         strPtr("other-session"),
		SessionRefDeviceID: strPtr("other-machine"),
	}); err != nil {
		t.Fatal(err)
	}

	if _, err := e.FollowUpWith(ctx, created.ID, FollowUpRequest{Prompt: "second"}); err != nil {
		t.Fatal(err)
	}
	waitStatus(t, e, created.ID, StatusSucceeded, 2*time.Second)

	ad.mu.Lock()
	spec := ad.lastSpec
	ad.mu.Unlock()
	if spec.SessionRef != "" {
		t.Fatalf("the adapter was handed %q, a session id another machine's agent minted", spec.SessionRef)
	}
	if spec.Prompt == "second" {
		t.Fatal("the turn ran bare: the ref was refused and no context was rebuilt")
	}
	if !strings.Contains(spec.Prompt, "Continue this Kin task.") {
		t.Fatalf("expected a rebuilt context pack, got %q", spec.Prompt)
	}
	if !strings.Contains(spec.Prompt, "second") {
		t.Fatalf("the pack dropped the user's request: %q", spec.Prompt)
	}
}

// Refusing to *use* the ref here is not the same as forgetting it. The binding
// is still true — that machine still holds that session, and a task that runs
// there again should pick it back up.
func TestARefFromAnotherMachineSurvivesALocalTurn(t *testing.T) {
	ctx := context.Background()
	ad := &fakeAdapter{events: successEvents()}
	e, st := testEngine(t, 4, ad)
	e.SetRemoteRunner("this-machine", nil)

	created, err := e.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: "/tmp", Prompt: "first"})
	if err != nil {
		t.Fatal(err)
	}
	waitStatus(t, e, created.ID, StatusSucceeded, 2*time.Second)

	if err := st.UpdateTask(ctx, created.ID, store.TaskPatch{
		SessionRef:         strPtr("other-session"),
		SessionRefDeviceID: strPtr("other-machine"),
	}); err != nil {
		t.Fatal(err)
	}
	// The ref must still be readable before the local turn overwrites it with
	// the session that turn mints.
	before, err := e.Get(ctx, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !e.sessionRefResumable(store.Task{
		SessionRef:         before.SessionRef,
		SessionRefDeviceID: before.SessionRefDeviceID,
		ExecutingDeviceID:  "other-machine",
	}) {
		t.Fatal("the binding was not preserved for the machine that can resume it")
	}

	if _, err := e.FollowUpWith(ctx, created.ID, FollowUpRequest{Prompt: "second"}); err != nil {
		t.Fatal(err)
	}
	done := waitStatus(t, e, created.ID, StatusSucceeded, 2*time.Second)

	// The local turn minted its own session, and the provenance follows the ref
	// it came with — a row that named the old machine would be worse than no
	// provenance at all.
	if done.SessionRef == nil || *done.SessionRef == "" {
		t.Fatal("the local turn's own session was not recorded")
	}
	if done.SessionRefDeviceID == nil || *done.SessionRefDeviceID != "this-machine" {
		t.Fatalf("provenance after a local turn = %v, want this-machine", done.SessionRefDeviceID)
	}
}

// The case the extra conjunct exists for: a foreign ref and nothing on this
// machine to rebuild from.
//
// Through FollowUpWith this state is hard to reach, because the caller records
// the user's message before the turn is prepared and that message is itself the
// context block. It is not impossible — that append can fail, and a turn is
// still owed — so the guarantee is stated where it is enforced: given a foreign
// ref, applyFollowUp produces a pack, and "there is nothing to put in one" is
// not a reason to run bare without saying so.
func TestAForeignRefRunsWithAPackEvenWithNothingToRebuildFrom(t *testing.T) {
	ctx := context.Background()
	ad := &fakeAdapter{events: successEvents()}
	e, st := testEngine(t, 4, ad)
	e.SetRemoteRunner("this-machine", nil)

	row := store.Task{
		ID:                 "01TESTFOREIGNREF00000000000",
		Title:              "attached elsewhere",
		Agent:              "claude-code",
		Cwd:                "/tmp",
		Prompt:             "first",
		Status:             StatusSucceeded,
		CreatedAt:          store.NowMilli(),
		SessionRef:         strPtr("other-session"),
		SessionRefDeviceID: strPtr("other-machine"),
	}
	if err := st.InsertTask(ctx, row); err != nil {
		t.Fatal(err)
	}
	// Nothing has happened here: no events, so no context block.
	events, err := st.ListEvents(ctx, row.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 0 {
		t.Fatalf("fixture is wrong: %d events", len(events))
	}

	got, err := e.applyFollowUp(ctx, row.ID, row,
		FollowUpRequest{Prompt: "second"}, false /*interrupted*/, 0 /*userSeq*/, respectCancel)
	if err != nil {
		t.Fatal(err)
	}
	if strings.HasPrefix(got.Prompt, "second") {
		t.Fatalf("the turn ran bare with no sign that context was dropped: %q", got.Prompt)
	}
	if !strings.Contains(got.Prompt, "Continue this Kin task.") {
		t.Fatalf("expected a pack that at least says it is continuing, got %q", got.Prompt)
	}
	if !strings.Contains(got.Prompt, "second") {
		t.Fatalf("the pack dropped the user's request: %q", got.Prompt)
	}
}

// The control. Without this, "the fix works" and "resume is off everywhere"
// look identical in the suite: every assertion above passes if the gate simply
// refuses every ref.
func TestAFollowUpOnThisMachinesOwnRefStillResumes(t *testing.T) {
	ctx := context.Background()
	ad := &fakeAdapter{events: successEvents()}
	e, _ := testEngine(t, 4, ad)
	e.SetRemoteRunner("this-machine", nil)

	created, err := e.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: "/tmp", Prompt: "first"})
	if err != nil {
		t.Fatal(err)
	}
	waitStatus(t, e, created.ID, StatusSucceeded, 2*time.Second)

	if _, err := e.FollowUpWith(ctx, created.ID, FollowUpRequest{Prompt: "second"}); err != nil {
		t.Fatal(err)
	}
	waitStatus(t, e, created.ID, StatusSucceeded, 2*time.Second)

	ad.mu.Lock()
	spec := ad.lastSpec
	ad.mu.Unlock()
	if spec.SessionRef != "s1" {
		t.Fatalf("spec.SessionRef = %q, want s1 (this machine's own session)", spec.SessionRef)
	}
	// The live prompt, not a rebuilt pack: the engine appends its reply-language
	// directive after either one, so the discriminator is the pack's own opening.
	if !strings.HasPrefix(spec.Prompt, "second") {
		t.Fatalf("a resumable ref must keep the live prompt, got %q", spec.Prompt)
	}
	if strings.Contains(spec.Prompt, "Continue this Kin task.") {
		t.Fatalf("a resumable ref was rebuilt into a pack: %q", spec.Prompt)
	}
}
