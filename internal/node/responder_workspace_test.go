package node

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/vuuihc/openkin/internal/remote/worker"
)

// The three questions a console asks a machine about the files of a session
// that runs there.
//
// They exist because the Hub may hold a different checkout of the same
// repository at the same address: reading its own copy would show one session's
// files under another session's name, which is worse than showing nothing. So
// every case below is about which directory this machine agrees to read, and
// about the answer being the same shape the Hub gives for its own.

// changesIn asks one machine what changed in one directory.
func changesIn(t *testing.T, r *Responder, conn *testConn, path string) worker.WorkspaceChangesResult {
	t.Helper()
	result := put(t, r, conn, worker.QueryWorkspaceChanges, worker.WorkspaceChangesParams{Path: path})
	if result.Error != "" {
		t.Fatalf("changes in %s were refused: %s", path, result.Error)
	}
	var found worker.WorkspaceChangesResult
	if err := result.Into(&found); err != nil {
		t.Fatal(err)
	}
	return found
}

func TestWorkspaceChangesAnswersWithWhatChangedInACheckoutUnderTheRoots(t *testing.T) {
	root := t.TempDir()
	repo := gitRepo(t, filepath.Join(root, "repo"))
	r, conn := repoOn(t, root)

	if err := os.WriteFile(filepath.Join(repo, "README"), []byte("changed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "NEW.md"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	found := changesIn(t, r, conn, repo)
	status := map[string]string{}
	for _, change := range found.Changes {
		status[change.Path] = change.Status
	}
	if status["README"] != "modified" {
		t.Errorf("README = %q, want modified (all: %v)", status["README"], status)
	}
	if status["NEW.md"] != "added" {
		t.Errorf("NEW.md = %q, want added (all: %v)", status["NEW.md"], status)
	}
}

// A clean checkout is an answer, not an error and not a missing field: the
// console reads Changes as a list, and a session that has changed nothing yet is
// the normal state of a session.
func TestWorkspaceChangesAnswersACleanCheckoutWithAnEmptyList(t *testing.T) {
	root := t.TempDir()
	repo := gitRepo(t, filepath.Join(root, "repo"))
	r, conn := repoOn(t, root)

	found := changesIn(t, r, conn, repo)
	if len(found.Changes) != 0 {
		t.Fatalf("changes = %v, want none", found.Changes)
	}
	if found.Changes == nil {
		t.Error("changes are null, want an empty list: the console reads this as an array")
	}
}

func TestWorkspaceChangesRefusesADirectoryOutsideTheRoots(t *testing.T) {
	root := t.TempDir()
	outside := gitRepo(t, filepath.Join(t.TempDir(), "elsewhere"))
	r, conn := repoOn(t, root)

	reason := gitRefusal(t, worker.QueryWorkspaceChanges, worker.WorkspaceChangesParams{Path: outside}, r, conn)
	if !strings.Contains(reason, "not a directory this machine works in") {
		t.Errorf("refusal = %q, want the boundary named", reason)
	}
}

// The Hub names a directory, and what it can name is bounded by the same rule a
// dispatched turn is. A traversal is the one shape that would make the answer
// about a directory this machine never agreed to show.
func TestWorkspaceFileRefusesATraversalOutOfTheWorkspace(t *testing.T) {
	root := t.TempDir()
	repo := gitRepo(t, filepath.Join(root, "repo"))
	r, conn := repoOn(t, root)

	reason := gitRefusal(t, worker.QueryWorkspaceFile, worker.WorkspaceFileParams{
		Path: repo,
		File: "../outside.txt",
	}, r, conn)
	if !strings.Contains(reason, "leaves the directory") {
		t.Errorf("refusal = %q, want the traversal named", reason)
	}
}

func TestWorkspaceTreeListsOneLevelAndHidesGitMetadata(t *testing.T) {
	root := t.TempDir()
	repo := gitRepo(t, filepath.Join(root, "repo"))
	if err := os.MkdirAll(filepath.Join(repo, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	r, conn := repoOn(t, root)

	result := put(t, r, conn, worker.QueryWorkspaceTree, worker.WorkspaceTreeParams{Path: repo})
	if result.Error != "" {
		t.Fatalf("tree of %s was refused: %s", repo, result.Error)
	}
	var found worker.WorkspaceTreeResult
	if err := result.Into(&found); err != nil {
		t.Fatal(err)
	}
	names := map[string]string{}
	for _, entry := range found.Entries {
		names[entry.Name] = entry.Type
	}
	if names["src"] != "tree" {
		t.Errorf("src = %q, want tree (all: %v)", names["src"], names)
	}
	if names["README"] != "blob" {
		t.Errorf("README = %q, want blob (all: %v)", names["README"], names)
	}
	if _, ok := names[".git"]; ok {
		t.Errorf(".git is listed: %v", names)
	}
}

func TestWorkspaceTreeListsASubdirectory(t *testing.T) {
	root := t.TempDir()
	repo := gitRepo(t, filepath.Join(root, "repo"))
	if err := os.MkdirAll(filepath.Join(repo, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "src", "main.go"), []byte("package main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	r, conn := repoOn(t, root)

	result := put(t, r, conn, worker.QueryWorkspaceTree, worker.WorkspaceTreeParams{Path: repo, Dir: "src"})
	if result.Error != "" {
		t.Fatalf("tree of %s/src was refused: %s", repo, result.Error)
	}
	var found worker.WorkspaceTreeResult
	if err := result.Into(&found); err != nil {
		t.Fatal(err)
	}
	if len(found.Entries) != 1 || found.Entries[0].Name != "main.go" {
		t.Fatalf("entries = %v, want main.go alone", found.Entries)
	}
}

func TestWorkspaceFileReadsAFileOfTheWorkspace(t *testing.T) {
	root := t.TempDir()
	repo := gitRepo(t, filepath.Join(root, "repo"))
	r, conn := repoOn(t, root)

	result := put(t, r, conn, worker.QueryWorkspaceFile, worker.WorkspaceFileParams{Path: repo, File: "README"})
	if result.Error != "" {
		t.Fatalf("README was refused: %s", result.Error)
	}
	var found worker.WorkspaceFileResult
	if err := result.Into(&found); err != nil {
		t.Fatal(err)
	}
	if found.Content != "hi\n" {
		t.Errorf("content = %q, want %q", found.Content, "hi\n")
	}
	if found.Size != 3 {
		t.Errorf("size = %d, want 3", found.Size)
	}
	if found.Truncated {
		t.Error("a three-byte file came back truncated")
	}
}

// What is not text is refused rather than answered with replacement characters:
// the person reading this is looking at a diff, and a screen of U+FFFD is not
// the file.
func TestWorkspaceFileRefusesAFileThatIsNotText(t *testing.T) {
	root := t.TempDir()
	repo := gitRepo(t, filepath.Join(root, "repo"))
	if err := os.WriteFile(filepath.Join(repo, "blob.bin"), []byte{0x00, 0x01, 0xff, 0xfe}, 0o644); err != nil {
		t.Fatal(err)
	}
	r, conn := repoOn(t, root)

	reason := gitRefusal(t, worker.QueryWorkspaceFile, worker.WorkspaceFileParams{Path: repo, File: "blob.bin"}, r, conn)
	if !strings.Contains(reason, "UTF-8") {
		t.Errorf("refusal = %q, want the reason (not text) named", reason)
	}
}

// A long file is answered with its beginning and a flag, and the flag is not
// decoration: the frame that carries an answer is capped at 1 MiB, and a file
// past the bound has to be cut here rather than lost on the way.
func TestWorkspaceFileTruncatesAFileLongerThanTheAnswerBound(t *testing.T) {
	root := t.TempDir()
	repo := gitRepo(t, filepath.Join(root, "repo"))
	long := strings.Repeat("a", worker.MaxWorkspaceFile+4096)
	if err := os.WriteFile(filepath.Join(repo, "long.txt"), []byte(long), 0o644); err != nil {
		t.Fatal(err)
	}
	r, conn := repoOn(t, root)

	result := put(t, r, conn, worker.QueryWorkspaceFile, worker.WorkspaceFileParams{Path: repo, File: "long.txt"})
	if result.Error != "" {
		t.Fatalf("long.txt was refused: %s", result.Error)
	}
	var found worker.WorkspaceFileResult
	if err := result.Into(&found); err != nil {
		t.Fatal(err)
	}
	if !found.Truncated {
		t.Error("truncated = false, want true")
	}
	if len(found.Content) != worker.MaxWorkspaceFile {
		t.Errorf("content = %d bytes, want the bound %d", len(found.Content), worker.MaxWorkspaceFile)
	}
	if found.Size != int64(len(long)) {
		t.Errorf("size = %d, want the size on disk %d", found.Size, len(long))
	}
}

// The bound has to hold for the worst case, not the average one: a file of
// characters JSON escapes costs six bytes each, so this answer is the one that
// would overflow the frame if MaxWorkspaceFile were chosen by feel. The test
// fails by timing out — an answer too large to become a frame is never sent.
func TestWorkspaceFileAtTheBoundStillFitsInOneFrame(t *testing.T) {
	root := t.TempDir()
	repo := gitRepo(t, filepath.Join(root, "repo"))
	escaped := strings.Repeat("<", worker.MaxWorkspaceFile)
	if err := os.WriteFile(filepath.Join(repo, "escaped.txt"), []byte(escaped), 0o644); err != nil {
		t.Fatal(err)
	}
	r, conn := repoOn(t, root)

	result := put(t, r, conn, worker.QueryWorkspaceFile, worker.WorkspaceFileParams{Path: repo, File: "escaped.txt"})
	if result.Error != "" {
		t.Fatalf("escaped.txt was refused: %s", result.Error)
	}
	var found worker.WorkspaceFileResult
	if err := result.Into(&found); err != nil {
		t.Fatal(err)
	}
	if len(found.Content) != worker.MaxWorkspaceFile {
		t.Errorf("content = %d bytes, want %d", len(found.Content), worker.MaxWorkspaceFile)
	}
}

// A machine with no git has no answers about files in a workspace: it cannot
// tell a checkout from a directory, and the change list is git's answer.
func TestWorkspaceAnswersOnAMachineWithoutGitSaySo(t *testing.T) {
	root := t.TempDir()
	repo := gitRepo(t, filepath.Join(root, "repo"))
	r, conn := responderOn(t, root)

	reason := gitRefusal(t, worker.QueryWorkspaceChanges, worker.WorkspaceChangesParams{Path: repo}, r, conn)
	if !strings.Contains(reason, "no git") {
		t.Errorf("refusal = %q, want the missing git named", reason)
	}
}
