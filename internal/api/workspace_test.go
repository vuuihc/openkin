package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/vuuihc/kin/internal/store"
)

func TestTaskWorkspaceList(t *testing.T) {
	s, token := newTestServer(t)
	h := s.Handler()

	root := t.TempDir()
	mustWriteFile(t, filepath.Join(root, "a.txt"), "alpha")
	mustWriteFile(t, filepath.Join(root, "B.txt"), "bravo")
	mustWriteFile(t, filepath.Join(root, "dir", "nested.txt"), "nested")
	outside := filepath.Join(t.TempDir(), "outside.txt")
	mustWriteFile(t, outside, "outside")
	if err := os.Symlink(outside, filepath.Join(root, "escape-link")); err != nil {
		t.Fatal(err)
	}

	taskID := insertWorkspaceTask(t, s.Store, root)

	req := httptest.NewRequest(http.MethodGet, "/api/tasks/"+taskID+"/workspace/list", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("list root: %d %s", rr.Code, rr.Body.String())
	}

	var got workspaceListResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Path != "." {
		t.Fatalf("root path = %q", got.Path)
	}
	if got.Truncated {
		t.Fatal("unexpected truncation")
	}
	if len(got.Entries) != 3 {
		t.Fatalf("entries=%d body=%s", len(got.Entries), rr.Body.String())
	}
	if got.Entries[0].Name != "dir" || got.Entries[0].Type != "dir" {
		t.Fatalf("first entry = %+v", got.Entries[0])
	}
	if got.Entries[1].Name != "a.txt" || got.Entries[1].Type != "file" {
		t.Fatalf("second entry = %+v", got.Entries[1])
	}
	if got.Entries[2].Name != "B.txt" || got.Entries[2].Type != "file" {
		t.Fatalf("third entry = %+v", got.Entries[2])
	}
}

func TestTaskWorkspaceListTruncated(t *testing.T) {
	s, token := newTestServer(t)
	h := s.Handler()

	root := t.TempDir()
	for i := 0; i < workspaceListLimit+5; i++ {
		mustWriteFile(t, filepath.Join(root, fmt.Sprintf("file-%03d.txt", i)), "x")
	}
	taskID := insertWorkspaceTask(t, s.Store, root)

	req := httptest.NewRequest(http.MethodGet, "/api/tasks/"+taskID+"/workspace/list", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("list truncated: %d %s", rr.Code, rr.Body.String())
	}

	var got workspaceListResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if !got.Truncated {
		t.Fatal("expected truncated=true")
	}
	if len(got.Entries) != workspaceListLimit {
		t.Fatalf("entries=%d want=%d", len(got.Entries), workspaceListLimit)
	}
}

func TestTaskWorkspaceListRejectsEscape(t *testing.T) {
	s, token := newTestServer(t)
	h := s.Handler()

	root := t.TempDir()
	taskID := insertWorkspaceTask(t, s.Store, root)

	req := httptest.NewRequest(http.MethodGet, "/api/tasks/"+taskID+"/workspace/list?path=../..", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("escape: %d %s", rr.Code, rr.Body.String())
	}
}

func TestTaskWorkspaceListStatusCodes(t *testing.T) {
	s, token := newTestServer(t)
	h := s.Handler()

	root := t.TempDir()
	mustWriteFile(t, filepath.Join(root, "file.txt"), "hi")
	taskID := insertWorkspaceTask(t, s.Store, root)

	tests := []struct {
		name   string
		path   string
		status int
	}{
		{name: "missing", path: "does-not-exist", status: http.StatusNotFound},
		{name: "not-a-directory", path: "file.txt", status: http.StatusBadRequest},
		{name: "escape", path: "../..", status: http.StatusBadRequest},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/tasks/"+taskID+"/workspace/list?path="+tc.path, nil)
			req.Header.Set("Authorization", "Bearer "+token)
			rr := httptest.NewRecorder()
			h.ServeHTTP(rr, req)
			if rr.Code != tc.status {
				t.Fatalf("status=%d want=%d body=%s", rr.Code, tc.status, rr.Body.String())
			}
		})
	}
}

func TestTaskWorkspaceReadFileStatusCodes(t *testing.T) {
	s, token := newTestServer(t)
	h := s.Handler()

	root := t.TempDir()
	mustWriteFile(t, filepath.Join(root, "dir", "nested.txt"), "nested")
	taskID := insertWorkspaceTask(t, s.Store, root)

	tests := []struct {
		name   string
		path   string
		status int
	}{
		{name: "missing", path: "nope.txt", status: http.StatusNotFound},
		{name: "is-directory", path: "dir", status: http.StatusBadRequest},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/tasks/"+taskID+"/workspace/file?path="+tc.path, nil)
			req.Header.Set("Authorization", "Bearer "+token)
			rr := httptest.NewRecorder()
			h.ServeHTTP(rr, req)
			if rr.Code != tc.status {
				t.Fatalf("status=%d want=%d body=%s", rr.Code, tc.status, rr.Body.String())
			}
		})
	}
}

func TestTaskWorkspaceReadFile(t *testing.T) {
	s, token := newTestServer(t)
	h := s.Handler()

	root := t.TempDir()
	want := "package main\n\nfunc main() {}\n"
	mustWriteFile(t, filepath.Join(root, "main.go"), want)
	taskID := insertWorkspaceTask(t, s.Store, root)

	req := httptest.NewRequest(http.MethodGet, "/api/tasks/"+taskID+"/workspace/file?path=main.go", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("read: %d %s", rr.Code, rr.Body.String())
	}

	var got workspaceFileResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Path != "main.go" || got.Content != want || got.Truncated {
		t.Fatalf("got=%+v", got)
	}
}

func TestTaskWorkspaceReadRejectsBinaryEscapeAndLargeFiles(t *testing.T) {
	s, token := newTestServer(t)
	h := s.Handler()

	root := t.TempDir()
	mustWriteBytes(t, filepath.Join(root, "bin.dat"), []byte("hi\x00there"))
	mustWriteFile(t, filepath.Join(root, "huge.txt"), strings.Repeat("a", workspaceReadHardLimit+1))
	mustWriteFile(t, filepath.Join(root, "truncated.txt"), strings.Repeat("z", workspaceReadSoftLimit+1024))
	taskID := insertWorkspaceTask(t, s.Store, root)

	tests := []struct {
		name   string
		path   string
		status int
		check  func(t *testing.T, rr *httptest.ResponseRecorder)
	}{
		{
			name:   "binary",
			path:   "bin.dat",
			status: http.StatusBadRequest,
			check: func(t *testing.T, rr *httptest.ResponseRecorder) {
				if !strings.Contains(rr.Body.String(), "binary file") {
					t.Fatalf("body=%s", rr.Body.String())
				}
			},
		},
		{
			name:   "escape",
			path:   "../bin.dat",
			status: http.StatusBadRequest,
			check:  func(*testing.T, *httptest.ResponseRecorder) {},
		},
		{
			name:   "large",
			path:   "huge.txt",
			status: http.StatusRequestEntityTooLarge,
			check: func(t *testing.T, rr *httptest.ResponseRecorder) {
				if !strings.Contains(rr.Body.String(), "file too large") {
					t.Fatalf("body=%s", rr.Body.String())
				}
			},
		},
		{
			name:   "truncated",
			path:   "truncated.txt",
			status: http.StatusOK,
			check: func(t *testing.T, rr *httptest.ResponseRecorder) {
				var got workspaceFileResponse
				if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
					t.Fatal(err)
				}
				if !got.Truncated || len(got.Content) != workspaceReadSoftLimit {
					t.Fatalf("got truncated=%v len=%d", got.Truncated, len(got.Content))
				}
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/tasks/"+taskID+"/workspace/file?path="+tc.path, nil)
			req.Header.Set("Authorization", "Bearer "+token)
			rr := httptest.NewRecorder()
			h.ServeHTTP(rr, req)
			if rr.Code != tc.status {
				t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
			}
			tc.check(t, rr)
		})
	}
}

func insertWorkspaceTask(t *testing.T, st *store.Store, cwd string) string {
	t.Helper()
	const id = "task-workspace"
	err := st.InsertTask(context.Background(), store.Task{
		ID:        id,
		Title:     "Workspace",
		Agent:     "claude-code",
		Cwd:       cwd,
		Prompt:    "inspect",
		Status:    "succeeded",
		CreatedAt: 1,
		TokensIn:  0,
		TokensOut: 0,
	})
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func mustWriteFile(t *testing.T, name, content string) {
	t.Helper()
	mustWriteBytes(t, name, []byte(content))
}

func mustWriteBytes(t *testing.T, name string, content []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(name), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(name, content, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestTaskWorkspaceUsesEffectiveCwd(t *testing.T) {
	src := t.TempDir()
	execDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(src, "source.txt"), []byte("src\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(execDir, "isolated.txt"), []byte("iso\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	s, token := newTestServer(t)
	ctx := context.Background()
	task := store.Task{
		ID: "01WSEFFECTIVE0000000000001", Title: "ws", Agent: "claude-code",
		Cwd: src, Prompt: "p", Status: "succeeded", CreatedAt: store.NowMilli(),
		WorkspaceMode: "worktree", ExecutionCwd: execDir, WorkspaceRoot: execDir,
	}
	if err := s.Store.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/tasks/"+task.ID+"/workspace/list?path=.", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("list status=%d body=%s", rec.Code, rec.Body.String())
	}
	var listResp struct {
		Root    string `json:"root"`
		Entries []struct {
			Name string `json:"name"`
		} `json:"entries"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&listResp); err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, e := range listResp.Entries {
		names[e.Name] = true
	}
	if !names["isolated.txt"] {
		t.Fatalf("entries=%v want isolated.txt; root=%q", names, listResp.Root)
	}
	if names["source.txt"] {
		t.Fatalf("should not list source.txt: %v", names)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/tasks/"+task.ID+"/workspace/file?path=isolated.txt", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec = httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("read isolated status=%d %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/tasks/"+task.ID+"/workspace/file?path=source.txt", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec = httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("read source status=%d want 404", rec.Code)
	}

	task2 := store.Task{
		ID: "01WSHISTORICAL000000000001", Title: "h", Agent: "claude-code",
		Cwd: src, Prompt: "p", Status: "succeeded", CreatedAt: store.NowMilli(),
	}
	if err := s.Store.InsertTask(ctx, task2); err != nil {
		t.Fatal(err)
	}
	req = httptest.NewRequest(http.MethodGet, "/api/tasks/"+task2.ID+"/workspace/file?path=source.txt", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec = httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("historical read status=%d %s", rec.Code, rec.Body.String())
	}
}
