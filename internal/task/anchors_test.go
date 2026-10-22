package task

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/adapter"
	"github.com/vuuihc/openkin/internal/store"
)

// specRecorder is a remote machine's adapter: it records what it was asked to
// run, which is how these tests see the path that crossed the wire.
type specRecorder struct {
	mu    sync.Mutex
	specs []adapter.TaskSpec
	gate  chan struct{}
}

func (a *specRecorder) Start(ctx context.Context, spec adapter.TaskSpec) (adapter.RunHandle, error) {
	a.mu.Lock()
	a.specs = append(a.specs, spec)
	a.mu.Unlock()
	if a.gate != nil {
		select {
		case <-a.gate:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	ch := make(chan adapter.Event, 16)
	h := &fakeHandle{ch: ch, cancelCh: make(chan struct{})}
	go func() {
		defer close(ch)
		for _, ev := range successEvents() {
			select {
			case <-h.cancelCh:
				return
			case ch <- ev:
			}
		}
	}()
	return h, nil
}

func (a *specRecorder) started() []adapter.TaskSpec {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]adapter.TaskSpec(nil), a.specs...)
}

func deviceRow(t *testing.T, st *store.Store, id string) {
	t.Helper()
	if err := st.RecordDeviceHello(context.Background(), id, store.Device{Label: id}, nil, 1000); err != nil {
		t.Fatal(err)
	}
}

// A task created while looking at one machine, run on another, must be handed
// the second machine's address for the same workspace. Handing it the first
// machine's path would look right and act on the wrong checkout.
func TestRemoteTurnIsDispatchedToTheExecutingMachinesPath(t *testing.T) {
	local := &fakeAdapter{events: successEvents()}
	e, st := testEngine(t, 4, local)
	ctx := context.Background()
	e.SetRemoteRunner("hub-machine", nil)

	const remote = "github.com/vuuihc/openkin"
	deviceRow(t, st, "laptop")
	deviceRow(t, st, "studio")
	for device, checkout := range map[string]string{
		"laptop": "/code/openkin",
		"studio": "/Users/studio/code/openkin",
	} {
		if err := st.RecordDeviceWorkspaceRoots(ctx, device, []store.ReportedRoot{
			{Path: checkout, RemoteURL: remote, RelativePath: store.AnchorRepoRoot},
		}, 1000); err != nil {
			t.Fatal(err)
		}
	}

	remoteAgent := &specRecorder{}
	e.SetRemoteRunner("hub-machine", func(store.Task, string) (adapter.Adapter, error) {
		return remoteAgent, nil
	})

	created, err := e.Create(ctx, CreateRequest{
		Agent: "claude-code", Cwd: "/code/openkin/internal/task", Prompt: "carry on",
		ExecutingDeviceID: "laptop",
	})
	if err != nil {
		t.Fatal(err)
	}
	waitStatus(t, e, created.ID, StatusSucceeded, 5*time.Second)
	if created.WorkspaceAnchorID == "" {
		t.Fatal("the task was created without a workspace anchor")
	}
	anchor, err := st.GetWorkspaceAnchor(ctx, created.WorkspaceAnchorID)
	if err != nil {
		t.Fatal(err)
	}
	if anchor.Kind != store.AnchorGitRemote || anchor.RemoteURL != remote ||
		anchor.RelativePath != "internal/task" {
		t.Fatalf("anchor = %+v", anchor)
	}

	// The laptop ran it at its own address, which is where the task was created.
	first := remoteAgent.started()
	if len(first) != 1 || first[0].Cwd != "/code/openkin/internal/task" {
		t.Fatalf("laptop dispatch = %+v", first)
	}

	// The same conversation continues on the studio machine.
	device := "studio"
	if err := st.UpdateTask(ctx, created.ID, store.TaskPatch{ExecutingDeviceID: &device}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.FollowUp(ctx, created.ID, "and now here"); err != nil {
		t.Fatal(err)
	}
	waitStatus(t, e, created.ID, StatusSucceeded, 5*time.Second)

	specs := remoteAgent.started()
	if len(specs) != 2 {
		t.Fatalf("the studio machine was never asked to run anything: %+v", specs)
	}
	if got := specs[1].Cwd; got != "/Users/studio/code/openkin/internal/task" {
		t.Fatalf("dispatched cwd = %q want the studio machine's own path", got)
	}
}

// The refusal is the feature. A device that cannot resolve the workspace does
// not get handed a path that merely looks like it, and the turn does not move to
// a machine that happens to have a directory with the same name.
func TestRemoteTurnFailsWhenTheDeviceCannotResolveTheWorkspace(t *testing.T) {
	local := &fakeAdapter{events: successEvents()}
	e, st := testEngine(t, 4, local)
	ctx := context.Background()
	e.SetRemoteRunner("hub-machine", nil)

	deviceRow(t, st, "laptop")
	deviceRow(t, st, "nas")
	if err := st.RecordDeviceWorkspaceRoots(ctx, "laptop", []store.ReportedRoot{
		{Path: "/code/openkin", RemoteURL: "github.com/vuuihc/openkin", RelativePath: store.AnchorRepoRoot},
	}, 1000); err != nil {
		t.Fatal(err)
	}

	remoteAgent := &specRecorder{}
	e.SetRemoteRunner("hub-machine", func(store.Task, string) (adapter.Adapter, error) {
		return remoteAgent, nil
	})
	created, err := e.Create(ctx, CreateRequest{
		Agent: "claude-code", Cwd: "/code/openkin", Prompt: "run it",
		ExecutingDeviceID: "laptop",
	})
	if err != nil {
		t.Fatal(err)
	}
	if created.WorkspaceAnchorID == "" {
		t.Fatal("the task was created without a workspace anchor")
	}
	waitStatus(t, e, created.ID, StatusSucceeded, 5*time.Second)
	ran := len(remoteAgent.started())

	device := "nas"
	if err := st.UpdateTask(ctx, created.ID, store.TaskPatch{ExecutingDeviceID: &device}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.FollowUp(ctx, created.ID, "hello"); err != nil {
		t.Fatal(err)
	}
	done := waitStatus(t, e, created.ID, StatusFailed, 5*time.Second)
	if got := len(remoteAgent.started()); got != ran {
		t.Fatal("a machine without the workspace was asked to run the turn anyway")
	}
	events, err := st.ListEvents(ctx, created.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	var said string
	for _, event := range events {
		if event.Type != "error" {
			continue
		}
		said += string(event.Payload)
	}
	for _, want := range []string{"cannot resolve", "github.com/vuuihc/openkin", "laptop"} {
		if !strings.Contains(said, want) {
			t.Fatalf("the failure does not say %q: %s", want, said)
		}
	}
	if done.Status != StatusFailed {
		t.Fatalf("status = %q", done.Status)
	}
}

// A task whose cwd is not a checkout, and a machine that never reported where
// its checkouts are, both keep the path they were created with: the anchor is
// an improvement, not a new precondition for running anything.
func TestTasksWithoutAnAnchorKeepTheirPath(t *testing.T) {
	local := &fakeAdapter{events: successEvents()}
	e, st := testEngine(t, 4, local)
	ctx := context.Background()
	e.SetRemoteRunner("hub-machine", nil)
	deviceRow(t, st, "studio")

	remoteAgent := &specRecorder{}
	e.SetRemoteRunner("hub-machine", func(store.Task, string) (adapter.Adapter, error) {
		return remoteAgent, nil
	})
	created, err := e.Create(ctx, CreateRequest{
		Agent: "claude-code", Cwd: "/srv/scratch", Prompt: "run it",
		ExecutingDeviceID: "studio",
	})
	if err != nil {
		t.Fatal(err)
	}
	if created.WorkspaceAnchorID != "" {
		t.Fatalf("a device that never reported roots produced an anchor: %s", created.WorkspaceAnchorID)
	}
	waitStatus(t, e, created.ID, StatusSucceeded, 5*time.Second)
	specs := remoteAgent.started()
	if len(specs) == 0 || specs[0].Cwd != "/srv/scratch" {
		t.Fatalf("dispatched specs = %+v", specs)
	}
}

// A local task in a checkout records where that checkout is on this machine, so
// the same task can later be continued elsewhere.
func TestCreateRecordsTheLocalCheckoutAsARoot(t *testing.T) {
	gitPath, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git not installed")
	}
	local := &fakeAdapter{events: successEvents()}
	e, st := testEngine(t, 4, local)
	ctx := context.Background()
	e.SetRemoteRunner("hub-machine", nil)
	if err := st.RegisterLocalDevice(ctx, store.Device{ID: "hub-machine", Label: "hub"}, 1000); err != nil {
		t.Fatal(err)
	}

	repo := t.TempDir()
	runGitTest(t, gitPath, repo, "init")
	runGitTest(t, gitPath, repo, "remote", "add", "origin", "https://github.com/vuuihc/openkin.git")
	sub := filepath.Join(repo, "internal", "task")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}

	created, err := e.Create(ctx, CreateRequest{
		Agent: "claude-code", Cwd: sub, Prompt: "work here",
	})
	if err != nil {
		t.Fatal(err)
	}
	if created.WorkspaceAnchorID == "" {
		t.Fatal("a checkout on this machine produced no anchor")
	}
	anchor, err := st.GetWorkspaceAnchor(ctx, created.WorkspaceAnchorID)
	if err != nil {
		t.Fatal(err)
	}
	if anchor.Kind != store.AnchorGitRemote || anchor.RemoteURL != "github.com/vuuihc/openkin" ||
		anchor.RelativePath != "internal/task" {
		t.Fatalf("anchor = %+v", anchor)
	}
	got, ok, err := st.ResolveAnchorPath(ctx, anchor, "hub-machine")
	if err != nil || !ok {
		t.Fatalf("resolve on the hub itself: ok=%v err=%v", ok, err)
	}
	if !sameTestPath(t, got, sub) {
		t.Fatalf("resolved = %q want %q", got, sub)
	}
	// And it is the identity another machine resolves against, not a path.
	devices, err := st.DevicesWithAnchor(ctx, anchor)
	if err != nil {
		t.Fatal(err)
	}
	// Named the way a user knows them: the label, because nobody can look up an
	// id in a refusal message.
	if len(devices) != 1 || devices[0] != "hub" {
		t.Fatalf("devices = %v", devices)
	}
}

// A directory that is not a checkout is still a workspace: it is recorded as
// one that resolves on this machine only, so another machine refuses it instead
// of running in a same-named directory.
func TestCreateRecordsANonRepositoryDirectoryAsADevicePath(t *testing.T) {
	local := &fakeAdapter{events: successEvents()}
	e, st := testEngine(t, 4, local)
	ctx := context.Background()
	e.SetRemoteRunner("hub-machine", nil)
	if err := st.RegisterLocalDevice(ctx, store.Device{ID: "hub-machine", Label: "hub"}, 1000); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()

	created, err := e.Create(ctx, CreateRequest{Agent: "claude-code", Cwd: dir, Prompt: "work here"})
	if err != nil {
		t.Fatal(err)
	}
	if created.WorkspaceAnchorID == "" {
		t.Fatal("a plain directory produced no anchor")
	}
	anchor, err := st.GetWorkspaceAnchor(ctx, created.WorkspaceAnchorID)
	if err != nil {
		t.Fatal(err)
	}
	if anchor.Kind != store.AnchorDevicePath {
		t.Fatalf("anchor = %+v", anchor)
	}
	deviceRow(t, st, "studio")
	if _, ok, err := st.ResolveAnchorPath(ctx, anchor, "studio"); err != nil || ok {
		t.Fatalf("another machine resolved a local directory: ok=%v err=%v", ok, err)
	}
}

func TestDispatchCwdReportsAnUnreadableAnchor(t *testing.T) {
	local := &fakeAdapter{events: successEvents()}
	e, _ := testEngine(t, 4, local)
	e.SetRemoteRunner("hub-machine", nil)
	_, err := e.dispatchCwd(context.Background(), store.Task{
		ExecutingDeviceID: "studio", WorkspaceAnchorID: "no-such-anchor",
	})
	if err == nil || errors.Is(err, errWorkspaceUnresolvable) {
		t.Fatalf("err = %v want a storage error, not a resolution refusal", err)
	}
}

func runGitTest(t *testing.T, gitPath, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command(gitPath, args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_CONFIG_SYSTEM=/dev/null",
		"GIT_TERMINAL_PROMPT=0",
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %s: %v: %s", strings.Join(args, " "), err, out)
	}
}

func sameTestPath(t *testing.T, a, b string) bool {
	t.Helper()
	ra, err := filepath.EvalSymlinks(a)
	if err != nil {
		ra = filepath.Clean(a)
	}
	rb, err := filepath.EvalSymlinks(b)
	if err != nil {
		rb = filepath.Clean(b)
	}
	return ra == rb
}

// A fork continues the same conversation in the same directory, so it carries
// the same workspace identity. Without one, the branch would run at whatever the
// path happens to mean on the machine that runs it — the copy problem the anchor
// exists to prevent, reintroduced by the branch.
func TestForkKeepsTheWorkspaceIdentity(t *testing.T) {
	local := &fakeAdapter{events: successEvents()}
	e, st := testEngine(t, 4, local)
	ctx := context.Background()
	e.SetRemoteRunner("hub-machine", nil)

	deviceRow(t, st, "laptop")
	if err := st.RecordDeviceWorkspaceRoots(ctx, "laptop", []store.ReportedRoot{
		{Path: "/code/openkin", RemoteURL: "github.com/vuuihc/openkin", RelativePath: store.AnchorRepoRoot},
	}, 1000); err != nil {
		t.Fatal(err)
	}
	remoteAgent := &specRecorder{}
	e.SetRemoteRunner("hub-machine", func(store.Task, string) (adapter.Adapter, error) {
		return remoteAgent, nil
	})

	src, err := e.Create(ctx, CreateRequest{
		Agent: "claude-code", Cwd: "/code/openkin/internal/task", Prompt: "start here",
		ExecutingDeviceID: "laptop",
	})
	if err != nil {
		t.Fatal(err)
	}
	waitStatus(t, e, src.ID, StatusSucceeded, 5*time.Second)
	if src.WorkspaceAnchorID == "" {
		t.Fatal("the source task got no anchor, so this test proves nothing")
	}

	forked, err := e.Fork(ctx, src.ID, ForkRequest{Prompt: "and now this"})
	if err != nil {
		t.Fatal(err)
	}
	if forked.ExecutingDeviceID != "laptop" {
		t.Fatalf("fork runs on %q, not the machine that owns the directory", forked.ExecutingDeviceID)
	}
	if forked.WorkspaceAnchorID != src.WorkspaceAnchorID {
		t.Fatalf("fork anchor = %q, source = %q", forked.WorkspaceAnchorID, src.WorkspaceAnchorID)
	}

	waitStatus(t, e, forked.ID, StatusSucceeded, 5*time.Second)
	specs := remoteAgent.started()
	if len(specs) != 2 {
		t.Fatalf("dispatches = %+v", specs)
	}
	if specs[1].Cwd != "/code/openkin/internal/task" {
		t.Fatalf("the fork ran at %q", specs[1].Cwd)
	}
}

// A remote turn with no portable identity runs at the path the task was created
// with, checked against the machine's own roots and nothing else. That is the
// weaker of the two checks, and a transcript that looked exactly like a resolved
// turn would hide it.
func TestRemoteTurnWithoutAWorkspaceIdentitySaysSo(t *testing.T) {
	local := &fakeAdapter{events: successEvents()}
	e, st := testEngine(t, 4, local)
	ctx := context.Background()
	e.SetRemoteRunner("hub-machine", nil)

	// The machine is known but has reported no roots at all: nothing to match a
	// path against, so no anchor can be derived.
	deviceRow(t, st, "laptop")
	remoteAgent := &specRecorder{}
	e.SetRemoteRunner("hub-machine", func(store.Task, string) (adapter.Adapter, error) {
		return remoteAgent, nil
	})

	created, err := e.Create(ctx, CreateRequest{
		Agent: "claude-code", Cwd: "/code/scratch", Prompt: "run it anyway",
		ExecutingDeviceID: "laptop",
	})
	if err != nil {
		t.Fatal(err)
	}
	waitStatus(t, e, created.ID, StatusSucceeded, 5*time.Second)
	if created.WorkspaceAnchorID != "" {
		t.Fatalf("this task was supposed to have no anchor: %q", created.WorkspaceAnchorID)
	}

	specs := remoteAgent.started()
	if len(specs) != 1 || specs[0].Cwd != "/code/scratch" {
		t.Fatalf("dispatch = %+v", specs)
	}
	events, err := st.ListEvents(ctx, created.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	noted := false
	for _, ev := range events {
		if ev.Type == "meta" && strings.Contains(string(ev.Payload), "no workspace identity") &&
			strings.Contains(string(ev.Payload), "laptop") && strings.Contains(string(ev.Payload), "/code/scratch") {
			noted = true
		}
	}
	if !noted {
		t.Fatalf("nothing in the transcript says the workspace was not resolved: %+v", events)
	}
}

// A Hub restart is the one ending no device can send: the turn table is in the
// process that just died, so nobody will ever report how those turns ended. The
// task must not stay running, and the events that did arrive must stay — they
// are what the user already saw.
func TestAHubRestartFailsARemoteTurnAndKeepsItsEvents(t *testing.T) {
	local := &fakeAdapter{events: successEvents()}
	_, st := testEngine(t, 4, local)
	ctx := context.Background()
	deviceRow(t, st, "laptop")

	now := store.NowMilli()
	rec := store.Task{
		ID: "01REMOTERUNNINGTASK0000001", Title: "carry on", Agent: "claude-code",
		Cwd: "/code/openkin", Prompt: "keep going", Status: StatusRunning,
		ExecutingDeviceID: "laptop", CreatedAt: now,
	}
	if err := st.InsertTask(ctx, rec); err != nil {
		t.Fatal(err)
	}
	if _, err := st.AppendEvent(ctx, rec.ID, "message", []byte(`{"role":"assistant","content":"half done"}`)); err != nil {
		t.Fatal(err)
	}

	// The next process starts, sees the turn nobody is running, and settles it.
	e := NewEngineFromAdapters(st, map[string]adapter.Adapter{"claude-code": local}, NewBus(), 4)
	defer e.Close()
	if err := e.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	settled, err := e.Get(ctx, rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if settled.Status != StatusFailed {
		t.Fatalf("status = %s", settled.Status)
	}
	events, err := st.ListEvents(ctx, rec.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 {
		t.Fatalf("events = %+v", events)
	}
	if events[0].Type != "message" || !strings.Contains(string(events[0].Payload), "half done") {
		t.Fatalf("the events the hub had already received were not kept: %+v", events[0])
	}
	if events[1].Type != "error" || !strings.Contains(string(events[1].Payload), "daemon restarted") {
		t.Fatalf("the restart was not recorded: %+v", events[1])
	}
}
