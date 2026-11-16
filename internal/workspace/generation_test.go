package workspace

import (
	"context"
	"errors"
	"testing"
)

// What "there is nothing here to isolate from" covers.
//
// ResolveSource reports one sentinel for every directory a task can be started
// in but not copied out of, and the task engine reads exactly that sentinel as
// "run in the directory itself". The set is wider than "a repository with no
// commits": a bare repository lands here, and so does a directory git cannot
// inspect at all. That width is deliberate — mode auto means "isolate when you
// can", the older non-lazy path has always answered all of these with a shared
// workspace, and a lazy turn disagreeing with a non-lazy one about the same
// directory is the defect this pins shut.
//
// The consequence is worth saying plainly, since it is a write: a turn in a bare
// repository runs there with shared access rather than being refused. Asking for
// isolation by name is what refuses it, and that path keeps the reasons apart —
// the collapse belongs to the question "is there anything to isolate from", not
// to the answer "no, and here is why".
func TestAutoRunsInPlaceWhereverThereIsNothingToIsolateFrom(t *testing.T) {
	requireGit(t)
	ctx := context.Background()

	cases := []struct {
		name  string
		build func(t *testing.T) string
		// refused is what asking for a worktree by name answers instead.
		refused error
	}{
		{
			name:    "a plain directory",
			build:   func(t *testing.T) string { return t.TempDir() },
			refused: ErrNotGit,
		},
		{
			name: "a repository with nothing committed",
			build: func(t *testing.T) string {
				dir := t.TempDir()
				initRepo(t, dir)
				return dir
			},
			refused: ErrNoHead,
		},
		{
			name: "a bare repository",
			build: func(t *testing.T) string {
				dir := t.TempDir()
				gitCmd(t, dir, "init", "--bare")
				return dir
			},
			refused: ErrBareRepository,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := tc.build(t)
			manager := NewManager(t.TempDir())
			if _, err := manager.ResolveSource(ctx, dir); !errors.Is(err, ErrNoHead) {
				t.Fatalf("ResolveSource = %v, want ErrNoHead", err)
			}
			meta, err := manager.Prepare(ctx, testTaskID, dir, ModeAuto)
			if err != nil {
				t.Fatalf("auto must still find somewhere to run: %v", err)
			}
			if meta.Mode != ResolvedShared {
				t.Fatalf("mode = %s, want the directory itself", meta.Mode)
			}
			if _, err := manager.Prepare(ctx, "01ARZ3NDEKTSV4RRFFQ69G5FAW", dir, ModeWorktree); !errors.Is(err, tc.refused) {
				t.Fatalf("explicit worktree = %v, want %v", err, tc.refused)
			}
		})
	}
}

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
