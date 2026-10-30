package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/workspace"
)

// The console builds every API path with encodeURIComponent, and a generation
// id is `<task>:g<N>` — so the colon reaches the daemon as %3A. The router
// matches on the escaped path, which means the handler sees the escapes too
// and has to resolve them before it asks the store. Every route that takes a
// workspace id was answering "workspace not found" for a workspace that was
// right there, which is why the panel showed nothing for a task with an active
// generation.
func TestWorkspaceRoutesResolveAPercentEncodedID(t *testing.T) {
	s, token := newTestServer(t)
	s.Workspace = workspace.NewManager(t.TempDir())
	h := s.Handler()

	root := t.TempDir()
	mustWriteFile(t, filepath.Join(root, "hello.txt"), "hi")
	taskID := insertWorkspaceTask(t, s.Store, root)
	ws := insertRawGeneration(t, s, taskID, root, nil)
	if !strings.Contains(ws.ID, ":") {
		t.Fatalf("fixture id %q has no colon to encode", ws.ID)
	}
	encodedID := strings.ReplaceAll(ws.ID, ":", "%3A")
	base := "/api/tasks/" + taskID + "/workspaces/" + encodedID

	t.Run("tree", func(t *testing.T) {
		rec := rawGet(t, h, token, base+"/tree?path=.")
		if rec.Code != http.StatusOK {
			t.Fatalf("tree: %d %s", rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), "hello.txt") {
			t.Fatalf("tree did not list the file: %s", rec.Body.String())
		}
	})

	t.Run("file", func(t *testing.T) {
		rec := rawGet(t, h, token, base+"/file?path=hello.txt")
		if rec.Code != http.StatusOK {
			t.Fatalf("file: %d %s", rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), `"content":"hi"`) {
			t.Fatalf("file body: %s", rec.Body.String())
		}
	})

	t.Run("diff", func(t *testing.T) {
		// The live diff runs `git diff HEAD`, so only this route needs a repo.
		// The others are plain file reads, and skipping them on a machine
		// without git would give up coverage they do not need.
		requireGitBin(t)
		gitOutput(t, root, "init", "-q")
		gitOutput(t, root, "config", "user.email", "owner@example.com")
		gitOutput(t, root, "config", "user.name", "owner")
		gitOutput(t, root, "add", ".")
		gitOutput(t, root, "commit", "-q", "-m", "init")
		// One untracked file, so an answer with an empty list cannot pass as
		// the right one: the response has to say what changed, not just 200.
		mustWriteFile(t, filepath.Join(root, "later.txt"), "later")

		rec := rawGet(t, h, token, base+"/diff")
		if rec.Code != http.StatusOK {
			t.Fatalf("diff: %d %s", rec.Code, rec.Body.String())
		}
		var got struct {
			View    string            `json:"view"`
			Changes []json.RawMessage `json:"changes"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatalf("diff body: %v %s", err, rec.Body.String())
		}
		if got.View != "live" || len(got.Changes) != 1 {
			t.Fatalf("diff answered %+v, want the live view with one change", got)
		}
	})

	t.Run("write", func(t *testing.T) {
		body := `{"path":"hello.txt","content":"changed"}`
		req := httptest.NewRequest(http.MethodPut, base+"/file", strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("write: %d %s", rec.Code, rec.Body.String())
		}
	})

	t.Run("another task cannot address it", func(t *testing.T) {
		// Decoding must not weaken the ownership check: the id alone is not
		// enough, the task in the path has to be the one that owns it.
		if err := s.Store.InsertTask(context.Background(), store.Task{
			ID: "task-other", Title: "Other", Agent: "claude-code",
			Cwd: root, Prompt: "inspect", Status: "succeeded", CreatedAt: 1,
		}); err != nil {
			t.Fatal(err)
		}
		rec := rawGet(t, h, token, "/api/tasks/task-other/workspaces/"+encodedID+"/tree?path=.")
		if rec.Code != http.StatusNotFound {
			t.Fatalf("cross-task tree: %d %s", rec.Code, rec.Body.String())
		}
	})
}
