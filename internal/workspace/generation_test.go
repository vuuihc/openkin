package workspace

import (
	"context"
	"testing"
)

func TestPrepareGenerationAdoptsExistingWorktree(t *testing.T) {
	requireGit(t)
	ctx := context.Background()
	sourceRoot := t.TempDir()
	initRepo(t, sourceRoot)
	commitFile(t, sourceRoot, "file.txt", "content\n")
	manager := NewManager(t.TempDir())
	source, err := manager.ResolveSource(ctx, sourceRoot)
	if err != nil {
		t.Fatal(err)
	}
	first, err := manager.PrepareGeneration(ctx, testTaskID, 2, source)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.CleanupPrepared(ctx, testTaskID, first)

	adopted, err := manager.PrepareGeneration(ctx, testTaskID, 2, source)
	if err != nil {
		t.Fatalf("adopt prepared generation: %v", err)
	}
	if adopted.Root != first.Root || adopted.Branch != first.Branch ||
		adopted.BaseOID != first.BaseOID {
		t.Fatalf("adopted=%+v first=%+v", adopted, first)
	}
}
