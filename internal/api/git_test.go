package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/vuuihc/kin/internal/workspace"
)

func requireGitBin(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
}

func initRepo(t *testing.T, dir string) {
	t.Helper()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(),
			"GIT_TERMINAL_PROMPT=0",
			"GIT_AUTHOR_NAME=Kin Test",
			"GIT_AUTHOR_EMAIL=kin@test",
			"GIT_COMMITTER_NAME=Kin Test",
			"GIT_COMMITTER_EMAIL=kin@test",
		)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run("init", "-b", "main")
	run("config", "user.email", "kin@test")
	run("config", "user.name", "Kin Test")
	if err := os.WriteFile(filepath.Join(dir, "README"), []byte("hi\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", "README")
	run("commit", "-m", "init")
	run("branch", "dev")
}

func TestGitBranchesAPI(t *testing.T) {
	requireGitBin(t)
	s, token := newTestServer(t)
	s.Workspace = workspace.NewManager(t.TempDir())
	h := s.Handler()

	dir := t.TempDir()
	initRepo(t, dir)

	// Missing cwd → 400
	req := httptest.NewRequest(http.MethodGet, "/api/git/branches", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("missing cwd: %d %s", rr.Code, rr.Body.String())
	}

	// Happy path
	req = httptest.NewRequest(http.MethodGet, "/api/git/branches?cwd="+dir, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("branches: %d %s", rr.Code, rr.Body.String())
	}
	var st workspace.BranchStatus
	if err := json.Unmarshal(rr.Body.Bytes(), &st); err != nil {
		t.Fatal(err)
	}
	if !st.IsGit || st.Current != "main" {
		t.Fatalf("status=%+v", st)
	}
	if len(st.Branches) < 2 {
		t.Fatalf("branches=%v", st.Branches)
	}
}

func TestGitCheckoutAPI(t *testing.T) {
	requireGitBin(t)
	s, token := newTestServer(t)
	s.Workspace = workspace.NewManager(t.TempDir())
	h := s.Handler()

	dir := t.TempDir()
	initRepo(t, dir)

	body, _ := json.Marshal(map[string]string{"cwd": dir, "branch": "dev"})
	req := httptest.NewRequest(http.MethodPost, "/api/git/checkout", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("checkout: %d %s", rr.Code, rr.Body.String())
	}
	var resp gitCheckoutResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Current != "dev" {
		t.Fatalf("current=%q", resp.Current)
	}

	// Dirty → 409
	if err := os.WriteFile(filepath.Join(dir, "README"), []byte("dirty\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	body, _ = json.Marshal(map[string]string{"cwd": dir, "branch": "main"})
	req = httptest.NewRequest(http.MethodPost, "/api/git/checkout", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusConflict {
		t.Fatalf("dirty checkout: %d %s", rr.Code, rr.Body.String())
	}
}

func TestGitBranchesUnavailableWithoutWorkspace(t *testing.T) {
	s, token := newTestServer(t)
	// Workspace left nil
	h := s.Handler()
	req := httptest.NewRequest(http.MethodGet, "/api/git/branches?cwd=/tmp", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("want 503, got %d %s", rr.Code, rr.Body.String())
	}
}
