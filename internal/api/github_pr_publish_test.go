package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/github"
	"github.com/vuuihc/openkin/internal/node"
	"github.com/vuuihc/openkin/internal/remote/worker"
	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/workspace"
)

// Publishing a session's work from a phone.
//
// The tap is the whole feature: a person looking at what a session changed taps
// 发布, and a branch and a pull request exist. Everything that makes that safe is
// on the machine — the boundary, the default branch, the uncommitted work, the
// push that is never forced — so the cases here are about the Hub's half of it:
// which machine is asked, what the phone is told, and what the Hub writes down.
//
// The machine's push is a seam (Responder.Publish) for the same reason the read
// is: what matters here is not what git does, it is that the Hub asks the right
// machine and believes the answer only as far as it checked it.

// machinePublish is the publish one machine makes, replaceable between requests.
type machinePublish struct {
	mu      sync.Mutex
	out     github.PublishOutcome
	err     error
	asked   []github.PublishRequest
	devices []string
}

func (m *machinePublish) install(t *testing.T) func(*node.Responder) {
	t.Helper()
	return func(r *node.Responder) {
		r.Publish = func(_ context.Context, _ *workspace.Manager, req github.PublishRequest) (github.PublishOutcome, error) {
			m.mu.Lock()
			defer m.mu.Unlock()
			m.asked = append(m.asked, req)
			return m.out, m.err
		}
	}
}

func (m *machinePublish) answer(out github.PublishOutcome) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.out, m.err = out, nil
}

func (m *machinePublish) requests() []github.PublishRequest {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]github.PublishRequest(nil), m.asked...)
}

// published is one machine's answer to a publish that worked.
func published(t *testing.T, repo, branch string, number int) github.PublishOutcome {
	t.Helper()
	return github.PublishOutcome{
		Repo:    mustRepo(t, repo),
		Branch:  branch,
		HeadOID: "abc123",
		Pushed:  true,
		Number:  number,
		URL:     "https://github.com/owner/app/pull/7",
	}
}

func mustRepo(t *testing.T, canonical string) github.Repo {
	t.Helper()
	repo, ok := github.ParseCanonical(canonical)
	if !ok {
		t.Fatalf("%q is not a canonical repository", canonical)
	}
	return repo
}

// publishHub is a Hub with one paired machine whose publish is the given seam,
// and the checkout that machine works in.
func publishHub(t *testing.T, seam func(*node.Responder)) (*Server, http.Handler, string, string, string) {
	t.Helper()
	return publishHubOn(t, nil, seam)
}

// publishHubOn is publishHub on a Hub configured before its router is built.
// The holder-only case needs the account system: without it there is no second
// person to refuse, and the gate would be tested against nobody.
func publishHubOn(t *testing.T, before func(*Server), seam func(*node.Responder)) (*Server, http.Handler, string, string, string) {
	t.Helper()
	root := t.TempDir()
	work := prCheckout(t, root)
	s, h, master, deviceID := hubWith(t, before, seam, root)
	s.GitHub = github.NewService(s.Store)
	s.BindGitHubMachines()
	return s, h, master, deviceID, work
}

func publishBody(title, body string) string {
	raw, _ := json.Marshal(publishPRRequest{Title: title, Body: body})
	return string(raw)
}

// publishingPath is the route a phone's publish sheet calls.
const publishingPath = "/api/tasks/%s/pr/publish"

func TestPublishingARemoteTaskPushesOnItsMachineAndRecordsThePullRequest(t *testing.T) {
	push := &machinePublish{}
	s, h, master, deviceID, work := publishHub(t, push.install(t))
	push.answer(published(t, "github.com/owner/app", "kin/task/t1/g1", 4242))

	task := remoteTask(t, s, deviceID, work, "")
	recordedOn(t, s, task.ID, "github.com/owner/app", "stale/from-when-it-started")

	client := &authClient{t: t, h: h, master: master}
	rec := client.post(fmt.Sprintf(publishingPath, task.ID), publishBody("Add the thing", "It does the thing."))
	if rec.Code != http.StatusOK {
		t.Fatalf("publish: %d %s", rec.Code, rec.Body.String())
	}
	var report github.PublishReport
	if err := json.Unmarshal(rec.Body.Bytes(), &report); err != nil {
		t.Fatal(err)
	}
	if !report.Pushed || report.Number != 4242 || report.URL != "https://github.com/owner/app/pull/7" {
		t.Fatalf("report = %+v", report)
	}

	// The machine was asked about the checkout it holds, in the person's words.
	asked := push.requests()
	if len(asked) != 1 {
		t.Fatalf("the machine was asked %d times, want once", len(asked))
	}
	if asked[0].Dir != work {
		t.Errorf("asked about %q, want the machine's checkout %q", asked[0].Dir, work)
	}
	if asked[0].Title != "Add the thing" || asked[0].Body != "It does the thing." {
		t.Errorf("asked with %+v, want the sheet's words", asked[0])
	}

	// The panel is drawn from rows, so the row has to be there: a pull request
	// nobody wrote down is one the phone cannot see until it refreshes.
	read := client.get("/api/tasks/" + task.ID + "/pr")
	if read.Code != http.StatusOK {
		t.Fatalf("read after publish: %d %s", read.Code, read.Body.String())
	}
	snap := prSnapshot(t, read)
	found := false
	for _, obs := range snap.Observations {
		if obs.HeadBranch == "kin/task/t1/g1" && obs.Number != nil && *obs.Number == 4242 {
			found = true
		}
	}
	if !found {
		t.Fatalf("the published pull request is not in the panel: %+v", snap.Observations)
	}
	// And where the work is moved on the task row, which is what the panel draws
	// before anybody asks anything.
	row, err := s.Store.GetTask(context.Background(), task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if row.WorkspaceBranch != "kin/task/t1/g1" {
		t.Fatalf("task row branch = %q, want the branch that was published", row.WorkspaceBranch)
	}
}

// A session whose checkout this Hub holds is refused rather than served:
// pushing the operator's own directory from a phone is a different decision.
func TestPublishingATaskThatRunsHereIsRefused(t *testing.T) {
	push := &machinePublish{}
	s, h, master, _, _ := publishHub(t, push.install(t))
	work := prCheckout(t, t.TempDir())
	task := remoteTask(t, s, "", work, "")

	client := &authClient{t: t, h: h, master: master}
	rec := client.post(fmt.Sprintf(publishingPath, task.ID), publishBody("t", "b"))
	if rec.Code != http.StatusConflict {
		t.Fatalf("publish of a local task: %d %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "only writes in the checkouts") {
		t.Errorf("error = %s, want the reason", rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"code":"session_runs_here"`) {
		t.Errorf("body = %s, want the code the console keys on", rec.Body.String())
	}
	if len(push.requests()) != 0 {
		t.Fatal("a machine was asked to push for a task that runs here")
	}
}

// A refusal is an answer with a code, because one of them — the default branch —
// is something the phone can offer a way out of.
func TestPublishingCarriesTheMachinesRefusalAsAnAnswer(t *testing.T) {
	push := &machinePublish{}
	s, h, master, deviceID, work := publishHub(t, push.install(t))
	push.answer(github.PublishOutcome{
		Repo:    mustRepo(t, "github.com/owner/app"),
		Branch:  "main",
		Blocked: github.PublishBlockedDefault,
		Reason:  "this checkout is on main, which is this repository's default branch",
	})

	task := remoteTask(t, s, deviceID, work, "")
	client := &authClient{t: t, h: h, master: master}
	rec := client.post(fmt.Sprintf(publishingPath, task.ID), publishBody("t", "b"))
	if rec.Code != http.StatusOK {
		t.Fatalf("publish: %d %s", rec.Code, rec.Body.String())
	}
	var report github.PublishReport
	if err := json.Unmarshal(rec.Body.Bytes(), &report); err != nil {
		t.Fatal(err)
	}
	if report.Blocked != github.PublishBlockedDefault {
		t.Fatalf("blocked = %q (%s), want the default branch", report.Blocked, report.Reason)
	}
	if report.Pushed || report.Number != 0 {
		t.Fatalf("a refused publish reported a push: %+v", report)
	}
	// Nothing was published, so nothing was written: the last true thing the panel
	// knows stays.
	read := client.get("/api/tasks/" + task.ID + "/pr")
	snap := prSnapshot(t, read)
	for _, obs := range snap.Observations {
		if obs.HeadBranch == "main" && obs.Number != nil {
			t.Fatalf("a refusal wrote a pull request: %+v", obs)
		}
	}
}

// A failed push is the machine saying no to the question, and the phone is told
// so in the machine's words.
func TestPublishingReportsAFailedPushAsTheMachinesOwnRefusal(t *testing.T) {
	push := &machinePublish{}
	s, h, master, deviceID, work := publishHub(t, push.install(t))
	push.mu.Lock()
	push.err = errTestPushRefused
	push.mu.Unlock()

	task := remoteTask(t, s, deviceID, work, "")
	client := &authClient{t: t, h: h, master: master}
	rec := client.post(fmt.Sprintf(publishingPath, task.ID), publishBody("t", "b"))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("failed push: %d %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "non-fast-forward") {
		t.Errorf("error = %s, want the machine's own words", rec.Body.String())
	}
}

// Words that cannot travel are refused where they can still be edited, before a
// branch is pushed on their behalf.
func TestPublishingRefusesWordsThatCannotTravel(t *testing.T) {
	push := &machinePublish{}
	s, h, master, deviceID, work := publishHub(t, push.install(t))
	push.answer(published(t, "github.com/owner/app", "kin/task/t1/g1", 1))

	task := remoteTask(t, s, deviceID, work, "")
	client := &authClient{t: t, h: h, master: master}
	rec := client.post(fmt.Sprintf(publishingPath, task.ID), publishBody("two\nlines", "b"))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("a title with a newline: %d %s", rec.Code, rec.Body.String())
	}
	// An empty title is refused for a different reason than a title with a
	// newline in it — `gh pr create` would open an editor, and the machine has
	// none — and it is refused here so the person types one.
	rec = client.post(fmt.Sprintf(publishingPath, task.ID), publishBody("   ", "b"))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("a title of nothing: %d %s", rec.Code, rec.Body.String())
	}
	rec = client.post(fmt.Sprintf(publishingPath, task.ID),
		publishBody("t", strings.Repeat("x", worker.MaxPRBody+1)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("a body past the bound: %d %s", rec.Code, rec.Body.String())
	}
	if len(push.requests()) != 0 {
		t.Fatal("words this Hub will not carry reached the machine")
	}
}

// A member account is not the machine's holder: it runs its own tasks and has no
// business pushing the holder's checkouts. The paired phone is the holder, and
// passes — that is what pairing is for.
func TestPublishingIsHolderOnly(t *testing.T) {
	push := &machinePublish{}
	s, h, master, deviceID, work := publishHubOn(t, accountsOn, push.install(t))
	push.answer(published(t, "github.com/owner/app", "kin/task/t1/g1", 1))

	// The task belongs to the member on purpose. On a task they cannot see, the
	// answer is 404 and would prove nothing about this gate.
	member := joinMember(t, s, h, "acct-publisher", "publisher@example.com")
	if err := s.Store.InsertTask(t.Context(), store.Task{
		ID: "task-member-publish", Title: "Member", Agent: "claude-code", Cwd: work,
		Prompt: "p", Status: "running", CreatedAt: time.Now().UnixMilli(),
		ExecutingDeviceID: deviceID, OwnerUserID: "acct-publisher",
	}); err != nil {
		t.Fatal(err)
	}
	path := fmt.Sprintf(publishingPath, "task-member-publish")
	if rec := member.post(path, publishBody("t", "b")); rec.Code != http.StatusForbidden {
		t.Fatalf("member publish: %d %s, want 403", rec.Code, rec.Body.String())
	}
	if len(push.requests()) != 0 {
		t.Fatal("a member account reached a machine's publisher")
	}

	client := &authClient{t: t, h: h, master: master}
	if rec := client.post(path, publishBody("t", "b")); rec.Code != http.StatusOK {
		t.Fatalf("holder publish: %d %s", rec.Code, rec.Body.String())
	}
}

// The repository the machine names is checked before it is written down: a row
// keyed on an answer nobody read would file another repository's pull request
// under this task.
func TestPublishingRefusesAnAnswerItCannotName(t *testing.T) {
	push := &machinePublish{}
	s, h, master, deviceID, work := publishHub(t, push.install(t))
	out := published(t, "github.com/owner/app", "kin/task/t1/g1", 7)
	out.Repo = github.Repo{}
	push.answer(out)

	task := remoteTask(t, s, deviceID, work, "")
	client := &authClient{t: t, h: h, master: master}
	rec := client.post(fmt.Sprintf(publishingPath, task.ID), publishBody("t", "b"))
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("an unnameable answer: %d %s", rec.Code, rec.Body.String())
	}
	obs, err := s.Store.ListPRObservationsByTask(context.Background(), task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) != 0 {
		t.Fatalf("an unnamed answer was written down: %+v", obs)
	}
}

// store.ErrNotFound and the machine's own answers are all this route can be told
// apart by; a task that is not there is a 404 for the same reason it is anywhere
// else on this subtree.
func TestPublishingATaskThatIsNotThere(t *testing.T) {
	push := &machinePublish{}
	_, h, master, _, _ := publishHub(t, push.install(t))
	client := &authClient{t: t, h: h, master: master}
	if rec := client.post(fmt.Sprintf(publishingPath, "no-such-task"), publishBody("t", "b")); rec.Code != http.StatusNotFound {
		t.Fatalf("publish of a task that is not there: %d %s", rec.Code, rec.Body.String())
	}
}

var errTestPushRefused = errors.New("git push: non-fast-forward, the remote has commits this branch does not")
