package node

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/remote/worker"
)

// responderOn builds a machine whose roots are the directories given, wired to
// a connection a test can read.
func responderOn(t *testing.T, roots ...string) (*Responder, *testConn) {
	t.Helper()
	conn := newTestConn("device-responder-" + t.Name())
	r := &Responder{Roots: roots, Warn: func(format string, args ...any) { t.Logf("node: "+format, args...) }}
	r.SetSender(conn.Send)
	return r, conn
}

// put puts a question to the machine and returns its answer.
//
// Every question gets its own id: answers accumulate on the connection, and one
// that shared an id with an earlier question would be read as that question's
// answer — a test passing on the wrong answer entirely.
func put(t *testing.T, r *Responder, conn *testConn, method string, params any) worker.QueryResult {
	t.Helper()
	raw, err := json.Marshal(params)
	if err != nil {
		t.Fatal(err)
	}
	id := "q-" + strconv.FormatUint(questions.Add(1), 10)
	frame, err := worker.NewFrame("query", worker.Query{ID: id, Method: method, Params: raw})
	if err != nil {
		t.Fatal(err)
	}
	if err := r.Handle(context.Background(), frame); err != nil {
		t.Fatalf("Handle(%s) = %v, want the question taken", method, err)
	}
	return awaitAnswer(t, conn, id)
}

// questions numbers the questions one test process asks.
var questions atomic.Uint64

// awaitAnswer waits for the answer to one question. Answers are sent from the
// goroutine that works them out, so a test cannot read them synchronously.
func awaitAnswer(t *testing.T, conn *testConn, id string) worker.QueryResult {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		for _, frame := range conn.sent() {
			if frame.Kind != "query.result" {
				continue
			}
			result, err := Decode[worker.QueryResult](frame)
			if err != nil {
				t.Fatalf("the machine sent an unreadable answer: %v", err)
			}
			if result.ID == id {
				return result
			}
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("question %s was never answered", id)
	return worker.QueryResult{}
}

// listing asks for a directory and insists on an answer rather than a refusal.
func listing(t *testing.T, r *Responder, conn *testConn, path string) worker.ListDirsResult {
	t.Helper()
	result := put(t, r, conn, worker.QueryListDirs, worker.ListDirsParams{Path: path})
	if result.Error != "" {
		t.Fatalf("listing %s was refused: %s", path, result.Error)
	}
	var listed worker.ListDirsResult
	if err := result.Into(&listed); err != nil {
		t.Fatal(err)
	}
	return listed
}

// refusal asks for a directory and insists the machine said no.
func refusal(t *testing.T, r *Responder, conn *testConn, path string) string {
	t.Helper()
	result := put(t, r, conn, worker.QueryListDirs, worker.ListDirsParams{Path: path})
	if result.Error == "" {
		t.Fatalf("listing %s was answered instead of refused", path)
	}
	return result.Error
}

// tree builds a small filesystem and returns its root.
func tree(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	for _, dir := range []string{"b-kin", "a-notes", "b-kin/sub"} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "README.md"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	return root
}

func TestListDirsAnswersWithTheDirectoriesInsideAPath(t *testing.T) {
	root := tree(t)
	r, conn := responderOn(t, root)

	listed := listing(t, r, conn, root)
	// Directories only, by name: this is how a person picks a working directory,
	// not a file browser.
	if got := strings.Join(listed.Entries, ","); got != "a-notes,b-kin" {
		t.Fatalf("entries = %q, want the two directories in name order", got)
	}
	if listed.Path != root {
		t.Fatalf("path = %q, want %q", listed.Path, root)
	}
	if listed.Truncated {
		t.Fatal("a three-entry directory was reported as truncated")
	}
	// The machine's own roots travel with every answer, so a browser can offer
	// them without a second question.
	if len(listed.Roots) != 1 || listed.Roots[0] != root {
		t.Fatalf("roots = %v, want the machine's own declaration", listed.Roots)
	}

	// Nested: the parent is what "up" means from here.
	nested := listing(t, r, conn, filepath.Join(root, "b-kin"))
	if nested.Parent != root {
		t.Fatalf("parent = %q, want %q", nested.Parent, root)
	}
	if got := strings.Join(nested.Entries, ","); got != "sub" {
		t.Fatalf("nested entries = %q", got)
	}
}

// At a root there is no "up": the boundary is where this machine's declaration
// ends, and a browser that could walk past it would be browsing the machine
// rather than the directories it agreed to work in.
func TestListDirsStopsAtTheRoot(t *testing.T) {
	root := tree(t)
	r, conn := responderOn(t, root)

	if listed := listing(t, r, conn, root); listed.Parent != "" {
		t.Fatalf("parent at the root = %q, want none", listed.Parent)
	}
	if listed := listing(t, r, conn, filepath.Join(root, "b-kin")); listed.Parent != root {
		t.Fatalf("parent inside the root = %q, want %q", listed.Parent, root)
	}
}

// An empty path is not a directory listing: it is the question "where may I
// look at all", and the answer is the machine's own declaration.
func TestListDirsWithNoPathAnswersWithTheRoots(t *testing.T) {
	root := tree(t)
	other := t.TempDir()
	r, conn := responderOn(t, root, other)

	listed := listing(t, r, conn, "")
	if len(listed.Roots) != 2 || listed.Roots[0] != root || listed.Roots[1] != other {
		t.Fatalf("roots = %v", listed.Roots)
	}
	if len(listed.Entries) != 0 || listed.Path != "" {
		t.Fatalf("an empty path listed something: %+v", listed)
	}
}

// The Hub is another party and cannot be trusted to bound itself (see
// Executor.Roots): every question about the filesystem is checked here, on the
// machine that owns it.
func TestListDirsRefusesAPathOutsideTheRoots(t *testing.T) {
	root := tree(t)
	outside := t.TempDir()
	r, conn := responderOn(t, root)

	for _, path := range []string{
		outside,
		filepath.Join(root, ".."),
		"/",
		filepath.Join(root, "b-kin", "..", ".."),
	} {
		said := refusal(t, r, conn, path)
		if !strings.Contains(said, "not a directory this machine works in") {
			t.Fatalf("refusing %s: %q, want it to say where the boundary is", path, said)
		}
	}
}

// A symlink checked into a repository can point anywhere. Containment is
// decided on the real path, or every prefix check would say yes while the
// machine served a directory outside its own declaration.
func TestListDirsRefusesASymlinkThatLeavesTheRoots(t *testing.T) {
	root := tree(t)
	outside := t.TempDir()
	if err := os.MkdirAll(filepath.Join(outside, "secret"), 0o755); err != nil {
		t.Fatal(err)
	}
	escape := filepath.Join(root, "escape")
	if err := os.Symlink(outside, escape); err != nil {
		t.Skipf("symlinks unavailable here: %v", err)
	}
	// A link that stays inside is a directory like any other.
	if err := os.Symlink(filepath.Join(root, "b-kin"), filepath.Join(root, "link-in")); err != nil {
		t.Fatal(err)
	}
	r, conn := responderOn(t, root)

	if said := refusal(t, r, conn, filepath.Join(escape, "secret")); !strings.Contains(said, "works in") {
		t.Fatalf("a path through a symlink out of the root was not refused: %q", said)
	}
	// It is not offered as something to walk into either: names a person can tap
	// and then be refused are worse than names that were never there.
	if listed := listing(t, r, conn, root); strings.Contains(strings.Join(listed.Entries, ","), "escape") {
		t.Fatalf("entries = %v, want the escaping link left out", listed.Entries)
	}
	if listed := listing(t, r, conn, filepath.Join(root, "link-in")); len(listed.Entries) != 1 || listed.Entries[0] != "sub" {
		t.Fatalf("a link that stays inside the root was not followed: %+v", listed)
	}
}

func TestListDirsRefusesWhatIsNotADirectory(t *testing.T) {
	root := tree(t)
	r, conn := responderOn(t, root)

	for _, path := range []string{filepath.Join(root, "README.md"), filepath.Join(root, "gone")} {
		if said := refusal(t, r, conn, path); said == "" {
			t.Fatalf("%s was not refused", path)
		}
	}
}

// A machine with no roots declared works nowhere, and the answer says so rather
// than listing the whole filesystem: an empty declaration must not read as
// "anywhere" (same rule as Executor.allowedCwd).
func TestListDirsOnAMachineWithNoRoots(t *testing.T) {
	r, conn := responderOn(t)
	listed := listing(t, r, conn, "")
	if len(listed.Roots) != 0 || len(listed.Entries) != 0 {
		t.Fatalf("a machine with no roots listed %+v", listed)
	}
	if said := refusal(t, r, conn, t.TempDir()); said == "" {
		t.Fatal("a machine with no roots listed a directory")
	}
}

func TestListDirsStopsAtTheCap(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < worker.MaxDirEntries+7; i++ {
		if err := os.Mkdir(filepath.Join(root, fmt.Sprintf("d-%04d", i)), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	r, conn := responderOn(t, root)

	listed := listing(t, r, conn, root)
	if len(listed.Entries) != worker.MaxDirEntries {
		t.Fatalf("entries = %d, want the cap of %d", len(listed.Entries), worker.MaxDirEntries)
	}
	if !listed.Truncated {
		t.Fatal("a listing cut at the cap did not say so")
	}
}

// A question this machine does not know is answered, not dropped: silence is
// indistinguishable from a question that never arrived, and the Hub would wait
// for it until its timeout.
func TestResponderAnswersAQuestionItDoesNotKnow(t *testing.T) {
	r, conn := responderOn(t, tree(t))
	result := put(t, r, conn, "fs.teleport", map[string]string{})
	if result.Error == "" {
		t.Fatal("an unknown method produced no answer")
	}
	if !strings.Contains(result.Error, "fs.teleport") {
		t.Fatalf("the answer = %q, want it to name the question", result.Error)
	}
}

// Ask runs on the connection's read loop, and a listing is a walk over a
// directory that may be huge or slow. A question that blocked the loop would
// stop the machine hearing anything else — including a cancel for a turn it is
// running.
func TestResponderDoesNotHoldTheReadLoop(t *testing.T) {
	root := tree(t)
	r, conn := responderOn(t, root)

	release := make(chan struct{})
	original := readDirs
	readDirs = func(path string) ([]string, bool, error) {
		<-release
		return original(path)
	}
	t.Cleanup(func() { readDirs = original })

	frame, err := worker.NewFrame("query", worker.Query{
		ID: "q-slow", Method: worker.QueryListDirs,
		Params: json.RawMessage(`{"path":` + strconv.Quote(root) + `}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- r.Handle(context.Background(), frame) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Handle = %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Handle waited for the filesystem instead of answering in the background")
	}

	// And the answer still arrives once the walk finishes.
	close(release)
	if result := awaitAnswer(t, conn, "q-slow"); result.Error != "" {
		t.Fatalf("the slow listing failed: %s", result.Error)
	}
}

// A machine whose connection ended mid-question has nowhere to put the answer.
// That is a warning, not a failure of the question: the Hub has already given
// up on it (Queries.Abandon).
func TestResponderWarnsWhenTheAnswerCannotBeSent(t *testing.T) {
	root := tree(t)
	var warned []string
	conn := newTestConn("device-unreachable")
	conn.sendErr = errors.New("the socket is gone")
	r := &Responder{Roots: []string{root}, Warn: func(format string, args ...any) {
		warned = append(warned, fmt.Sprintf(format, args...))
	}}
	r.SetSender(conn.Send)

	frame, err := worker.NewFrame("query", worker.Query{
		ID: "q-1", Method: worker.QueryListDirs,
		Params: json.RawMessage(`{"path":` + strconv.Quote(root) + `}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := r.Handle(context.Background(), frame); err != nil {
		t.Fatalf("Handle = %v, want the question taken", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && len(warned) == 0 {
		time.Sleep(time.Millisecond)
	}
	if len(warned) == 0 {
		t.Fatal("an answer that could not be sent was not reported")
	}
}
