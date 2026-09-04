package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/workspace"
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

func TestWriteActiveWorkspaceGenerationFile(t *testing.T) {
	s, token := newTestServer(t)
	s.Workspace = workspace.NewManager(t.TempDir())
	root := t.TempDir()
	mustWriteFile(t, filepath.Join(root, "main.go"), "package main\n")
	taskID := insertWorkspaceTask(t, s.Store, root)
	ws := store.WorkspaceGeneration{
		ID: taskID + ":g1", TaskID: taskID, Generation: 1,
		State: store.WorkspaceActive, SourceRoot: root, Scope: ".",
		PhysicalRoot: root, ExecutionCwd: root,
		CreatedAt: store.NowMilli(), UpdatedAt: store.NowMilli(),
	}
	if _, err := s.Store.InsertWorkspaceAsCurrent(context.Background(), ws); err != nil {
		t.Fatal(err)
	}
	body := `{"path":"main.go","content":"package edited\n"}`
	req := httptest.NewRequest(
		http.MethodPut,
		"/api/tasks/"+taskID+"/workspaces/"+ws.ID+"/file",
		strings.NewReader(body),
	)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("write status=%d body=%s", rec.Code, rec.Body.String())
	}
	data, err := os.ReadFile(filepath.Join(root, "main.go"))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "package edited\n" {
		t.Fatalf("content=%q", data)
	}
}

func TestWriteWorkspaceGenerationRejectsOversizedBody(t *testing.T) {
	s, token := newTestServer(t)
	s.Workspace = workspace.NewManager(t.TempDir())
	root := t.TempDir()
	path := filepath.Join(root, "main.go")
	mustWriteFile(t, path, "package main\n")
	taskID := insertWorkspaceTask(t, s.Store, root)
	ws := store.WorkspaceGeneration{
		ID: taskID + ":oversized", TaskID: taskID, Generation: 1,
		State: store.WorkspaceActive, SourceRoot: root, Scope: ".",
		PhysicalRoot: root, ExecutionCwd: root,
		CreatedAt: store.NowMilli(), UpdatedAt: store.NowMilli(),
	}
	if _, err := s.Store.InsertWorkspaceAsCurrent(context.Background(), ws); err != nil {
		t.Fatal(err)
	}
	body := `{"path":"main.go","content":"` +
		strings.Repeat("x", 2*workspaceWriteBodyLimit) +
		`"}`
	reader := strings.NewReader(body)
	req := httptest.NewRequest(
		http.MethodPut,
		"/api/tasks/"+taskID+"/workspaces/"+ws.ID+"/file",
		reader,
	)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("write status=%d body=%s", rec.Code, rec.Body.String())
	}
	if consumed := len(body) - reader.Len(); consumed > workspaceWriteBodyLimit+1 {
		t.Fatalf("handler consumed %d bytes of oversized body", consumed)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "package main\n" {
		t.Fatalf("oversized write changed file: %q", data)
	}
}

func TestWriteWorkspaceGenerationRechecksStateAfterLock(t *testing.T) {
	s, token := newTestServer(t)
	s.Workspace = workspace.NewManager(t.TempDir())
	root := t.TempDir()
	mustWriteFile(t, filepath.Join(root, "main.go"), "package main\n")
	taskID := insertWorkspaceTask(t, s.Store, root)
	ws := store.WorkspaceGeneration{
		ID: taskID + ":locked", TaskID: taskID, Generation: 1,
		State: store.WorkspaceActive, SourceRoot: root, Scope: ".",
		PhysicalRoot: root, ExecutionCwd: root,
		CreatedAt: store.NowMilli(), UpdatedAt: store.NowMilli(),
	}
	if _, err := s.Store.InsertWorkspaceAsCurrent(context.Background(), ws); err != nil {
		t.Fatal(err)
	}

	unlock := s.Workspace.LockGeneration(workspace.Metadata{Root: root})
	var (
		rec *httptest.ResponseRecorder
		wg  sync.WaitGroup
	)
	wg.Add(1)
	go func() {
		defer wg.Done()
		req := httptest.NewRequest(
			http.MethodPut,
			"/api/tasks/"+taskID+"/workspaces/"+ws.ID+"/file",
			strings.NewReader(`{"path":"main.go","content":"package overwritten\n"}`),
		)
		req.Header.Set("Authorization", "Bearer "+token)
		rec = httptest.NewRecorder()
		s.Handler().ServeHTTP(rec, req)
	}()
	time.Sleep(20 * time.Millisecond)
	if _, err := s.Store.TransitionWorkspace(
		context.Background(),
		ws.ID,
		[]store.WorkspaceState{store.WorkspaceActive},
		store.WorkspaceFinalizing,
	); err != nil {
		unlock()
		t.Fatal(err)
	}
	unlock()
	wg.Wait()

	if rec == nil || rec.Code != http.StatusConflict {
		t.Fatalf("write status=%v body=%v", rec.Code, rec.Body.String())
	}
	data, err := os.ReadFile(filepath.Join(root, "main.go"))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "package main\n" {
		t.Fatalf("stale write changed finalized workspace: %q", data)
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
				if !strings.Contains(rr.Body.String(), "not UTF-8 text") {
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
				if !strings.Contains(rr.Body.String(), "file exceeds") {
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

func TestWriteTaskWorkspaceFile(t *testing.T) {
	s, token := newTestServer(t)
	s.Workspace = workspace.NewManager(t.TempDir())
	h := s.Handler()

	root := t.TempDir()
	mustWriteFile(t, filepath.Join(root, "main.go"), "package main\n")
	mustWriteFile(t, filepath.Join(root, "dir", "nested.txt"), "nested")
	taskID := insertWorkspaceTask(t, s.Store, root)

	writeReq := func(t *testing.T, path, content string) *httptest.ResponseRecorder {
		t.Helper()
		payload, err := json.Marshal(map[string]string{"path": path, "content": content})
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(http.MethodPut, "/api/tasks/"+taskID+"/workspace/file", strings.NewReader(string(payload)))
		req.Header.Set("Authorization", "Bearer "+token)
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		return rr
	}

	t.Run("success", func(t *testing.T) {
		want := "package main\n\nfunc main() {}\n"
		rr := writeReq(t, "main.go", want)
		if rr.Code != http.StatusOK {
			t.Fatalf("write: %d %s", rr.Code, rr.Body.String())
		}
		var got workspaceFileResponse
		if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		if got.Path != "main.go" || got.Content != want || got.Truncated {
			t.Fatalf("got=%+v", got)
		}
		if int(got.Size) != len(want) {
			t.Fatalf("size=%d want=%d", got.Size, len(want))
		}
		data, err := os.ReadFile(filepath.Join(root, "main.go"))
		if err != nil {
			t.Fatal(err)
		}
		if string(data) != want {
			t.Fatalf("disk=%q want=%q", string(data), want)
		}
	})

	t.Run("escape", func(t *testing.T) {
		rr := writeReq(t, "../escape.txt", "nope")
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("escape: %d %s", rr.Code, rr.Body.String())
		}
	})

	t.Run("directory", func(t *testing.T) {
		rr := writeReq(t, "dir", "nope")
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("directory: %d %s", rr.Code, rr.Body.String())
		}
		if !strings.Contains(rr.Body.String(), "not a regular file") {
			t.Fatalf("body=%s", rr.Body.String())
		}
	})

	t.Run("symlink parent escape", func(t *testing.T) {
		outside := t.TempDir()
		outsidePath := filepath.Join(outside, "secret.txt")
		mustWriteFile(t, outsidePath, "secret\n")
		if err := os.Symlink(outside, filepath.Join(root, "link")); err != nil {
			t.Fatal(err)
		}
		rr := writeReq(t, "link/secret.txt", "changed\n")
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("symlink escape: %d %s", rr.Code, rr.Body.String())
		}
		data, err := os.ReadFile(outsidePath)
		if err != nil {
			t.Fatal(err)
		}
		if string(data) != "secret\n" {
			t.Fatalf("outside file changed: %q", data)
		}
	})
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

func TestLegacyWorkspaceWriteUsesCurrentGenerationRoot(t *testing.T) {
	s, token := newTestServer(t)
	s.Workspace = workspace.NewManager(t.TempDir())
	sourceRoot := t.TempDir()
	workspaceRoot := t.TempDir()
	mustWriteFile(t, filepath.Join(sourceRoot, "main.go"), "source\n")
	mustWriteFile(t, filepath.Join(workspaceRoot, "main.go"), "workspace\n")
	taskID := insertWorkspaceTask(t, s.Store, sourceRoot)
	now := store.NowMilli()
	ws := store.WorkspaceGeneration{
		ID: taskID + ":g1", TaskID: taskID, Generation: 1,
		State: store.WorkspaceActive, SourceRoot: sourceRoot, Scope: ".",
		PhysicalRoot: workspaceRoot, ExecutionCwd: workspaceRoot,
		CreatedAt: now, UpdatedAt: now,
	}
	if _, err := s.Store.InsertWorkspaceAsCurrent(context.Background(), ws); err != nil {
		t.Fatal(err)
	}
	readReq := httptest.NewRequest(
		http.MethodGet,
		"/api/tasks/"+taskID+"/workspace/file?path=main.go",
		nil,
	)
	readReq.Header.Set("Authorization", "Bearer "+token)
	readRec := httptest.NewRecorder()
	s.Handler().ServeHTTP(readRec, readReq)
	if readRec.Code != http.StatusOK ||
		!strings.Contains(readRec.Body.String(), `"content":"workspace\n"`) {
		t.Fatalf("legacy live read status=%d body=%s", readRec.Code, readRec.Body.String())
	}
	payload, err := json.Marshal(map[string]string{
		"path": "main.go", "content": "edited workspace\n",
	})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(
		http.MethodPut,
		"/api/tasks/"+taskID+"/workspace/file",
		bytes.NewReader(payload),
	)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("write status=%d body=%s", rec.Code, rec.Body.String())
	}
	source, err := os.ReadFile(filepath.Join(sourceRoot, "main.go"))
	if err != nil {
		t.Fatal(err)
	}
	if string(source) != "source\n" {
		t.Fatalf("legacy route changed source checkout: %q", source)
	}
	written, err := os.ReadFile(filepath.Join(workspaceRoot, "main.go"))
	if err != nil {
		t.Fatal(err)
	}
	if string(written) != "edited workspace\n" {
		t.Fatalf("workspace content=%q", written)
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
