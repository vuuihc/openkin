package github

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/remote/worker"
	"github.com/vuuihc/openkin/internal/store"
)

// Observing a session that runs on another machine.
//
// The Hub cannot do this itself: the read is made with the credentials of the
// machine that holds the checkout, and a Hub without them answers "no pull
// request" for a branch that has one. So the Hub asks, and these cases are about
// what it does with the answer — including the half-answers, because the two
// things a machine can say that look alike from far away are "this branch has no
// pull request" and "I could not look".

// fakeMachines is one paired machine with no channel behind it.
type fakeMachines struct {
	// runsElsewhere is what RunsElsewhere says about any task.
	runsElsewhere bool
	// dir is where the checkout is said to be on that machine.
	dir string
	// dirErr fails the directory lookup, which is a machine that cannot be asked.
	dirErr error
	// answer is what the machine says about a checkout.
	answer worker.PRObserveResult
	// answerErr is the question failing outright: no machine, no channel, a
	// timeout.
	answerErr error
	// asked records the questions that reached the machine.
	asked []worker.PRObserveParams
	// device records which machine was asked.
	devices []string
}

func (m *fakeMachines) RunsElsewhere(store.Task) bool { return m.runsElsewhere }

func (m *fakeMachines) RemoteWorkspaceCwd(_ context.Context, _ store.Task) (string, bool, error) {
	if m.dirErr != nil {
		return "", true, m.dirErr
	}
	return m.dir, true, nil
}

func (m *fakeMachines) Ask(_ context.Context, device, method string, params, out any) error {
	m.devices = append(m.devices, device)
	if method != worker.QueryPRObserve {
		return errors.New("this machine does not know the question " + method)
	}
	asked, _ := params.(worker.PRObserveParams)
	m.asked = append(m.asked, asked)
	if m.answerErr != nil {
		return m.answerErr
	}
	raw, err := json.Marshal(m.answer)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, out)
}

// remoteTask seeds a task whose work is on node-1, with the pair the Hub
// recorded when the session started.
func remoteTask(t *testing.T, st *store.Store, repo, branch string) store.Task {
	t.Helper()
	task := store.Task{
		ID: "remote-task", Title: "over there", Agent: "claude-code", Cwd: "/Users/x/work/app",
		Prompt: "p", Status: "running", CreatedAt: store.NowMilli(),
		ExecutingDeviceID: "node-1",
		WorkspaceRepo:     repo, WorkspaceBranch: branch,
	}
	if err := st.InsertTask(context.Background(), task); err != nil {
		t.Fatal(err)
	}
	return task
}

func TestTargetForTaskNamesTheMachineHoldingTheCheckout(t *testing.T) {
	svc, st := newTestService(t, &fakeRunner{name: SourceAnonymous})
	ctx := context.Background()
	remoteTask(t, st, "github.com/owner/app", "feature/scratch")
	machines := &fakeMachines{runsElsewhere: true, dir: "/Users/x/work/app"}
	svc.SetMachines(machines)

	target, ok, err := svc.TargetForTask(ctx, "remote-task")
	if err != nil || !ok {
		t.Fatalf("TargetForTask = %+v, %v, %v", target, ok, err)
	}
	if target.Device != "node-1" || target.Dir != "/Users/x/work/app" {
		t.Errorf("target = %+v, want it to name node-1 and its directory", target)
	}
}

// The whole point: the read is made by the machine, and what it says is what the
// Hub writes down.
func TestObservingARemoteSessionAsksItsMachine(t *testing.T) {
	svc, st := newTestService(t, &fakeRunner{name: SourceAnonymous})
	ctx := context.Background()
	remoteTask(t, st, "github.com/owner/app", "feature/scratch")
	machines := &fakeMachines{
		runsElsewhere: true,
		dir:           "/Users/x/work/app",
		answer: worker.PRObserveResult{
			Path: "/Users/x/work/app", Repo: "github.com/owner/app", Branch: "feature/scratch",
			Observed: true, Source: "gh", Number: 42, URL: "https://github.com/owner/app/pull/42",
			Title: "Add the thing", State: "open", BaseBranch: "main", HeadOID: "abc123",
			CIState: "success", CISummary: `{"state":"success","total":2,"passed":2}`,
		},
	}
	svc.SetMachines(machines)

	target, _, err := svc.TargetForTask(ctx, "remote-task")
	if err != nil {
		t.Fatal(err)
	}
	obs, err := svc.Observe(ctx, target)
	if err != nil {
		t.Fatalf("Observe: %v", err)
	}
	if len(machines.asked) != 1 || machines.asked[0].Path != "/Users/x/work/app" {
		t.Fatalf("the machine was asked %+v, want one question about its checkout", machines.asked)
	}
	if machines.devices[0] != "node-1" {
		t.Errorf("asked %q, want node-1", machines.devices[0])
	}
	if obs.Number == nil || *obs.Number != 42 || obs.Source != "gh" {
		t.Fatalf("observation = %+v, want the machine's answer", obs)
	}
	if obs.CISummary == "" || !strings.Contains(obs.CISummary, `"passed":2`) {
		t.Errorf("ci summary = %q, want the counts the machine read", obs.CISummary)
	}
	// This daemon's own readers were never used: the answer came from the machine.
	if len(svc.anon.(*fakeRunner).calls) != 0 {
		t.Error("the Hub read the pull request itself instead of asking")
	}
}

// A session that has moved to another branch since it started is answered about
// the branch it is on now, and the row follows — otherwise the panel's header
// describes a branch the card beside it is not about.
func TestARemoteAnswerAboutAnotherBranchCorrectsTheTaskRow(t *testing.T) {
	svc, st := newTestService(t, &fakeRunner{name: SourceAnonymous})
	ctx := context.Background()
	remoteTask(t, st, "github.com/owner/app", "main")
	svc.SetMachines(&fakeMachines{
		runsElsewhere: true,
		dir:           "/Users/x/work/app",
		answer: worker.PRObserveResult{
			Path: "/Users/x/work/app", Repo: "github.com/owner/app", Branch: "kin/task/7/g1",
			Observed: true, Source: "gh", Number: 7, State: "open",
		},
	})

	target, _, err := svc.TargetForTask(ctx, "remote-task")
	if err != nil {
		t.Fatal(err)
	}
	obs, err := svc.Observe(ctx, target)
	if err != nil {
		t.Fatalf("Observe: %v", err)
	}
	if obs.HeadBranch != "kin/task/7/g1" {
		t.Fatalf("observation is about %q, want the branch the machine is on", obs.HeadBranch)
	}
	row, err := st.GetTask(ctx, "remote-task")
	if err != nil {
		t.Fatal(err)
	}
	if row.WorkspaceBranch != "kin/task/7/g1" {
		t.Errorf("the task row still says %q", row.WorkspaceBranch)
	}
}

// A machine that cannot be reached is not an absence of pull requests. The card
// that was true stays, and the reason joins it — the same rule the local path
// follows, which is why a phone that loses the machine does not lose the panel.
func TestAnUnreachableMachineKeepsTheLastAnswerAndSaysWhy(t *testing.T) {
	svc, st := newTestService(t, &fakeRunner{name: SourceAnonymous})
	ctx := context.Background()
	remoteTask(t, st, "github.com/owner/app", "feature/scratch")
	machines := &fakeMachines{
		runsElsewhere: true,
		dir:           "/Users/x/work/app",
		answer: worker.PRObserveResult{
			Path: "/Users/x/work/app", Repo: "github.com/owner/app", Branch: "feature/scratch",
			Observed: true, Source: "gh", Number: 42, State: "open", Title: "Add the thing",
		},
	}
	svc.SetMachines(machines)

	target, _, err := svc.TargetForTask(ctx, "remote-task")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Observe(ctx, target); err != nil {
		t.Fatalf("first observe: %v", err)
	}

	// The machine goes away.
	machines.answerErr = errors.New("node-1 is not connected")
	cached, err := svc.Observe(ctx, target)
	if err == nil {
		t.Fatal("a machine that is away was reported as an answer")
	}
	if !strings.Contains(err.Error(), "not connected") {
		t.Errorf("error = %v, want the machine's absence", err)
	}
	if cached.Number == nil || *cached.Number != 42 {
		t.Fatalf("the last known pull request was lost: %+v", cached)
	}
	if !strings.Contains(cached.LastError, "not connected") {
		t.Errorf("the row does not say why: %q", cached.LastError)
	}
}

// The two answers that must not be confused: a machine that could not look says
// so, and that is a failure — not a newer successful observation of "no pull
// request", which would erase the number someone is looking for.
func TestAMachineThatCouldNotLookIsNotAnAbsence(t *testing.T) {
	svc, st := newTestService(t, &fakeRunner{name: SourceAnonymous})
	ctx := context.Background()
	remoteTask(t, st, "github.com/owner/app", "feature/scratch")
	machines := &fakeMachines{
		runsElsewhere: true,
		dir:           "/Users/x/work/app",
		answer: worker.PRObserveResult{
			Path: "/Users/x/work/app", Repo: "github.com/owner/app", Branch: "feature/scratch",
			Observed: true, Source: "gh", Number: 42, State: "open",
		},
	}
	svc.SetMachines(machines)
	target, _, err := svc.TargetForTask(ctx, "remote-task")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Observe(ctx, target); err != nil {
		t.Fatalf("first observe: %v", err)
	}

	machines.answer = worker.PRObserveResult{
		Path: "/Users/x/work/app", Repo: "github.com/owner/app", Branch: "feature/scratch",
		Reason: "no GitHub CLI on this machine, and the public API refused the read",
	}
	cached, err := svc.Observe(ctx, target)
	if err == nil {
		t.Fatal("an unobserved answer was taken for an observation")
	}
	if cached.Number == nil || *cached.Number != 42 {
		t.Fatalf("the number was erased by a read that never happened: %+v", cached)
	}
	if !strings.Contains(cached.LastError, "no GitHub CLI") {
		t.Errorf("the row does not carry the machine's reason: %q", cached.LastError)
	}
}

// The answer is a wire value, and a row keyed on it unchecked would file another
// repository's pull request under this task.
func TestAnAnswerAboutAnotherRepositoryIsNotWritten(t *testing.T) {
	svc, st := newTestService(t, &fakeRunner{name: SourceAnonymous})
	ctx := context.Background()
	remoteTask(t, st, "github.com/owner/app", "feature/scratch")
	svc.SetMachines(&fakeMachines{
		runsElsewhere: true,
		dir:           "/Users/x/work/app",
		answer: worker.PRObserveResult{
			Path: "/Users/x/work/app", Repo: "not-a-repository", Branch: "feature/scratch",
			Observed: true, Source: "gh", Number: 9,
		},
	})

	target, _, err := svc.TargetForTask(ctx, "remote-task")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Observe(ctx, target); err == nil {
		t.Fatal("an answer about no repository was written down")
	}
	if _, ok, err := st.GetPRObservation(ctx, "not-a-repository", "feature/scratch"); err != nil || ok {
		t.Errorf("a row was written for the machine's unusable answer (ok=%v, err=%v)", ok, err)
	}
}

// The background pass is what keeps a card fresh while nobody is looking, and a
// card about another machine's checkout is no different.
func TestTheBackgroundPassRefreshesARemoteRowThroughItsMachine(t *testing.T) {
	svc, st := newTestService(t, &fakeRunner{name: SourceAnonymous})
	ctx := context.Background()
	remoteTask(t, st, "github.com/owner/app", "feature/scratch")
	machines := &fakeMachines{
		runsElsewhere: true,
		dir:           "/Users/x/work/app",
		answer: worker.PRObserveResult{
			Path: "/Users/x/work/app", Repo: "github.com/owner/app", Branch: "feature/scratch",
			Observed: true, Source: "gh", Number: 42, State: "open",
		},
	}
	svc.SetMachines(machines)

	// A row that was answered long enough ago to be due.
	old := time.Now().Add(-24 * time.Hour).UnixMilli()
	if err := st.RecordPRObservation(ctx, store.PRObservation{
		Repo: "github.com/owner/app", HeadBranch: "feature/scratch", TaskID: "remote-task",
		Number: number(42), State: "open", Source: SourceGH,
		ObservedAt: &old, AttemptedAt: old,
	}); err != nil {
		t.Fatal(err)
	}

	refreshed, err := svc.Reconcile(ctx, 10)
	if err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	if refreshed != 1 {
		t.Fatalf("refreshed %d rows, want 1", refreshed)
	}
	if len(machines.asked) != 1 {
		t.Fatalf("the machine was asked %d times, want 1", len(machines.asked))
	}
	// The Hub's own readers stay out of it: this row is not this daemon's to read.
	if len(svc.anon.(*fakeRunner).calls) != 0 {
		t.Error("the background pass read the row here instead of asking the machine")
	}
}

// A task with no recorded pair is still observable on the machine that holds it:
// the row is what the panel draws early, not a precondition for asking.
func TestARemoteTaskWithNothingRecordedCanStillBeObserved(t *testing.T) {
	svc, st := newTestService(t, &fakeRunner{name: SourceAnonymous})
	ctx := context.Background()
	remoteTask(t, st, "", "")
	svc.SetMachines(&fakeMachines{
		runsElsewhere: true,
		dir:           "/Users/x/work/app",
		answer: worker.PRObserveResult{
			Path: "/Users/x/work/app", Repo: "github.com/owner/app", Branch: "main",
			Observed: true, Source: "anonymous", Number: 3, State: "open",
		},
	})

	target, ok, err := svc.TargetForTask(ctx, "remote-task")
	if err != nil || !ok {
		t.Fatalf("TargetForTask = %+v, %v, %v", target, ok, err)
	}
	// Before anyone asks: nothing was recorded, so the header claims nothing and
	// says where the checkout is instead.
	before, err := svc.SnapshotForTask(ctx, "remote-task", false)
	if err != nil {
		t.Fatalf("SnapshotForTask: %v", err)
	}
	if before.Repo != "" || before.Branch != "" {
		t.Errorf("the unasked panel claims %q %q", before.Repo, before.Branch)
	}

	snap, err := svc.SnapshotForTask(ctx, "remote-task", true)
	if err != nil {
		t.Fatalf("SnapshotForTask: %v", err)
	}
	if len(snap.Observations) != 1 || snap.Observations[0].Number == nil {
		t.Fatalf("observations = %+v, want the machine's answer", snap.Observations)
	}
	// Asked: the header now names what the machine said, on the same screen as
	// the card that came with it.
	if snap.Repo != "github.com/owner/app" || snap.Branch != "main" {
		t.Errorf("the refreshed panel claims %q %q, want the machine's answer", snap.Repo, snap.Branch)
	}
	row, err := st.GetTask(ctx, "remote-task")
	if err != nil {
		t.Fatal(err)
	}
	if row.WorkspaceRepo != "github.com/owner/app" || row.WorkspaceBranch != "main" {
		t.Errorf("the row was not corrected from the machine's answer: %+v", row)
	}
}

// The floor is what keeps a phone from re-asking a machine it just asked.
func TestReconcileLeavesARecentlyAnsweredRemoteRowAlone(t *testing.T) {
	svc, st := newTestService(t, &fakeRunner{name: SourceAnonymous})
	ctx := context.Background()
	remoteTask(t, st, "github.com/owner/app", "feature/scratch")
	machines := &fakeMachines{runsElsewhere: true, dir: "/Users/x/work/app"}
	svc.SetMachines(machines)

	now := time.Now().UnixMilli()
	if err := st.RecordPRObservation(ctx, store.PRObservation{
		Repo: "github.com/owner/app", HeadBranch: "feature/scratch", TaskID: "remote-task",
		Number: number(42), State: "open", Source: SourceGH,
		ObservedAt: &now, AttemptedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	refreshed, err := svc.Reconcile(ctx, 10)
	if err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	if refreshed != 0 || len(machines.asked) != 0 {
		t.Fatalf("refreshed %d, asked %d, want neither", refreshed, len(machines.asked))
	}
}

// An answer that says "I did not look" without saying why still has to read as a
// sentence: the reason is what the panel prints under the card, and an empty one
// leaves a red line with nothing after it.
func TestAMachineThatSaysNothingAboutWhyStillReadsAsASentence(t *testing.T) {
	svc, st := newTestService(t, &fakeRunner{name: SourceAnonymous})
	ctx := context.Background()
	remoteTask(t, st, "github.com/owner/app", "feature/scratch")
	svc.SetMachines(&fakeMachines{
		runsElsewhere: true,
		dir:           "/Users/x/work/app",
		answer: worker.PRObserveResult{
			Path: "/Users/x/work/app", Repo: "github.com/owner/app", Branch: "feature/scratch",
		},
	})

	target, _, err := svc.TargetForTask(ctx, "remote-task")
	if err != nil {
		t.Fatal(err)
	}
	cached, err := svc.Observe(ctx, target)
	if err == nil {
		t.Fatal("an answer with no observation was taken for one")
	}
	if strings.TrimSpace(cached.LastError) == "" {
		t.Fatalf("the row carries an empty reason: %+v", cached)
	}
	if !strings.Contains(cached.LastError, "node-1") {
		t.Errorf("last error = %q, want it to name the machine", cached.LastError)
	}
}

// The pass converges on a checkout that has moved on.
//
// A remote row is asked about a directory, not a branch, so the row it was asked
// about is not the row the answer goes to. Without the watch set's rule the old
// row is due forever — its clocks never move again — and every tick spends one
// remote read on a branch nothing can be told about, holding a slot in a batch
// that is what keeps every live pull request fresh.
func TestThePassStopsAskingAboutABranchTheCheckoutHasLeft(t *testing.T) {
	svc, st := newTestService(t, &fakeRunner{name: SourceAnonymous})
	ctx := context.Background()
	remoteTask(t, st, "github.com/owner/app", "feature/old")
	machines := &fakeMachines{
		runsElsewhere: true,
		dir:           "/Users/x/work/app",
		answer: worker.PRObserveResult{
			Path: "/Users/x/work/app", Repo: "github.com/owner/app", Branch: "feature/new",
			Observed: true, Source: "gh", Number: 7, State: "open",
		},
	}
	svc.SetMachines(machines)

	old := time.Now().Add(-24 * time.Hour).UnixMilli()
	if err := st.RecordPRObservation(ctx, store.PRObservation{
		Repo: "github.com/owner/app", HeadBranch: "feature/old", TaskID: "remote-task",
		Number: number(42), State: "open", Source: SourceGH,
		ObservedAt: &old, AttemptedAt: old,
	}); err != nil {
		t.Fatal(err)
	}

	for pass := 1; pass <= 3; pass++ {
		if _, err := svc.Reconcile(ctx, 25); err != nil {
			t.Fatalf("pass %d: %v", pass, err)
		}
	}
	if len(machines.asked) != 1 {
		t.Fatalf("the machine was asked %d times over three passes, want once", len(machines.asked))
	}
	row, err := st.GetTask(ctx, "remote-task")
	if err != nil {
		t.Fatal(err)
	}
	if row.WorkspaceBranch != "feature/new" {
		t.Errorf("the task row says %q, want the branch the checkout moved to", row.WorkspaceBranch)
	}
}

// A workspace the machine cannot place is refused, not guessed at.
//
// The task's original path is not a fallback here. A task whose anchor that
// machine cannot resolve is a task whose turns are refused outright, so reading
// the path it was created with would report on a directory no turn can run in —
// and where some other checkout happens to sit at the same path, the card would
// be about that one, then written onto the task by noteWhereTheWorkMoved. The
// person is owed the reason instead, and it is the sentence the refused turn
// itself gets.
func TestAWorkspaceTheMachineCannotPlaceIsNotReadAnyway(t *testing.T) {
	svc, st := newTestService(t, &fakeRunner{name: SourceAnonymous})
	ctx := context.Background()
	remoteTask(t, st, "github.com/owner/app", "feature/scratch")
	const refusal = "cannot resolve workspace anchor: git remote github.com/owner/app"
	machines := &fakeMachines{
		runsElsewhere: true,
		dirErr:        errors.New(refusal),
		answer: worker.PRObserveResult{
			Path: "/Users/x/work/app", Repo: "github.com/owner/app", Branch: "feature/scratch",
			Observed: true, Source: "gh", Number: 42,
		},
	}
	svc.SetMachines(machines)

	target, ok, err := svc.TargetForTask(ctx, "remote-task")
	if err != nil || !ok {
		t.Fatalf("TargetForTask = %+v, %v, %v", target, ok, err)
	}
	if target.Dir != "" {
		t.Errorf("directory = %q, want none: this machine cannot place the workspace", target.Dir)
	}
	if !strings.Contains(target.DirReason, refusal) {
		t.Errorf("reason = %q, want the resolution failure", target.DirReason)
	}

	if _, err := svc.Observe(ctx, target); err == nil {
		t.Fatal("the read succeeded, so the machine was asked about a workspace it cannot place")
	} else if !strings.Contains(err.Error(), refusal) {
		t.Fatalf("err = %v, want the resolution failure", err)
	}
	if len(machines.asked) != 0 {
		t.Fatalf("questions that reached the machine: %+v", machines.asked)
	}
	row, ok, err := st.GetPRObservation(ctx, "github.com/owner/app", "feature/scratch")
	if err != nil || !ok {
		t.Fatalf("row = %+v ok=%v err=%v", row, ok, err)
	}
	if !strings.Contains(row.LastError, refusal) {
		t.Fatalf("last_error = %q, want the reason on the row the panel reads", row.LastError)
	}
}

// The store is the Hub's, and it is where the answer has to end up: the phone
// and the desktop read the same rows.
func TestARemoteObservationIsVisibleToTheNextSnapshotRead(t *testing.T) {
	svc, st := newTestService(t, &fakeRunner{name: SourceAnonymous})
	ctx := context.Background()
	remoteTask(t, st, "github.com/owner/app", "feature/scratch")
	svc.SetMachines(&fakeMachines{
		runsElsewhere: true,
		dir:           "/Users/x/work/app",
		answer: worker.PRObserveResult{
			Path: "/Users/x/work/app", Repo: "github.com/owner/app", Branch: "feature/scratch",
			Observed: true, Source: "gh", Number: 42, State: "open", Title: "Add the thing",
		},
	})

	if _, err := svc.SnapshotForTask(ctx, "remote-task", true); err != nil {
		t.Fatalf("refresh: %v", err)
	}
	// The read the console makes on every open: no query, just the rows.
	snap, err := svc.SnapshotForTask(ctx, "remote-task", false)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(snap.Observations) != 1 {
		t.Fatalf("observations = %+v, want the one just written", snap.Observations)
	}
	if snap.Repo != "github.com/owner/app" || snap.Branch != "feature/scratch" {
		t.Errorf("snapshot = %q %q", snap.Repo, snap.Branch)
	}
}
