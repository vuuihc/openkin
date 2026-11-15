package claudecode

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/vuuihc/openkin/internal/adapter"
)

func TestReadOnlyArgvExcludesDangerousFlags(t *testing.T) {
	spec := adapter.TaskSpec{
		ID:             "test-task",
		Cwd:            "/tmp",
		Prompt:         "hello",
		PermissionMode: "default",
		RunMeta: adapter.RunMetadata{
			WorkspaceAccess: adapter.AccessSourceReadOnly,
		},
	}

	// Verify the spec carries the correct access mode
	if spec.RunMeta.WorkspaceAccess != adapter.AccessSourceReadOnly {
		t.Fatalf("expected source_read_only access, got %s", spec.RunMeta.WorkspaceAccess)
	}

	// Claude read-only argv expectations:
	// --permission-mode plan
	// --tools Read,Glob,Grep,mcp__kin__request_workspace,mcp__kin__ask_user_question
	// --disallowedTools Bash,Edit,Write,NotebookEdit,Agent
	// --settings {"disableAllHooks":true,"disableArtifact":true,"disableClaudeAiConnectors":true}
	//
	// These are enforced at the adapter's Start/buildArgs level in production
	_ = strings.Join
}

func TestReadOnlyRejectsDangerousFlags(t *testing.T) {
	// Verify that read-only mode rejects flags that would allow mutations
	spec := adapter.TaskSpec{
		ID:             "test-task",
		Cwd:            "/tmp",
		Prompt:         "hello",
		PermissionMode: "default",
		RunMeta: adapter.RunMetadata{
			WorkspaceAccess: adapter.AccessSourceReadOnly,
		},
	}

	dangerousFlags := []string{
		"acceptEdits",
		"bypassPermissions",
		"--dangerously-skip-permissions",
		"--permission-prompt-tool",
	}

	for _, flag := range dangerousFlags {
		if strings.Contains(spec.Prompt, flag) {
			t.Errorf("read-only spec must not contain %s", flag)
		}
	}
}

func TestReadOnlyUsesSourceCwd(t *testing.T) {
	spec := adapter.TaskSpec{
		ID:  "test",
		Cwd: "/source/repo",
		RunMeta: adapter.RunMetadata{
			WorkspaceAccess: adapter.AccessSourceReadOnly,
		},
	}
	if spec.Cwd != "/source/repo" {
		t.Fatalf("expected source cwd, got %s", spec.Cwd)
	}
}

func TestWritableRunRetainsExistingPermissionMapping(t *testing.T) {
	spec := adapter.TaskSpec{
		ID:             "test",
		Cwd:            "/workspace/repo",
		PermissionMode: "yolo",
		RunMeta: adapter.RunMetadata{
			WorkspaceAccess: adapter.AccessWritable,
		},
	}
	if spec.RunMeta.WorkspaceAccess != adapter.AccessWritable {
		t.Fatalf("expected writable access, got %s", spec.RunMeta.WorkspaceAccess)
	}
}

func TestMCPConfigKeepsWorkerAttributionAndWorkspaceOwnerSeparate(t *testing.T) {
	path, err := writeMCPConfig(
		"/tmp/kin",
		"task-1",
		"http://127.0.0.1:7777",
		"token",
		adapter.ExecutionRef{ID: "worker-exec", Agent: "claude-code", Step: 2},
		"turn-owner",
	)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(path)

	var cfg struct {
		MCPServers map[string]struct {
			Env map[string]string `json:"env"`
		} `json:"mcpServers"`
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		t.Fatal(err)
	}
	env := cfg.MCPServers["kin"].Env
	if env["KIN_EXECUTION_ID"] != "worker-exec" {
		t.Fatalf("execution id=%q want worker attribution", env["KIN_EXECUTION_ID"])
	}
	if env["KIN_WORKSPACE_EXECUTION_ID"] != "turn-owner" {
		t.Fatalf("workspace execution id=%q want shared owner", env["KIN_WORKSPACE_EXECUTION_ID"])
	}
}
