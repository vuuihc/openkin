package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/vuuihc/openkin/internal/node"
	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/workspace"
)

// The one-tap escape from a publish refused on the default branch.
//
// A publish of a checkout on main is refused by the machine, and the way out is
// a branch of the task's own. That branch is named by the Hub, on the machine,
// and the row follows it — which is what these cases are about. What git does
// with the name is the workspace package's business (see publish_test.go there);
// here it is a seam, because the fact under test is that the right machine was
// asked about the right directory with the right name.

// machineBranch records the branch a machine was asked for, and starts it for
// real unless err says otherwise.
//
// It delegates rather than faking because the read-back is part of the answer: a
// machine names the branch its checkout is on *after* moving, and a test that
// faked both halves would assert its own echo.
type machineBranch struct {
	mu    sync.Mutex
	err   error
	asked []string
}

func (m *machineBranch) install(t *testing.T) func(*node.Responder) {
	t.Helper()
	return func(r *node.Responder) {
		r.CreateBranch = func(ctx context.Context, git *workspace.Manager, dir, branch string) error {
			m.mu.Lock()
			m.asked = append(m.asked, branch)
			err := m.err
			m.mu.Unlock()
			if err != nil {
				return err
			}
			return git.CreateBranch(ctx, dir, branch)
		}
	}
}

func (m *machineBranch) branches() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]string(nil), m.asked...)
}

const taskBranchPath = "/api/tasks/%s/branch"

// The tap: the task's branch appears on the machine, the checkout moves onto it,
// and the row the console draws from follows.
func TestCreatingATaskBranchAsksTheMachineAndMovesTheRow(t *testing.T) {
	made := &machineBranch{}
	s, h, master, deviceID, work := publishHub(t, made.install(t))
	task := remoteTask(t, s, deviceID, work, "")
	recordedOn(t, s, task.ID, "github.com/owner/app", "main")
	want := workspace.TaskBranch(task.ID)

	client := &authClient{t: t, h: h, master: master}
	rec := client.post(fmt.Sprintf(taskBranchPath, task.ID), "")
	if rec.Code != http.StatusOK {
		t.Fatalf("create branch: %d %s", rec.Code, rec.Body.String())
	}
	var answer struct {
		Cwd     string `json:"cwd"`
		Current string `json:"current"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &answer); err != nil {
		t.Fatal(err)
	}
	// The name is the Hub's: `kin/task/<id>/g1`, the same one Kin gives a task's
	// work everywhere else. A phone inventing its own would scatter the work.
	if got := made.branches(); len(got) != 1 || got[0] != want {
		t.Fatalf("machine asked for %v, want exactly [%s]", got, want)
	}
	// And the answer names where the checkout is now, read back from the checkout
	// rather than echoed: this is the line the sheet shows the person.
	if answer.Current != want {
		t.Fatalf("current = %q, want the branch the checkout moved to (%q)", answer.Current, want)
	}

	// The row is what the sheet draws before anybody asks anything, and the work
	// has just moved off main.
	row, err := s.Store.GetTask(context.Background(), task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if row.WorkspaceBranch != want {
		t.Fatalf("row branch = %q, want the branch the checkout moved to", row.WorkspaceBranch)
	}
	if row.WorkspaceRepo != "github.com/owner/app" {
		t.Fatalf("row repo = %q, want it left alone", row.WorkspaceRepo)
	}
}

// A session whose checkout this Hub holds is refused, for the reason a publish
// of one is: the person is already sitting next to that directory.
func TestCreatingATaskBranchForASessionThatRunsHereIsRefused(t *testing.T) {
	made := &machineBranch{}
	s, h, master, _, _ := publishHub(t, made.install(t))
	work := prCheckout(t, t.TempDir())
	task := remoteTask(t, s, "", work, "")

	client := &authClient{t: t, h: h, master: master}
	rec := client.post(fmt.Sprintf(taskBranchPath, task.ID), "")
	if rec.Code != http.StatusConflict {
		t.Fatalf("create branch for a local session: %d %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "only writes in the checkouts") {
		t.Errorf("error = %s, want the reason", rec.Body.String())
	}
	if len(made.branches()) != 0 {
		t.Fatal("a machine was asked to move a branch for a session that runs here")
	}
}

// A machine that will not start the branch says so in its own words, and the row
// keeps what it had.
func TestCreatingATaskBranchReportsTheMachinesRefusal(t *testing.T) {
	made := &machineBranch{err: fmt.Errorf("branch %q already exists", "kin/task/t1/g1")}
	s, h, master, deviceID, work := publishHub(t, made.install(t))
	task := remoteTask(t, s, deviceID, work, "")
	recordedOn(t, s, task.ID, "github.com/owner/app", "main")

	client := &authClient{t: t, h: h, master: master}
	rec := client.post(fmt.Sprintf(taskBranchPath, task.ID), "")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("refused branch: %d %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "already exists") {
		t.Errorf("error = %s, want the machine's own sentence", rec.Body.String())
	}
	row, err := s.Store.GetTask(context.Background(), task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if row.WorkspaceBranch != "main" {
		t.Fatalf("row branch = %q, want it untouched by a refusal", row.WorkspaceBranch)
	}
}

// Moving a checkout belongs to the machine's holder. A member account is another
// person on this Hub and has no business rearranging the holder's directories.
func TestCreatingATaskBranchIsHolderOnly(t *testing.T) {
	made := &machineBranch{}
	s, h, master, deviceID, work := publishHubOn(t, accountsOn, made.install(t))

	member := joinMember(t, s, h, "acct-brancher", "brancher@example.com")
	if err := s.Store.InsertTask(t.Context(), store.Task{
		ID: "task-member-branch", Title: "Member", Agent: "claude-code", Cwd: work,
		Prompt: "p", Status: "running", ExecutingDeviceID: deviceID,
		OwnerUserID: "acct-brancher",
	}); err != nil {
		t.Fatal(err)
	}
	path := fmt.Sprintf(taskBranchPath, "task-member-branch")
	if rec := member.post(path, ""); rec.Code != http.StatusForbidden {
		t.Fatalf("member creating a branch: %d %s, want 403", rec.Code, rec.Body.String())
	}
	if len(made.branches()) != 0 {
		t.Fatal("a member account moved a machine's checkout")
	}
	// The holder passes, which is what proves the refusal above is this gate and
	// not the route being unreachable.
	client := &authClient{t: t, h: h, master: master}
	if rec := client.post(path, ""); rec.Code != http.StatusOK {
		t.Fatalf("holder creating a branch: %d %s", rec.Code, rec.Body.String())
	}
}
