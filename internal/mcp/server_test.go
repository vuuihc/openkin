package mcp

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/store"
)

func TestToolsListCoversPublicSurface(t *testing.T) {
	s := &Server{}
	resp := s.Handle(context.Background(), request{
		JSONRPC: "2.0",
		ID:      json.RawMessage(`1`),
		Method:  "tools/list",
	}, authContext{
		Principal: Principal{Kind: "master", ID: "master"},
		ClientID:  "test-client",
		Scopes:    map[string]bool{ScopeRead: true, ScopeWrite: true, ScopeAdmin: true},
	})
	if resp.Error != nil {
		t.Fatalf("tools/list error: %+v", resp.Error)
	}
	raw, err := json.Marshal(resp.Result)
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Tools []struct {
			Name string `json:"name"`
		} `json:"tools"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"list_tasks", "get_task", "list_task_events", "list_worker_steps", "list_projects",
		"list_artifacts", "read_artifact", "list_routines", "get_usage",
		"get_routing_status", "create_task", "send_task_message",
		"cancel_task", "retry_task", "continue_task", "approve_task_action",
		"answer_task_question", "run_routine",
	}
	got := make(map[string]bool, len(result.Tools))
	for _, tool := range result.Tools {
		got[tool.Name] = true
	}
	for _, name := range want {
		if !got[name] {
			t.Fatalf("tools/list missing %q: %v", name, got)
		}
	}
}

func TestDeviceReadScopeCannotMutate(t *testing.T) {
	s := &Server{}
	resp := s.Handle(context.Background(), request{
		JSONRPC: "2.0",
		ID:      json.RawMessage(`2`),
		Method:  "tools/call",
		Params:  json.RawMessage(`{"name":"cancel_task","arguments":{"task_id":"t1"}}`),
	}, authContext{
		Principal: Principal{Kind: "device", ID: "ios-1"},
		ClientID:  "ios-client",
		Scopes:    map[string]bool{ScopeRead: true},
	})
	if resp.Error == nil || resp.Error.Code != -32001 {
		t.Fatalf("want scope error, got %+v", resp.Error)
	}
}

func TestListTasksIsBoundedAndAudited(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	now := time.Now().UnixMilli()
	if err := st.InsertTask(context.Background(), store.Task{
		ID: "mcp-task-1", Title: "MCP task", Agent: "kin",
		Cwd: "/tmp", Prompt: "read", Status: "succeeded", CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	s := &Server{Store: st, now: func() int64 { return now }}
	resp := s.Handle(context.Background(), request{
		JSONRPC: "2.0",
		ID:      json.RawMessage(`3`),
		Method:  "tools/call",
		Params:  json.RawMessage(`{"name":"list_tasks","arguments":{"limit":10000}}`),
	}, authContext{
		Principal: Principal{Kind: "master", ID: "master"},
		ClientID:  "test-client",
		Scopes:    map[string]bool{ScopeRead: true},
	})
	if resp.Error != nil {
		t.Fatalf("list_tasks error: %+v", resp.Error)
	}
	var auditCount int
	if err := st.DB().QueryRow(`SELECT COUNT(*) FROM mcp_audit_calls`).Scan(&auditCount); err != nil {
		t.Fatal(err)
	}
	if auditCount != 1 {
		t.Fatalf("audit count=%d want 1", auditCount)
	}
}

func TestMCPIdempotencySurvivesStoreReload(t *testing.T) {
	path := filepath.Join(t.TempDir(), "kin.db")
	st, err := store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UnixMilli()
	if err := st.PutMCPIdempotency(context.Background(), "master:master", "client", "key", []byte(`{"ok":true}`), time.Hour, now); err != nil {
		t.Fatal(err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	st, err = store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	got, ok, err := st.GetMCPIdempotency(context.Background(), "master:master", "client", "key", now+time.Minute.Milliseconds())
	if err != nil || !ok || string(got) != `{"ok":true}` {
		t.Fatalf("idempotency = %q, %v, %v", got, ok, err)
	}
}

func TestReadArtifactBoundsReadAndReportsExactLimitCorrectly(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	ctx := context.Background()
	now := time.Now().UnixMilli()
	if err := st.InsertTask(ctx, store.Task{
		ID: "artifact-source", Title: "source", Agent: "kin", Cwd: "/tmp",
		Prompt: "source", Status: "succeeded", CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "exact.txt"), []byte("12345678"), 0o600); err != nil {
		t.Fatal(err)
	}
	sourceID := "artifact-source"
	if err := st.InsertArtifact(ctx, store.Artifact{
		ID: "artifact-exact", Title: "exact", Kind: store.ArtifactKindText,
		RelPath: "exact.txt", Size: 8, Status: store.ArtifactSaved,
		SourceTaskID: &sourceID, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	s := &Server{Store: st, ArtifactsDir: root}
	result, err := s.readArtifact(ctx, map[string]any{
		"artifact_id": "artifact-exact",
		"max_bytes":   float64(8),
	})
	if err != nil {
		t.Fatal(err)
	}
	body, ok := result.(map[string]any)
	if !ok {
		t.Fatalf("result type=%T", result)
	}
	if body["truncated"] != false {
		t.Fatalf("truncated=%v want false", body["truncated"])
	}
	if body["content"] != "12345678" {
		t.Fatalf("content=%q", body["content"])
	}
}

func TestPublicReadResultsDoNotExposeLocalPaths(t *testing.T) {
	taskResult := publicTask(store.Task{
		ID: "task", Cwd: "/private/project", WorkspaceRoot: "/private/worktree",
		WorkspaceSourceRoot: "/private/source", ExecutionCwd: "/private/exec",
		Status: "queued",
	})
	for _, field := range []string{"cwd", "workspace_root", "workspace_source_root", "execution_cwd"} {
		if _, ok := taskResult[field]; ok {
			t.Fatalf("task result exposes %q: %v", field, taskResult)
		}
	}
	projectResult := publicProject(store.Project{
		ID: "project", Roots: []string{"/private/project"},
	})
	if _, ok := projectResult["roots"]; ok {
		t.Fatalf("project result exposes roots: %v", projectResult)
	}
	routineResult := publicRoutine(store.Routine{ID: "routine", Cwd: "/private/project"})
	if _, ok := routineResult["cwd"]; ok {
		t.Fatalf("routine result exposes cwd: %v", routineResult)
	}
}

func TestWithProtocolMetaAdds2026RequestMetadata(t *testing.T) {
	payload, err := withProtocolMeta([]byte(`{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}`), "2026-07-28")
	if err != nil {
		t.Fatal(err)
	}
	var req request
	if err := json.Unmarshal(payload, &req); err != nil {
		t.Fatal(err)
	}
	if got := bodyProtocolVersion(req.Params); got != "2026-07-28" {
		t.Fatalf("protocol metadata=%q", got)
	}
}
