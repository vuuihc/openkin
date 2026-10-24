package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/vuuihc/openkin/internal/node"
	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/workspace"
)

// Reading a workspace that lives on another machine.
//
// A phone starts a session on a machine, and that session's files are on that
// machine. These routes used to answer 409 — true, and a dead end — and now ask
// the machine over the channel it dialled in on.
//
// Both filesystems are this one test process, which is what makes the cases
// below worth writing: the wrong answer is available, it is plausible, and it
// comes from a directory that really exists at the same path. So the tests put a
// decoy checkout at the address in the task row and assert which one answered.
// The address itself is not the row's: a task carries a workspace anchor, and
// the path that means anything is the one it resolves to on that machine.

// remoteWorkspaceHub is a Hub with one paired machine that answers questions
// about the directories given and has git there. The first root is the one its
// workspace manager is built on, the same wiring `kin serve` uses.
func remoteWorkspaceHub(t *testing.T, roots ...string) (*Server, http.Handler, string, string) {
	t.Helper()
	s, master, conns := machinesServer(t)
	h := s.Handler()
	hub := httptest.NewServer(h)
	t.Cleanup(hub.Close)

	deviceToken, deviceID := pairDevice(t, h, master)
	responder := &node.Responder{Roots: roots}
	responder.Workspace = workspace.NewManager(roots[0])
	runResponder(t, hub.URL, deviceToken, responder)
	awaitConnected(t, conns, deviceID)
	return s, h, master, deviceID
}

// remoteTask inserts a task that runs on one machine. cwd is the path in the
// row, which belongs to whichever machine made the row; anchorID, when set, is
// what the row's workspace actually is on the machine that runs it.
func remoteTask(t *testing.T, s *Server, deviceID, cwd, anchorID string) store.Task {
	t.Helper()
	task := store.Task{
		ID:    "task-remote-" + strings.ReplaceAll(t.Name(), "/", "-"),
		Title: "Remote", Agent: "claude-code", Cwd: cwd,
		Prompt: "inspect", Status: "succeeded", CreatedAt: 1,
		ExecutingDeviceID: deviceID, WorkspaceAnchorID: anchorID,
	}
	if err := s.Store.InsertTask(context.Background(), task); err != nil {
		t.Fatal(err)
	}
	return task
}

// anchoredAt records where a workspace is on one machine, the way a machine
// reporting its checkouts does.
func anchoredAt(t *testing.T, s *Server, deviceID, path string) string {
	t.Helper()
	anchor, err := s.Store.EnsureDeviceAnchor(context.Background(), deviceID, path, 1)
	if err != nil {
		t.Fatal(err)
	}
	return anchor.ID
}

// getTaskRoute asks one task route of the Hub.
func getTaskRoute(t *testing.T, h http.Handler, token, taskID, suffix string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/tasks/"+taskID+suffix, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// checkout is a git checkout at a fresh path under this test's temporary
// directory.
func checkout(t *testing.T, name string) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	initRepo(t, dir)
	return dir
}

// twoCheckouts is the situation this whole file is about: the same workspace on
// two machines, with different contents in it. It returns the path on the
// machine that runs the task, and a path here that holds something else.
func twoCheckouts(t *testing.T) (onTheMachine, here string) {
	t.Helper()
	return checkout(t, "work"), checkout(t, "work")
}

func write(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func entryNames(t *testing.T, rec *httptest.ResponseRecorder) map[string]bool {
	t.Helper()
	var got genTreeResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, entry := range got.Entries {
		names[entry.Name] = true
	}
	return names
}

func TestSourceTreeIsAskedOfTheMachineThatHasTheFiles(t *testing.T) {
	work, here := twoCheckouts(t)
	write(t, work, "on-the-machine.txt", "node\n")
	write(t, here, "here-at-the-same-address.txt", "hub\n")

	s, h, master, deviceID := remoteWorkspaceHub(t, filepath.Dir(work))
	task := remoteTask(t, s, deviceID, here, anchoredAt(t, s, deviceID, work))

	rec := getTaskRoute(t, h, master, task.ID, "/source/tree")
	if rec.Code != http.StatusOK {
		t.Fatalf("source tree: %d %s", rec.Code, rec.Body.String())
	}
	names := entryNames(t, rec)
	if !names["on-the-machine.txt"] {
		t.Errorf("entries = %v, want the machine's own file", names)
	}
	if names["here-at-the-same-address.txt"] {
		t.Errorf("entries = %v, want nothing from this Hub's checkout at the task's own path", names)
	}
}

func TestSourceFileIsReadFromTheMachineThatHasIt(t *testing.T) {
	work, here := twoCheckouts(t)
	write(t, work, "note.txt", "node\n")
	write(t, here, "note.txt", "hub\n")

	s, h, master, deviceID := remoteWorkspaceHub(t, filepath.Dir(work))
	task := remoteTask(t, s, deviceID, here, anchoredAt(t, s, deviceID, work))

	rec := getTaskRoute(t, h, master, task.ID, "/source/file?path=note.txt")
	if rec.Code != http.StatusOK {
		t.Fatalf("source file: %d %s", rec.Code, rec.Body.String())
	}
	var got genFileResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Content != "node\n" {
		t.Errorf("content = %q, want the machine's copy", got.Content)
	}
	if got.Size != int64(len("node\n")) {
		t.Errorf("size = %d, want the size of what came back", got.Size)
	}
}

// The change list is the one the console's source view has never had for a task
// like this: a task with no isolated workspace has no generation to diff, and
// the panel fell back to what the agent's tool calls happened to mention.
func TestSourceChangesAreAskedOfTheMachineThatHasTheFiles(t *testing.T) {
	work, here := twoCheckouts(t)
	write(t, work, "added-on-the-machine.txt", "node\n")
	write(t, work, "README", "edited on the machine\n")
	write(t, here, "only-here.txt", "hub\n")

	s, h, master, deviceID := remoteWorkspaceHub(t, filepath.Dir(work))
	task := remoteTask(t, s, deviceID, here, anchoredAt(t, s, deviceID, work))

	rec := getTaskRoute(t, h, master, task.ID, "/source/changes")
	if rec.Code != http.StatusOK {
		t.Fatalf("source changes: %d %s", rec.Code, rec.Body.String())
	}
	var got genDiffResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	status := map[string]string{}
	for _, change := range got.Changes {
		status[change.Path] = change.Status
	}
	if status["added-on-the-machine.txt"] != "added" {
		t.Errorf("added-on-the-machine.txt = %q, want added (all: %v)", status["added-on-the-machine.txt"], status)
	}
	if status["README"] != "modified" {
		t.Errorf("README = %q, want modified (all: %v)", status["README"], status)
	}
	if _, ok := status["only-here.txt"]; ok {
		t.Errorf("this Hub's own change is in the answer: %v", status)
	}
}

// A machine that is away is a machine that is away: the console says so, and the
// Hub does not quietly answer from the directory it has at the same address.
func TestSourceReadsOnAMachineThatIsAwaySaySo(t *testing.T) {
	s, master, _ := machinesServer(t)
	_, deviceID := pairDevice(t, s.Handler(), master)

	// A directory that exists here and is a checkout: the read would succeed if
	// it were answered from this machine, which is the mistake being guarded.
	work := checkout(t, "work")

	task := remoteTask(t, s, deviceID, work, "")

	rec := getTaskRoute(t, s.Handler(), master, task.ID, "/source/tree")
	if rec.Code != http.StatusConflict {
		t.Fatalf("source tree of a machine that is away: %d %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "not connected") {
		t.Errorf("error = %s, want the machine named as away", rec.Body.String())
	}
}

// The machine's own refusal is what the user reads — it is the party that knows
// where its boundary is, and a Hub that rephrased it would be guessing.
func TestSourceReadsCarryTheMachinesOwnRefusal(t *testing.T) {
	s, h, master, deviceID := remoteWorkspaceHub(t, t.TempDir())

	// A checkout this Hub has and that machine does not work in.
	outside := checkout(t, "work")

	task := remoteTask(t, s, deviceID, outside, "")

	rec := getTaskRoute(t, h, master, task.ID, "/source/tree")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("source tree outside the machine's roots: %d %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "works in") {
		t.Errorf("error = %s, want the machine's own words", rec.Body.String())
	}
}

// The legacy workspace browser reads a different envelope for the same answer,
// down to a different word for a directory.
func TestWorkspaceListAnswersInTheBrowserShape(t *testing.T) {
	work, here := twoCheckouts(t)
	if err := os.MkdirAll(filepath.Join(work, "src"), 0o755); err != nil {
		t.Fatal(err)
	}

	s, h, master, deviceID := remoteWorkspaceHub(t, filepath.Dir(work))
	task := remoteTask(t, s, deviceID, here, anchoredAt(t, s, deviceID, work))

	rec := getTaskRoute(t, h, master, task.ID, "/workspace/list?path=.")
	if rec.Code != http.StatusOK {
		t.Fatalf("workspace list: %d %s", rec.Code, rec.Body.String())
	}
	var got workspaceListResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	types := map[string]string{}
	paths := map[string]string{}
	for _, entry := range got.Entries {
		types[entry.Name] = entry.Type
		paths[entry.Name] = entry.Path
	}
	if types["README"] != "file" {
		t.Errorf("README = %q, want file (all: %v)", types["README"], types)
	}
	if types[".git"] != "" {
		t.Errorf("git metadata is in the listing: %v", types)
	}

	// Entries carry a path, and it is one join away from the directory that was
	// listed: the machine answers with a listing, not with paths.
	if paths["README"] != "README" {
		t.Errorf("README path = %q, want README (all: %v)", paths["README"], paths)
	}
	if types["src"] != "dir" {
		t.Errorf("src = %q, want dir (all: %v)", types["src"], types)
	}

	// An empty directory lists as nothing, not as an error.
	sub := getTaskRoute(t, h, master, task.ID, "/workspace/list?path=src")
	if sub.Code != http.StatusOK {
		t.Fatalf("workspace list of an empty directory: %d %s", sub.Code, sub.Body.String())
	}
	var inSrc workspaceListResponse
	if err := json.Unmarshal(sub.Body.Bytes(), &inSrc); err != nil {
		t.Fatal(err)
	}
	if inSrc.Path != "src" || len(inSrc.Entries) != 0 {
		t.Errorf("src: path = %q entries = %v, want the directory with nothing in it", inSrc.Path, inSrc.Entries)
	}
}

// A task that runs here is still read here. The question path is for files this
// machine does not have.
func TestSourceReadsForALocalTaskStillReadThisMachine(t *testing.T) {
	s, master, _ := machinesServer(t)
	work := checkout(t, "work")
	write(t, work, "here.txt", "hub\n")
	s.Workspace = workspace.NewManager(t.TempDir())

	if err := s.Store.InsertTask(context.Background(), store.Task{
		ID: "task-local", Title: "Local", Agent: "claude-code", Cwd: work,
		Prompt: "inspect", Status: "succeeded", CreatedAt: 1,
	}); err != nil {
		t.Fatal(err)
	}

	rec := getTaskRoute(t, s.Handler(), master, "task-local", "/source/tree")
	if rec.Code != http.StatusOK {
		t.Fatalf("source tree: %d %s", rec.Code, rec.Body.String())
	}
	if !entryNames(t, rec)["here.txt"] {
		t.Errorf("entries = %s, want this machine's directory", rec.Body.String())
	}
}
