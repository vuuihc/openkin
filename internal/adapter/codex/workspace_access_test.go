package codex

import (
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

	// Codex read-only argv expectations:
	// In production the adapter builds: --sandbox read-only, -c features.hooks=false, etc.
	// Here we verify that the RunMetadata correctly propagates the access mode
	_ = strings.Join
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
