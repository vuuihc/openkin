package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/workspace"
)

// A session that runs in the person's own checkout commits its work as it goes.
// The Changes panel asks what that checkout has that its base branch does not,
// so committed branch work is in the answer; a `git diff HEAD` answer would go
// empty at the first commit while the work sits in the last one.
func TestSourceChangesIncludeCommittedBranchWork(t *testing.T) {
	s, token := newTestServer(t)
	s.Workspace = workspace.NewManager(t.TempDir())

	src := t.TempDir()
	initRepo(t, src)
	gitIn(t, src, "checkout", "-q", "-b", "feature")
	mustWriteFile(t, filepath.Join(src, "committed.txt"), "branch work\n")
	gitIn(t, src, "add", "committed.txt")
	gitIn(t, src, "commit", "-q", "-m", "branch work")
	gitIn(t, src, "branch", "--set-upstream-to=main", "feature")

	const taskID = "task-branch-changes"
	if err := s.Store.InsertTask(context.Background(), store.Task{
		ID: taskID, Title: "Source", Agent: "claude-code", Cwd: src,
		Prompt: "inspect", Status: "succeeded", CreatedAt: 1,
	}); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/tasks/"+taskID+"/source/changes", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
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
	if status["committed.txt"] != "added" {
		t.Fatalf("changes = %v, want the committed branch work", status)
	}
}

// gitIn runs one git command in one test checkout.
func gitIn(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"GIT_TERMINAL_PROMPT=0",
		"GIT_AUTHOR_NAME=Kin Test",
		"GIT_AUTHOR_EMAIL=owner@example.com",
		"GIT_COMMITTER_NAME=Kin Test",
		"GIT_COMMITTER_EMAIL=owner@example.com",
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}
