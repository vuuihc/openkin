package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/vuuihc/openkin/internal/node"
	"github.com/vuuihc/openkin/internal/remote/worker"
)

// The other half of starting a session from a phone: not "which folder" but
// "which repository", for the case where the answer is one the machine does not
// have yet.
//
// These run the whole thing — console, Hub, the wire the machine dialled in on,
// the machine's own responder, and a real git fetching a real repository over
// the loopback — because the claim being tested is that a phone can do this at
// all, and every layer between the phone and the clone is a place that claim can
// quietly stop being true.

// getRepo asks one machine a question whose answer is a repository's branches.
func getRepo(t *testing.T, h http.Handler, token, device, path string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/machines/"+device+path, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// postPrepare asks one machine to make a repository available on itself.
func postPrepare(t *testing.T, h http.Handler, token, device, repo, branch string) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(map[string]string{"repo": repo, "branch": branch})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/machines/"+device+"/repo/prepare", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// gitOrigin is a repository a machine in this test can actually fetch, without
// leaving the machine: a bare repository served over plain HTTP, which is the
// one transport git speaks to a file server.
//
// The directory has no `.git` suffix on purpose. A canonical name strips one,
// so the name the console types and the path the server serves have to be the
// same string for the fetch to find anything.
func gitOrigin(t *testing.T) string {
	t.Helper()
	return gitOriginWithBranches(t, 0)
}

// gitOriginWithBranches is gitOrigin plus extra branches, for the question of
// what happens when a repository has more of them than a picker can use.
func gitOriginWithBranches(t *testing.T, extra int) string {
	t.Helper()
	gitPath, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git not installed")
	}
	work := t.TempDir()
	originGit(t, gitPath, work, "init", "-b", "main")
	originGit(t, gitPath, work, "config", "user.email", "owner@example.com")
	originGit(t, gitPath, work, "config", "user.name", "Owner")
	if err := os.WriteFile(filepath.Join(work, "README.md"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	originGit(t, gitPath, work, "add", "README.md")
	originGit(t, gitPath, work, "commit", "-m", "first")
	originGit(t, gitPath, work, "branch", "alpha")
	if extra > 0 {
		var refs strings.Builder
		for i := range extra {
			fmt.Fprintf(&refs, "create refs/heads/b%04d HEAD\n", i)
		}
		originGitIn(t, gitPath, work, refs.String(), "update-ref", "--stdin")
	}

	parent := t.TempDir()
	bare := filepath.Join(parent, "origin")
	originGit(t, gitPath, "", "clone", "--bare", work, bare)
	// A file server speaks no git protocol, so the refs it needs are written out
	// as files for it to serve.
	originGit(t, gitPath, bare, "update-server-info")

	server := httptest.NewServer(http.FileServer(http.Dir(parent)))
	t.Cleanup(server.Close)
	return server.URL + "/origin"
}

// originGit runs git for the fixture, with this machine's own configuration kept
// out of it.
func originGit(t *testing.T, gitPath, dir string, args ...string) {
	t.Helper()
	originGitIn(t, gitPath, dir, "", args...)
}

// originGitIn is originGit with something on stdin, for the git commands whose
// input is a list.
func originGitIn(t *testing.T, gitPath, dir, stdin string, args ...string) {
	t.Helper()
	cmd := exec.Command(gitPath, args...)
	if dir != "" {
		cmd.Dir = dir
	}
	cmd.Stdin = strings.NewReader(stdin)
	cmd.Env = append(os.Environ(),
		"GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_CONFIG_SYSTEM=/dev/null",
		"GIT_CONFIG_COUNT=0",
		"GIT_TERMINAL_PROMPT=0",
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %s: %v: %s", strings.Join(args, " "), err, out)
	}
}

// fetchedMachine is a Hub, a paired phone, and a machine that has somewhere to
// put a repository.
func fetchedMachine(t *testing.T) (http.Handler, string, string, *node.Connections, string) {
	t.Helper()
	s, master, conns := machinesServer(t)
	hub := httptest.NewServer(s.Handler())
	t.Cleanup(hub.Close)
	deviceToken, deviceID := pairDevice(t, s.Handler(), master)
	checkoutRoot := filepath.Join(t.TempDir(), "checkouts")
	runResponder(t, hub.URL, deviceToken, &node.Responder{
		Roots:        []string{checkoutRoot},
		CheckoutRoot: checkoutRoot,
	})
	awaitConnected(t, conns, deviceID)
	return s.Handler(), deviceToken, deviceID, conns, checkoutRoot
}

// What the console asks before it pays for a clone: the branches are on the
// remote, and naming one does not require the machine to have any of it.
func TestMachineRepoBranchesAnswerWithoutCloning(t *testing.T) {
	h, token, deviceID, _, checkoutRoot := fetchedMachine(t)
	repo := gitOrigin(t)

	rec := getRepo(t, h, token, deviceID, "/repo/branches?repo="+url.QueryEscape(repo))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var answer struct {
		CloneURL      string   `json:"clone_url"`
		DefaultBranch string   `json:"default_branch"`
		Branches      []string `json:"branches"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &answer); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(answer.Branches, ","); got != "alpha,main" {
		t.Fatalf("branches = %q, want alpha,main", got)
	}
	if answer.DefaultBranch != "main" {
		t.Fatalf("default = %q, want main", answer.DefaultBranch)
	}
	if answer.CloneURL != repo {
		t.Fatalf("clone_url = %q, want the remote the console will be told to ask with", answer.CloneURL)
	}
	// Nothing was cloned: reading a remote's branches is not a reason to put a
	// copy of it on somebody's disk.
	assertNothingFetched(t, checkoutRoot)
}

// The two questions are one conversation: whatever the first answer says the
// repository is, asking the second question with those words has to work.
//
// This is the shape a phone is in — it cannot see either machine's filesystem,
// so the answer to the first question is the only name it has for the second —
// and it is a shape that broke once, because the name that travels back was the
// canonical one, which carries no transport.
func TestMachineRepoBranchesAnswerIsWhatPrepareIsAskedWith(t *testing.T) {
	h, token, deviceID, _, checkoutRoot := fetchedMachine(t)

	rec := getRepo(t, h, token, deviceID, "/repo/branches?repo="+url.QueryEscape(gitOrigin(t)))
	if rec.Code != http.StatusOK {
		t.Fatalf("branches: status %d: %s", rec.Code, rec.Body.String())
	}
	var answer struct {
		CloneURL string `json:"clone_url"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &answer); err != nil {
		t.Fatal(err)
	}

	rec = postPrepare(t, h, token, deviceID, answer.CloneURL, "alpha")
	if rec.Code != http.StatusOK {
		t.Fatalf("prepare with the answer %q: status %d: %s", answer.CloneURL, rec.Code, rec.Body.String())
	}
	var prepared struct {
		Path   string `json:"path"`
		Branch string `json:"branch"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &prepared); err != nil {
		t.Fatal(err)
	}
	if prepared.Branch != "alpha" {
		t.Fatalf("branch = %q, want alpha", prepared.Branch)
	}
	if !strings.HasPrefix(prepared.Path, checkoutRoot+string(filepath.Separator)) {
		t.Fatalf("path = %q, want it under %q", prepared.Path, checkoutRoot)
	}
}

// A repository with more branches than a picker can use is answered with the
// first of them and a flag saying so, rather than with all of them: what a
// person needs is somewhere to tap, and the phone pays for every name it is
// handed.
func TestMachineRepoBranchesStopAtTheCap(t *testing.T) {
	h, token, deviceID, _, _ := fetchedMachine(t)
	repo := gitOriginWithBranches(t, worker.MaxBranches+1)

	rec := getRepo(t, h, token, deviceID, "/repo/branches?repo="+url.QueryEscape(repo))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var answer struct {
		Branches  []string `json:"branches"`
		Truncated bool     `json:"truncated"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &answer); err != nil {
		t.Fatal(err)
	}
	if len(answer.Branches) != worker.MaxBranches {
		t.Fatalf("got %d branches, want %d", len(answer.Branches), worker.MaxBranches)
	}
	if !answer.Truncated {
		t.Fatal("the answer does not say it was cut")
	}
}

// The whole point: a repository the machine does not have, named from a phone,
// ends as a working directory a session can be started in.
func TestMachineRepoPrepareFetchesOnTheMachineAndSaysWhere(t *testing.T) {
	h, token, deviceID, _, checkoutRoot := fetchedMachine(t)
	repo := gitOrigin(t)

	rec := postPrepare(t, h, token, deviceID, repo, "alpha")
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var prepared struct {
		Path   string `json:"path"`
		Branch string `json:"branch"`
		Cloned bool   `json:"cloned"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &prepared); err != nil {
		t.Fatal(err)
	}
	if !prepared.Cloned {
		t.Fatal("cloned = false, want the first prepare to be the one that fetched it")
	}
	if prepared.Branch != "alpha" {
		t.Fatalf("branch = %q, want alpha", prepared.Branch)
	}
	// The path is under the root the machine chose, and it exists on the machine
	// — which is what makes it usable as a working directory rather than a
	// promise about one.
	if !strings.HasPrefix(prepared.Path, checkoutRoot+string(filepath.Separator)) {
		t.Fatalf("path = %q, want it under %q", prepared.Path, checkoutRoot)
	}
	if info, err := os.Stat(prepared.Path); err != nil || !info.IsDir() {
		t.Fatalf("there is no checkout at %q: %v", prepared.Path, err)
	}

	// Asked again, it is the same directory and not a second copy. A console that
	// double-taps, or a person who starts two sessions on one repository, must
	// not get two of them.
	again := postPrepare(t, h, token, deviceID, repo, "alpha")
	if again.Code != http.StatusOK {
		t.Fatalf("second prepare status %d: %s", again.Code, again.Body.String())
	}
	var second struct {
		Path   string `json:"path"`
		Branch string `json:"branch"`
		Cloned bool   `json:"cloned"`
	}
	if err := json.Unmarshal(again.Body.Bytes(), &second); err != nil {
		t.Fatal(err)
	}
	if second.Cloned {
		t.Fatal("the second prepare fetched it again")
	}
	if second.Path != prepared.Path || second.Branch != "alpha" {
		t.Fatalf("second = %+v, want the checkout that was already there", second)
	}
}

// A name the machine will not turn into a fetch is refused in the machine's own
// words, and the words reach the phone: the Hub is a middleman and does not
// reword what it passes through.
func TestMachineRepoPrepareCarriesTheMachinesOwnRefusal(t *testing.T) {
	h, token, deviceID, _, checkoutRoot := fetchedMachine(t)

	for _, tc := range []struct {
		name string
		repo string
		// says is a word the refusal has to contain, because it is the part that
		// tells a person what to type instead.
		says string
	}{
		{name: "a transport that runs a command", repo: "ext::sh -c whoami", says: "ext"},
		{name: "a bare word", repo: "repo", says: "owner/repo"},
		{name: "nothing", repo: "", says: "repo"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := postPrepare(t, h, token, deviceID, tc.repo, "main")
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status %d, want a refusal: %s", rec.Code, rec.Body.String())
			}
			if !strings.Contains(rec.Body.String(), tc.says) {
				t.Fatalf("refusal %s does not mention %q", rec.Body.String(), tc.says)
			}
		})
	}
	// Nothing was written on the way to being refused. A root that was never even
	// created counts: the question was refused before the machine made room for
	// anything.
	assertNothingFetched(t, checkoutRoot)
}

// assertNothingFetched is the checkout root empty, or never created at all.
func assertNothingFetched(t *testing.T, checkoutRoot string) {
	t.Helper()
	entries, err := os.ReadDir(checkoutRoot)
	if os.IsNotExist(err) {
		return
	}
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("the checkout root holds %v, want nothing", entries)
	}
}

// A machine that has nowhere to put a repository says so, rather than fetching
// into whatever directory it happens to have been started in.
func TestMachineRepoPrepareOnAMachineThatFetchesNothing(t *testing.T) {
	s, master, conns := machinesServer(t)
	hub := httptest.NewServer(s.Handler())
	defer hub.Close()
	deviceToken, deviceID := pairDevice(t, s.Handler(), master)
	root := treeOf(t)
	startResponder(t, hub.URL, deviceToken, root)
	awaitConnected(t, conns, deviceID)

	rec := postPrepare(t, s.Handler(), deviceToken, deviceID, "owner/repo", "main")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d, want a refusal: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "nowhere to fetch") {
		t.Fatalf("the machine did not say why: %s", rec.Body.String())
	}
}

// A checkout is only useful as a working directory, and a working directory
// outside this machine's roots is one its own executor refuses. So the machine
// checks what it is about to hand back, rather than finding out later — by which
// point somebody has paid for a clone to learn it.
func TestMachineRepoPrepareRefusesACheckoutOutsideItsRoots(t *testing.T) {
	s, master, conns := machinesServer(t)
	hub := httptest.NewServer(s.Handler())
	defer hub.Close()
	deviceToken, deviceID := pairDevice(t, s.Handler(), master)

	// A checkout root that was never declared as somewhere this machine works.
	checkoutRoot := filepath.Join(t.TempDir(), "checkouts")
	runResponder(t, hub.URL, deviceToken, &node.Responder{
		Roots:        []string{treeOf(t)},
		CheckoutRoot: checkoutRoot,
	})
	awaitConnected(t, conns, deviceID)

	rec := postPrepare(t, s.Handler(), deviceToken, deviceID, gitOrigin(t), "main")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d, want a refusal: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "not a directory this machine works in") {
		t.Fatalf("the refusal does not name the boundary: %s", rec.Body.String())
	}
}

// The repository questions are about a machine's filesystem and its credentials,
// so they follow the directory listing: the holder's, not a guest's.
func TestMachineRepoQuestionsAreNotForGuests(t *testing.T) {
	s, _, _ := machinesServer(t)
	guestSession(t, s)
	// Each request is one a holder would get an answer to — a refusal, but an
	// answer — so that what a guest is turned away by is the gate and not the
	// question being malformed.
	for _, tc := range []struct {
		name   string
		method string
		target string
		body   string
	}{
		{name: "branches", method: http.MethodGet, target: "/api/machines/self/repo/branches?repo=owner/repo"},
		{name: "prepare", method: http.MethodPost, target: "/api/machines/self/repo/prepare", body: `{"repo":"owner/repo"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, tc.target, strings.NewReader(tc.body))
			req.AddCookie(guestCookie())
			rec := httptest.NewRecorder()
			s.Handler().ServeHTTP(rec, req)
			if rec.Code != http.StatusForbidden {
				t.Fatalf("status %d, want forbidden: %s", rec.Code, rec.Body.String())
			}
		})
	}
}

// A machine that is away is a conflict now, not a timeout later: the person can
// pick another machine instead of watching a spinner.
func TestMachineRepoPrepareRefusesAnOfflineMachine(t *testing.T) {
	s, master, _ := machinesServer(t)
	token, deviceID := pairDevice(t, s.Handler(), master)

	rec := postPrepare(t, s.Handler(), token, deviceID, "owner/repo", "main")
	if rec.Code != http.StatusConflict {
		t.Fatalf("status %d, want a conflict: %s", rec.Code, rec.Body.String())
	}
}

// And a machine this Hub does not know is refused the way a task naming it
// would be.
func TestMachineRepoPrepareRefusesAnUnknownMachine(t *testing.T) {
	s, master, _ := machinesServer(t)
	rec := postPrepare(t, s.Handler(), master, "device-nobody", "owner/repo", "main")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d, want a refusal: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "unknown device") {
		t.Fatalf("the refusal does not name the problem: %s", rec.Body.String())
	}
}
