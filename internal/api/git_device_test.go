package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/vuuihc/openkin/internal/node"
	"github.com/vuuihc/openkin/internal/workspace"
)

// The branch control, asked about a machine rather than about a code path.
//
// Everything here runs on one filesystem, because a test cannot have two. That
// is what makes these tests worth writing: the wrong answer is available, it is
// plausible, and it comes from the same git reading a directory that really does
// exist. So each test is built so that this daemon's answer and the machine's
// answer differ, and then asserts which one came back.

// gitMachine is a Hub with one paired machine that reads its own checkouts.
//
// workspaceOnNode false is a machine with no git: it still answers questions,
// and says it cannot answer this one.
func gitMachine(t *testing.T, workspaceOnNode bool) (http.Handler, string, string, string, string) {
	t.Helper()
	s, master, conns := machinesServer(t)
	// This daemon reads its own checkouts, and has no roots: the branch control
	// on a desktop is about a directory the person picked in a native dialog.
	s.Workspace = workspace.NewManager(t.TempDir())
	h := s.Handler()
	hub := httptest.NewServer(h)
	t.Cleanup(hub.Close)
	deviceToken, deviceID := pairDevice(t, h, master)
	root := t.TempDir()
	responder := &node.Responder{Roots: []string{root}}
	if workspaceOnNode {
		responder.Workspace = workspace.NewManager(root)
	}
	runResponder(t, hub.URL, deviceToken, responder)
	awaitConnected(t, conns, deviceID)
	return h, master, deviceToken, deviceID, root
}

// getBranches asks the branch question, optionally naming a machine.
func getBranches(t *testing.T, h http.Handler, token, cwd, device string) *httptest.ResponseRecorder {
	t.Helper()
	path := "/api/git/branches?cwd=" + url.QueryEscape(cwd)
	if device != "" {
		path += "&device=" + url.QueryEscape(device)
	}
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// askCheckout switches a branch, optionally naming a machine.
func askCheckout(t *testing.T, h http.Handler, token, cwd, branch, device string) *httptest.ResponseRecorder {
	t.Helper()
	body := map[string]string{"cwd": cwd, "branch": branch}
	if device != "" {
		body["device"] = device
	}
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/git/checkout", bytes.NewReader(raw))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// repo makes a real repository at a called-for path.
func repo(t *testing.T, path string) string {
	t.Helper()
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatal(err)
	}
	initRepo(t, path)
	return path
}

// why reads the reason out of a refusal.
func why(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var refusal struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &refusal); err != nil {
		t.Fatalf("a refusal that is not one: %s", rec.Body.String())
	}
	if refusal.Error == "" {
		t.Fatalf("the refusal carries no reason: %s", rec.Body.String())
	}
	return refusal.Error
}

// currentBranch reads what git says a checkout is on, from outside this daemon:
// the question is what happened on disk, not what the handler reported.
func currentBranch(t *testing.T, dir string) string {
	t.Helper()
	out, err := exec.Command("git", "-C", dir, "symbolic-ref", "--short", "HEAD").Output()
	if err != nil {
		t.Fatalf("read the branch of %s: %v", dir, err)
	}
	return strings.TrimSpace(string(out))
}

// A directory on this machine that the named machine does not work in is the
// named machine's business, and it says no.
//
// The same directory, asked about without a machine, is answered — it is a
// repository here, and this daemon can read it. So the two answers differ, and
// what the console gets is the one it asked for. On a phone the case is not
// exotic: two machines hold the same repository at the same-looking path, and
// the branches of the wrong one are exactly what a person would not notice.
func TestGitBranchesAsksTheMachineThatHasTheDirectory(t *testing.T) {
	requireGitBin(t)
	h, master, _, deviceID, _ := gitMachine(t, true)

	here := repo(t, filepath.Join(t.TempDir(), "checkout"))

	rec := getBranches(t, h, master, here, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("local: %d %s", rec.Code, rec.Body.String())
	}
	var local struct {
		Cwd     string `json:"cwd"`
		IsGit   bool   `json:"is_git"`
		Current string `json:"current"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &local); err != nil {
		t.Fatal(err)
	}
	if !local.IsGit || local.Current != "main" {
		t.Fatalf("local answer = %+v, want the checkout in %s", local, here)
	}

	rec = getBranches(t, h, master, here, deviceID)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("remote: %d %s, want the machine's refusal", rec.Code, rec.Body.String())
	}
	if why(t, rec) == "" {
		t.Fatal("no reason given")
	}
}

// The machine answers with the same shape this daemon answers with, so the
// control drawing it does not have to know which machine it asked.
//
// The fields are asserted rather than the type, because the claim is about what
// crosses the wire: two structs in two packages that drift apart would still
// compile on both sides.
func TestGitBranchesFromAMachineIsTheSameAnswer(t *testing.T) {
	requireGitBin(t)
	h, master, _, deviceID, root := gitMachine(t, true)
	repo(t, filepath.Join(root, "checkout"))

	rec := getBranches(t, h, master, filepath.Join(root, "checkout"), deviceID)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var answer struct {
		Cwd      string `json:"cwd"`
		IsGit    bool   `json:"is_git"`
		Current  string `json:"current"`
		Detached bool   `json:"detached"`
		Dirty    bool   `json:"dirty"`
		Branches []struct {
			Name    string `json:"name"`
			Current bool   `json:"current"`
		} `json:"branches"`
		Reason string `json:"reason"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &answer); err != nil {
		t.Fatal(err)
	}
	if !answer.IsGit || answer.Current != "main" {
		t.Fatalf("answer = %+v, want the machine's checkout", answer)
	}
	if len(answer.Branches) < 2 {
		t.Fatalf("branches = %v", answer.Branches)
	}
	for _, b := range answer.Branches {
		if b.Name == "main" && !b.Current {
			t.Fatal("the checked-out branch is not marked as current")
		}
	}
	// The console reads this field as a list and has no absent case for it.
	if !bytes.Contains(rec.Body.Bytes(), []byte(`"branches":[`)) {
		t.Fatalf("branches is not a list in %s", rec.Body.String())
	}
}

// A paired machine that is not connected is an error, and never this machine's
// answer about a path that happens to exist here too.
func TestGitBranchesOnAnOfflineMachineIsRefused(t *testing.T) {
	requireGitBin(t)
	s, master, conns := machinesServer(t)
	s.Workspace = workspace.NewManager(t.TempDir())
	h := s.Handler()
	_, deviceID := pairDevice(t, h, master)
	if conns.Connected(deviceID) {
		t.Fatal("the device is connected without anything having dialled in")
	}

	here := repo(t, filepath.Join(t.TempDir(), "checkout"))

	rec := getBranches(t, h, master, here, deviceID)
	if rec.Code != http.StatusConflict {
		t.Fatalf("offline: %d %s, want 409", rec.Code, rec.Body.String())
	}
	if why(t, rec) == "" {
		t.Fatal("no reason given")
	}
}

// A machine with no git says so, rather than being answered for.
func TestGitBranchesOnAMachineWithoutGitIsItsOwnRefusal(t *testing.T) {
	requireGitBin(t)
	h, master, _, deviceID, root := gitMachine(t, false)

	rec := getBranches(t, h, master, root, deviceID)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d: %s, want the machine's refusal", rec.Code, rec.Body.String())
	}
	if why(t, rec) == "" {
		t.Fatal("no reason given")
	}
}

// A path that is not absolute is not a question this protocol carries, and it is
// refused here rather than by the machine: it would be resolved against whatever
// directory that daemon was started in, which is not the Hub's choice to make.
func TestGitBranchesOnAMachineRefusesARelativePath(t *testing.T) {
	h, master, _, deviceID, _ := gitMachine(t, true)

	rec := getBranches(t, h, master, "some/where", deviceID)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
}

// The branch is the one parameter of these two questions that becomes an
// argument to git on the other machine, so a string that would be read as a
// switch is refused before it is sent.
func TestGitCheckoutOnAMachineRefusesABranchThatIsAnOption(t *testing.T) {
	requireGitBin(t)
	h, _, deviceToken, deviceID, root := gitMachine(t, true)
	dir := repo(t, filepath.Join(root, "checkout"))

	rec := askCheckout(t, h, deviceToken, dir, "--force", deviceID)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d: %s, want a refusal", rec.Code, rec.Body.String())
	}
	if why(t, rec) == "" {
		t.Fatal("no reason given")
	}
}

// Switching a branch on a machine the caller is paired with is what pairing is
// for; switching one on the daemon serving the console is the operator's.
func TestGitCheckoutOnThisMachineStaysTheOperators(t *testing.T) {
	requireGitBin(t)
	h, master, deviceToken, deviceID, root := gitMachine(t, true)
	dir := repo(t, filepath.Join(root, "checkout"))

	// The paired device, aimed at this machine: refused, even though it holds a
	// token this daemon accepts and the path is one it may browse.
	rec := askCheckout(t, h, deviceToken, dir, "dev", "")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("device switching this machine's checkout: %d %s, want 403", rec.Code, rec.Body.String())
	}
	if why(t, rec) == "" {
		t.Fatal("no reason given")
	}

	// ...and aimed at itself: that machine's own checkout, which is its to move.
	rec = askCheckout(t, h, deviceToken, dir, "dev", deviceID)
	if rec.Code != http.StatusOK {
		t.Fatalf("device switching the machine's own checkout: %d %s", rec.Code, rec.Body.String())
	}
	var switched struct {
		Cwd     string `json:"cwd"`
		Current string `json:"current"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &switched); err != nil {
		t.Fatal(err)
	}
	if switched.Current != "dev" {
		t.Fatalf("current = %q, want dev", switched.Current)
	}

	// The operator still may, on this machine.
	rec = askCheckout(t, h, master, dir, "main", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("operator switching this machine's checkout: %d %s", rec.Code, rec.Body.String())
	}
}

// The machine checks its own boundary, and a checkout is a write: a path it does
// not work in is refused before anything is written there.
func TestGitCheckoutOnAMachineStaysInsideItsRoots(t *testing.T) {
	requireGitBin(t)
	h, _, deviceToken, deviceID, root := gitMachine(t, true)
	dir := repo(t, filepath.Join(root, "checkout"))
	outside := repo(t, filepath.Join(t.TempDir(), "elsewhere"))

	rec := askCheckout(t, h, deviceToken, outside, "dev", deviceID)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("outside the roots: %d %s, want the machine's refusal", rec.Code, rec.Body.String())
	}
	if why(t, rec) == "" {
		t.Fatal("no reason given")
	}

	// Nothing was written there: the checkout outside the roots is untouched.
	if current := currentBranch(t, outside); current != "main" {
		t.Fatalf("the checkout outside the roots moved to %q", current)
	}

	rec = askCheckout(t, h, deviceToken, dir, "dev", deviceID)
	if rec.Code != http.StatusOK {
		t.Fatalf("inside the roots: %d %s", rec.Code, rec.Body.String())
	}
	if current := currentBranch(t, dir); current != "dev" {
		t.Fatalf("the checkout inside the roots is on %q, want dev", current)
	}
}

// A device the Hub does not know is refused as an unknown machine, on this route
// as on every other one.
func TestGitBranchesOnAnUnknownMachineIsRefused(t *testing.T) {
	h, master, _, _, _ := gitMachine(t, true)

	rec := getBranches(t, h, master, t.TempDir(), "desktop-nobody")
	if rec.Code == http.StatusOK {
		t.Fatalf("an unknown machine was answered: %s", rec.Body.String())
	}
	if why(t, rec) == "" {
		t.Fatal("no reason given")
	}
}
