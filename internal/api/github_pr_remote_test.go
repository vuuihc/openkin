package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/github"
	"github.com/vuuihc/openkin/internal/node"
	"github.com/vuuihc/openkin/internal/store"
)

// The pull-request panel for a session that runs on another machine.
//
// The read is made where the checkout is: a Hub asking GitHub itself would ask
// with its own credentials, and for a repository it cannot see the answer is "no
// pull request" — a card erased by a question nobody should have asked. So the
// route has to end at the machine, and these cases are about the two ends of
// that: what the phone gets back, and what the Hub wrote down here.
//
// The machine's read is a seam (Responder.Observe) rather than a network call,
// because the interesting part is not what GitHub says. It is which machine was
// asked, what the Hub did with the answer, and what it kept when there was none.

// machineRead is the read one machine makes, replaceable between requests so that
// a test can take the machine's credentials away without taking the machine away.
type machineRead struct {
	mu    sync.Mutex
	res   github.LookupResult
	err   error
	asked []string
}

// install makes a machine that answers with whatever the test has set.
func (m *machineRead) install(t *testing.T) func(*node.Responder) {
	t.Helper()
	return func(r *node.Responder) {
		r.Observe = func(_ context.Context, repo github.Repo, branch string) (github.LookupResult, error) {
			m.mu.Lock()
			defer m.mu.Unlock()
			m.asked = append(m.asked, repo.Canonical()+" "+branch)
			return m.res, m.err
		}
	}
}

func (m *machineRead) answer(res github.LookupResult) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.res, m.err = res, nil
}

func (m *machineRead) fail(err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.res, m.err = github.LookupResult{}, err
}

func (m *machineRead) questions() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]string(nil), m.asked...)
}

// openPullRequest is one read pull request, as the machine's own credentials
// would report it. The number is deliberately not one a real repository would
// hand back for this branch: a card that came from anywhere but the machine is
// then impossible to mistake for the answer.
func openPullRequest(number int, title string) github.LookupResult {
	n := number
	return github.LookupResult{
		Source: github.SourceGH,
		PR: &github.PullRequest{
			Number:     &n,
			URL:        "https://github.com/owner/app/pull/42",
			Title:      title,
			State:      "open",
			BaseBranch: "main",
			HeadOID:    "abc123",
			CI:         github.CIStatus{State: "success", Total: 2, Passed: 2},
		},
	}
}

// prCheckout is a checkout of github.com/owner/app under a root the machine works
// in.
func prCheckout(t *testing.T, root string) string {
	t.Helper()
	work := filepath.Join(root, "app")
	if err := os.MkdirAll(work, 0o755); err != nil {
		t.Fatal(err)
	}
	initRepo(t, work)
	gitRun(t, work, "remote", "add", "origin", "https://github.com/owner/app.git")
	return work
}

// recordedOn writes where a session's work was recorded to be, the way the create
// path does when the machine answers (see
// TestCreatingARemoteSessionRecordsWhereItsWorkIs).
func recordedOn(t *testing.T, s *Server, taskID, repo, branch string) {
	t.Helper()
	if err := s.Store.UpdateTask(context.Background(), taskID, store.TaskPatch{
		WorkspaceRepo: &repo, WorkspaceBranch: &branch,
	}); err != nil {
		t.Fatal(err)
	}
}

// prSnapshot decodes a pull-request route's answer.
func prSnapshot(t *testing.T, rec *httptest.ResponseRecorder) github.Snapshot {
	t.Helper()
	var snap github.Snapshot
	if err := json.Unmarshal(rec.Body.Bytes(), &snap); err != nil {
		t.Fatal(err)
	}
	return snap
}

// The route a phone's refresh button calls, for a session whose checkout is on
// another machine: the answer has to be the machine's, keyed on the branch the
// machine is on now rather than the one the row remembered.
func TestRefreshingARemoteTasksPullRequestAsksItsMachine(t *testing.T) {
	root := t.TempDir()
	work := prCheckout(t, root)

	read := &machineRead{}
	read.answer(openPullRequest(4242, "the machine's own view"))
	s, h, master, deviceID := hubWithMachine(t, read.install(t), root)
	s.GitHub = github.NewService(s.Store)
	s.BindGitHubMachines()

	task := remoteTask(t, s, deviceID, work, "")
	// What the row says is what the panel draws before anyone asks, and a session
	// that has switched branches since it started is exactly the case the machine
	// is asked about — so the row is deliberately wrong here.
	recordedOn(t, s, task.ID, "github.com/owner/app", "stale/from-when-it-started")

	client := &authClient{t: t, h: h, master: master}
	rec := client.post("/api/tasks/"+task.ID+"/pr/refresh", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("refresh: %d %s", rec.Code, rec.Body.String())
	}
	snap := prSnapshot(t, rec)
	if len(snap.Observations) != 1 {
		t.Fatalf("observations = %+v, want the one the machine's answer produced", snap.Observations)
	}
	obs := snap.Observations[0]
	if obs.Number == nil || *obs.Number != 4242 {
		t.Fatalf("number = %v, want the machine's own answer (all: %+v)", obs.Number, obs)
	}
	if obs.Title != "the machine's own view" || obs.Source != github.SourceGH {
		t.Errorf("row = %q %q, want what the machine said", obs.Title, obs.Source)
	}
	if obs.CISummary == "" {
		t.Error("the checks the machine read did not survive the trip")
	}
	// The header is about the branch the card beside it is about.
	if snap.Repo != "github.com/owner/app" || snap.Branch != "main" {
		t.Errorf("panel says %q %q, want the branch the checkout is on", snap.Repo, snap.Branch)
	}

	// Asked about the checkout's branch, not the row's: the machine reads its own
	// git, which is the whole reason the question goes to it.
	if got := read.questions(); len(got) != 1 || got[0] != "github.com/owner/app main" {
		t.Errorf("the machine was asked %v, want one read of github.com/owner/app main", got)
	}

	// The row follows the answer, so the next screen draws the right header
	// before anyone asks anything.
	row, err := s.Store.GetTask(context.Background(), task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if row.WorkspaceBranch != "main" {
		t.Errorf("the task row still says branch %q", row.WorkspaceBranch)
	}

	// And the read the console makes on every open is still a cache read: the
	// pull request is on screen without a second question to the machine.
	rec = client.get("/api/tasks/" + task.ID + "/pr")
	if rec.Code != http.StatusOK {
		t.Fatalf("read: %d %s", rec.Code, rec.Body.String())
	}
	again := prSnapshot(t, rec)
	if len(again.Observations) != 1 || again.Observations[0].Number == nil || *again.Observations[0].Number != 4242 {
		t.Errorf("the panel read = %+v, want the row the refresh wrote", again.Observations)
	}
	if got := read.questions(); len(got) != 1 {
		t.Errorf("opening the panel asked the machine %v, want no question at all", got)
	}
}

// The machine is away. What the person needs is the card that was true and the
// sentence saying why it could not be refreshed — not an empty panel, and not a
// 502 that the console would show as "github unavailable".
func TestRefreshingARemoteTasksPullRequestWhenTheMachineIsAwayKeepsTheLastCard(t *testing.T) {
	s, master, _ := machinesServer(t)
	_, deviceID := pairDevice(t, s.Handler(), master)
	s.GitHub = github.NewService(s.Store)
	s.BindGitHubMachines()

	// A checkout this Hub happens to have at the same address: if the route fell
	// back to reading it here, the answer would be plausible and wrong.
	work := prCheckout(t, t.TempDir())

	task := remoteTask(t, s, deviceID, work, "")
	recordedOn(t, s, task.ID, "github.com/owner/app", "main")
	now := time.Now().UnixMilli()
	if err := s.Store.RecordPRObservation(context.Background(), store.PRObservation{
		Repo: "github.com/owner/app", HeadBranch: "main", TaskID: task.ID,
		Number: numberIn(42), State: "open", Title: "Add the thing", Source: github.SourceGH,
		ObservedAt: &now, AttemptedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	client := &authClient{t: t, h: s.Handler(), master: master}
	rec := client.post("/api/tasks/"+task.ID+"/pr/refresh", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("refresh with the machine away: %d %s", rec.Code, rec.Body.String())
	}
	snap := prSnapshot(t, rec)
	if len(snap.Observations) != 1 {
		t.Fatalf("observations = %+v, want the last one still there", snap.Observations)
	}
	obs := snap.Observations[0]
	if obs.Number == nil || *obs.Number != 42 || obs.Title != "Add the thing" {
		t.Errorf("the last card was lost: %+v", obs)
	}
	if !strings.Contains(obs.LastError, "not connected") {
		t.Errorf("last error = %q, want the machine named as away", obs.LastError)
	}
}

// A machine that could not make the read — no credentials, no network, a rate
// limit — is not an observation of "no pull request": the number someone is
// looking for would go out with it.
func TestARemoteRefreshThatCouldNotLookKeepsTheNumber(t *testing.T) {
	root := t.TempDir()
	work := prCheckout(t, root)

	read := &machineRead{}
	read.answer(openPullRequest(42, "Add the thing"))
	s, h, master, deviceID := hubWithMachine(t, read.install(t), root)
	s.GitHub = github.NewService(s.Store)
	s.BindGitHubMachines()

	task := remoteTask(t, s, deviceID, work, "")
	recordedOn(t, s, task.ID, "github.com/owner/app", "main")

	client := &authClient{t: t, h: h, master: master}
	if rec := client.post("/api/tasks/"+task.ID+"/pr/refresh", ""); rec.Code != http.StatusOK {
		t.Fatalf("first refresh: %d %s", rec.Code, rec.Body.String())
	}

	// The same machine, still holding the checkout, no longer able to read.
	read.fail(errors.New("gh: not logged in; anonymous: rate limited"))

	rec := client.post("/api/tasks/"+task.ID+"/pr/refresh", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("refresh that could not look: %d %s", rec.Code, rec.Body.String())
	}
	snap := prSnapshot(t, rec)
	if len(snap.Observations) != 1 || snap.Observations[0].Number == nil || *snap.Observations[0].Number != 42 {
		t.Fatalf("the number was erased by a read that never happened: %+v", snap.Observations)
	}
	if !strings.Contains(snap.Observations[0].LastError, "rate limited") {
		t.Errorf("last error = %q, want the machine's own reason", snap.Observations[0].LastError)
	}
	if got := read.questions(); len(got) != 2 {
		t.Errorf("the machine was asked %v, want the second attempt to have reached it", got)
	}
}

func numberIn(n int) *int { return &n }
