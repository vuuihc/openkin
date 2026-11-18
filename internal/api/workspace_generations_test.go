package api

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"testing"

	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/workspace"
)

// An isolated workspace generation records the commit its worktree forked
// from, and the agent working in it commits its round as it goes. The Changes
// panel asks the live question, so the answer has to carry the committed round:
// a `git diff HEAD` answer would go empty at the agent's first commit while the
// work sits in the last one.
func TestWorkspaceDiffLiveViewKeepsCommittedRoundWork(t *testing.T) {
	requireGitBin(t)
	s, token := newTestServer(t)
	s.Workspace = workspace.NewManager(t.TempDir())

	root := t.TempDir()
	initRepo(t, root)
	baseOID := gitOutput(t, root, "rev-parse", "HEAD")

	taskID := insertWorkspaceTask(t, s.Store, root)
	ws := insertRawGeneration(t, s, taskID, root, func(ws *store.WorkspaceGeneration) {
		ws.BaseOID = baseOID
	})

	// The agent commits a round after the generation exists.
	mustWriteFile(t, filepath.Join(root, "round.txt"), "round\n")
	gitOutput(t, root, "add", "round.txt")
	gitOutput(t, root, "commit", "-q", "-m", "round")

	rec := rawGet(t, s.Handler(), token, "/api/tasks/"+taskID+"/workspaces/"+ws.ID+"/diff")
	if rec.Code != http.StatusOK {
		t.Fatalf("diff: %d %s", rec.Code, rec.Body.String())
	}
	var got genDiffResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("diff body: %v %s", err, rec.Body.String())
	}
	if got.View != "live" {
		t.Fatalf("view = %q, want live for an active generation", got.View)
	}
	status := map[string]string{}
	for _, change := range got.Changes {
		status[change.Path] = change.Status
	}
	if status["round.txt"] != "added" {
		t.Fatalf("changes = %v, want the committed round's file", status)
	}
	if _, ok := status["README"]; ok {
		t.Fatalf("changes = %v, want no file from the commit the generation forked from", status)
	}
}
