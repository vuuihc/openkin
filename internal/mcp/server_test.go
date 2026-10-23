package mcp

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/remote"
	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/task"
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

// memberAuth is the auth context a member's MCP session gets, built the same way
// the HTTP entry point builds it: the scope comes from the shared rule and the
// holder flag from the same call, so this test cannot pass by having its own idea
// of who a member is.
func memberAuth(principal remote.Principal) authContext {
	return authContext{
		Principal: Principal{Kind: principal.Kind, ID: principal.Identity()},
		ClientID:  "member-client",
		Scopes:    map[string]bool{ScopeRead: true, ScopeWrite: true, ScopeAdmin: true},
		Scope:     store.ScopeForPrincipal(principal),
		Holder:    store.ActsForHolder(principal),
	}
}

func memberWithRole(role string) remote.Principal {
	return remote.Principal{Kind: remote.PrincipalUser, UserID: "member-1", Role: role}
}

// TestMemberMCPCannotReachAnotherAccountsTask is the regression for the hole the
// REST guards would otherwise leave open: every tool that names a task has to
// answer for the same scope, and every tool that describes the machine has to
// refuse a member outright. The scopes are deliberately maximal — a member who
// granted themselves every MCP scope still gets nothing, because reach is not a
// scope.
func TestMemberMCPCannotReachAnotherAccountsTask(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	now := time.Now().UnixMilli()
	for _, task := range []store.Task{
		{ID: "mine", Title: "mine", Agent: "kin", Cwd: "/tmp", Prompt: "p", Status: "succeeded", CreatedAt: now, OwnerUserID: "member-1"},
		{ID: "theirs", Title: "theirs", Agent: "kin", Cwd: "/tmp", Prompt: "p", Status: "succeeded", CreatedAt: now, OwnerUserID: "member-2"},
		{ID: "machines", Title: "machines", Agent: "kin", Cwd: "/tmp", Prompt: "p", Status: "succeeded", CreatedAt: now},
	} {
		if err := st.InsertTask(context.Background(), task); err != nil {
			t.Fatal(err)
		}
	}
	s := &Server{Store: st, now: func() int64 { return now }}
	auth := memberAuth(memberWithRole(store.RoleMember))
	if auth.Holder {
		t.Fatal("a member was treated as holding the machine")
	}
	if auth.Scope.All {
		t.Fatal("a member got an unscoped session")
	}

	call := func(name string, args string) *rpcError {
		t.Helper()
		resp := s.Handle(context.Background(), request{
			JSONRPC: "2.0",
			ID:      json.RawMessage(`9`),
			Method:  "tools/call",
			Params:  json.RawMessage(`{"name":"` + name + `","arguments":` + args + `}`),
		}, auth)
		return resp.Error
	}

	for _, tc := range []struct {
		tool string
		args string
	}{
		{"get_task", `{"task_id":"theirs"}`},
		{"list_task_events", `{"task_id":"theirs"}`},
		{"list_worker_steps", `{"task_id":"theirs"}`},
		{"send_task_message", `{"task_id":"theirs","prompt":"hello","idempotency_key":"k1"}`},
		{"cancel_task", `{"task_id":"theirs"}`},
		{"retry_task", `{"task_id":"theirs","idempotency_key":"k2"}`},
		{"continue_task", `{"task_id":"theirs","idempotency_key":"k3"}`},
		{"get_task", `{"task_id":"machines"}`},
		// An id that does not exist must be indistinguishable from one that is
		// not yours, or the tool becomes an existence oracle.
		{"get_task", `{"task_id":"no-such-task"}`},
		{"list_projects", `{}`},
		{"list_artifacts", `{}`},
		{"read_artifact", `{"artifact_id":"a1"}`},
		{"list_routines", `{}`},
		{"run_routine", `{"routine_id":"r1","idempotency_key":"k4"}`},
		{"get_usage", `{}`},
		{"get_routing_status", `{}`},
	} {
		err := call(tc.tool, tc.args)
		if err == nil {
			t.Fatalf("%s %s reached another account's data", tc.tool, tc.args)
		}
		if err.Code != -32004 {
			t.Fatalf("%s %s: code %d (%s), want -32004 not-found", tc.tool, tc.args, err.Code, err.Message)
		}
	}

	// And the member's own task is still reachable — the guard has to separate
	// accounts, not lock everyone out.
	resp := s.Handle(context.Background(), request{
		JSONRPC: "2.0",
		ID:      json.RawMessage(`10`),
		Method:  "tools/call",
		Params:  json.RawMessage(`{"name":"list_tasks","arguments":{"limit":50}}`),
	}, auth)
	if resp.Error != nil {
		t.Fatalf("list_tasks: %+v", resp.Error)
	}
	// The result is an MCP content envelope wrapping a JSON string, so it has to
	// be unwrapped in two steps rather than grep'd — a substring check on the
	// outer encoding would pass on escaped text it never actually matched.
	envelope, err := json.Marshal(resp.Result)
	if err != nil {
		t.Fatal(err)
	}
	var content struct {
		Content []struct {
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(envelope, &content); err != nil {
		t.Fatal(err)
	}
	if len(content.Content) == 0 {
		t.Fatalf("list_tasks returned no content: %s", envelope)
	}
	var listed struct {
		Tasks []struct {
			ID string `json:"id"`
		} `json:"tasks"`
	}
	if err := json.Unmarshal([]byte(content.Content[0].Text), &listed); err != nil {
		t.Fatalf("decode list_tasks payload %q: %v", content.Content[0].Text, err)
	}
	seen := make(map[string]bool, len(listed.Tasks))
	for _, task := range listed.Tasks {
		seen[task.ID] = true
	}
	if !seen["mine"] {
		t.Fatalf("member cannot see its own task: %v", seen)
	}
	for _, hidden := range []string{"theirs", "machines"} {
		if seen[hidden] {
			t.Fatalf("list_tasks leaked %s: %v", hidden, seen)
		}
	}
}

// TestEveryAdvertisedToolDeclaresItsReach keeps the table honest. toolDefinitions
// is the list of tools that exist; toolReaches is the list of tools that have
// been judged. A tool added to one and not the other is exactly the shape of the
// hole this table was added to close, so it fails here rather than in production.
func TestEveryAdvertisedToolDeclaresItsReach(t *testing.T) {
	advertised := make(map[string]bool)
	for _, def := range toolDefinitions() {
		name, _ := def["name"].(string)
		if name == "" {
			t.Fatalf("tool definition without a name: %v", def)
		}
		advertised[name] = true
		if _, ok := toolReaches[name]; !ok {
			t.Errorf("tool %q is advertised but declares no reach: add it to toolReaches", name)
		}
	}
	for name := range toolReaches {
		if !advertised[name] {
			t.Errorf("toolReaches judges %q, which is not advertised anywhere", name)
		}
	}
}

// TestExecuteToolRefusesAToolWithNoReach covers the other direction: the table is
// consulted before the dispatch switch, so an unlisted tool is refused even if
// something did dispatch it.
func TestExecuteToolRefusesAToolWithNoReach(t *testing.T) {
	s := &Server{}
	resp := s.executeTool(context.Background(), request{ID: json.RawMessage(`11`)},
		authContext{Principal: Principal{Kind: "master", ID: "master"}},
		toolCallParams{Name: "not_a_tool", Arguments: map[string]any{}})
	if resp.Error == nil || resp.Error.Code != -32602 {
		t.Fatalf("want invalid-params refusal, got %+v", resp.Error)
	}
}

// TestMemberMCPCannotReachAnotherAccountsHumanGate covers the two tools whose
// gate is not the reach table. approve_task_action and answer_task_question are
// declared reachOpen because they are gated on the task behind the row, one
// layer further in — so the table's own parity test cannot see a regression
// here, and without this test a refactor that drops either ownsTask call would
// leak approvals with a green suite.
func TestMemberMCPCannotReachAnotherAccountsHumanGate(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	now := time.Now().UnixMilli()
	for _, task := range []store.Task{
		{ID: "mine", Title: "mine", Agent: "kin", Cwd: "/tmp", Prompt: "p", Status: "running", CreatedAt: now, OwnerUserID: "member-1"},
		{ID: "theirs", Title: "theirs", Agent: "kin", Cwd: "/tmp", Prompt: "p", Status: "running", CreatedAt: now, OwnerUserID: "member-2"},
	} {
		if err := st.InsertTask(ctx, task); err != nil {
			t.Fatal(err)
		}
	}
	for _, approval := range []store.Approval{
		{ID: "approval-mine", TaskID: "mine", Kind: "tool_use", Payload: json.RawMessage(`{"tool":"Bash"}`), CreatedAt: now},
		{ID: "approval-theirs", TaskID: "theirs", Kind: "tool_use", Payload: json.RawMessage(`{"tool":"Bash"}`), CreatedAt: now},
	} {
		if err := st.InsertApproval(ctx, approval); err != nil {
			t.Fatal(err)
		}
	}
	for _, question := range []store.UserQuestion{
		{ID: "question-mine", TaskID: "mine", Status: store.UQStatusPending, Payload: json.RawMessage(`{"question":"q"}`), CreatedAt: now},
		{ID: "question-theirs", TaskID: "theirs", Status: store.UQStatusPending, Payload: json.RawMessage(`{"question":"q"}`), CreatedAt: now},
	} {
		if err := st.InsertUserQuestion(ctx, question); err != nil {
			t.Fatal(err)
		}
	}

	s := &Server{Store: st, Engine: task.NewEngine(st, nil, nil, 1), now: func() int64 { return now }}
	auth := memberAuth(memberWithRole(store.RoleMember))

	for _, tc := range []struct {
		tool string
		args string
	}{
		{"approve_task_action", `{"approval_id":"approval-theirs","decision":"approved"}`},
		{"approve_task_action", `{"approval_id":"no-such-approval","decision":"approved"}`},
		{"answer_task_question", `{"question_id":"question-theirs","selected":["a"]}`},
		{"answer_task_question", `{"question_id":"no-such-question","selected":["a"]}`},
	} {
		resp := s.Handle(ctx, request{
			JSONRPC: "2.0",
			ID:      json.RawMessage(`12`),
			Method:  "tools/call",
			Params:  json.RawMessage(`{"name":"` + tc.tool + `","arguments":` + tc.args + `}`),
		}, auth)
		if resp.Error == nil {
			t.Fatalf("%s %s reached another account's task", tc.tool, tc.args)
		}
		if resp.Error.Code != -32004 {
			t.Fatalf("%s %s: code %d (%s), want -32004 not-found",
				tc.tool, tc.args, resp.Error.Code, resp.Error.Message)
		}
	}

	// Its own approval goes through the normal gate rather than the door being
	// simply locked — an over-broad fix would pass every assertion above.
	resp := s.Handle(ctx, request{
		JSONRPC: "2.0",
		ID:      json.RawMessage(`13`),
		Method:  "tools/call",
		Params:  json.RawMessage(`{"name":"approve_task_action","arguments":{"approval_id":"approval-mine","decision":"approved"}}`),
	}, auth)
	if resp.Error != nil {
		t.Fatalf("the member could not approve its own task's action: %+v", resp.Error)
	}
}
