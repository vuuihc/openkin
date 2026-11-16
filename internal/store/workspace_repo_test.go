package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

// Where a task's work is: which repository and which branch, as the machine
// holding the files reported it.
//
// The column is additive and starts empty, so a task nobody has asked about
// reads as unknown. That distinction is the point of the tests below: unknown
// and "no repository" are different answers, and the read paths (the PR panel's
// target, the console's branch chip) treat them differently.

func openWorkspaceRepoStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func insertRepoTestTask(t *testing.T, s *Store, id string, repo, branch string) {
	t.Helper()
	task := Task{
		ID: id, Title: "Repo", Agent: "claude-code", Cwd: "/work/app",
		Prompt: "go", Status: "succeeded", CreatedAt: 1,
		WorkspaceRepo: repo, WorkspaceBranch: branch,
	}
	if err := s.InsertTask(context.Background(), task); err != nil {
		t.Fatal(err)
	}
}

func TestTaskKeepsTheRepositoryItWasRecordedOn(t *testing.T) {
	s := openWorkspaceRepoStore(t)
	insertRepoTestTask(t, s, "task-1", "github.com/owner/app", "kin/task/1/g1")

	got, err := s.GetTask(context.Background(), "task-1")
	if err != nil {
		t.Fatal(err)
	}
	if got.WorkspaceRepo != "github.com/owner/app" || got.WorkspaceBranch != "kin/task/1/g1" {
		t.Fatalf("repo/branch = %q/%q, want what was recorded", got.WorkspaceRepo, got.WorkspaceBranch)
	}
}

// A task from before the column existed, and one whose directory is not a
// checkout, both read as empty — which is what every reader has to render as
// "nobody has asked yet" rather than as a repository named "".
func TestTaskWithoutARecordedRepositoryReadsAsUnknown(t *testing.T) {
	s := openWorkspaceRepoStore(t)
	insertRepoTestTask(t, s, "task-2", "", "")

	got, err := s.GetTask(context.Background(), "task-2")
	if err != nil {
		t.Fatal(err)
	}
	if got.WorkspaceRepo != "" || got.WorkspaceBranch != "" {
		t.Fatalf("repo/branch = %q/%q, want empty", got.WorkspaceRepo, got.WorkspaceBranch)
	}
}

func TestRecordingWhereTheWorkIsLeavesTheRestOfTheRowAlone(t *testing.T) {
	ctx := context.Background()
	s := openWorkspaceRepoStore(t)
	insertRepoTestTask(t, s, "task-3", "github.com/owner/old", "main")

	repo, branch := "github.com/owner/new", "feature/x"
	if err := s.UpdateTask(ctx, "task-3", TaskPatch{WorkspaceRepo: &repo, WorkspaceBranch: &branch}); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetTask(ctx, "task-3")
	if err != nil {
		t.Fatal(err)
	}
	if got.WorkspaceRepo != repo || got.WorkspaceBranch != branch {
		t.Fatalf("repo/branch = %q/%q, want the new answer", got.WorkspaceRepo, got.WorkspaceBranch)
	}
	if got.Title != "Repo" || got.Cwd != "/work/app" || got.Agent != "claude-code" {
		t.Fatalf("the patch touched another field: %+v", got)
	}

	// A patch that says nothing about them leaves them as they were: a machine
	// that cannot answer must not erase the last answer it gave.
	title := "renamed"
	if err := s.UpdateTask(ctx, "task-3", TaskPatch{Title: &title}); err != nil {
		t.Fatal(err)
	}
	got, err = s.GetTask(ctx, "task-3")
	if err != nil {
		t.Fatal(err)
	}
	if got.WorkspaceRepo != repo || got.WorkspaceBranch != branch {
		t.Fatalf("an unrelated patch cleared the record: %q/%q", got.WorkspaceRepo, got.WorkspaceBranch)
	}
}

// The upgrade path is the one that can lose data. This is migration 038 over a
// database that already has tasks in it: the column arrives empty, and the rows
// that were there keep everything they had.
func TestUpgradeAddsTheRepositoryColumnAndKeepsRows(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "kin.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}

	now := time.Now().UnixMilli()
	if _, err := s.db.ExecContext(ctx, `
		INSERT INTO tasks (id, title, agent, cwd, prompt, status, created_at, workspace_branch)
		VALUES ('task-old', 'before the upgrade', 'claude-code', '/work/app', 'hi', 'done', ?, 'main')`, now); err != nil {
		t.Fatal(err)
	}
	// Put the database back to the shape migration 038 upgrades from.
	if _, err := s.db.ExecContext(ctx, `
		ALTER TABLE tasks DROP COLUMN workspace_repo;
		PRAGMA user_version = 37;`); err != nil {
		t.Fatalf("roll schema back to 37: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	upgraded, err := Open(path)
	if err != nil {
		t.Fatalf("reopen at version 37: %v", err)
	}
	t.Cleanup(func() { _ = upgraded.Close() })

	if got := schemaVersionOf(t, upgraded); got != schemaVersion {
		t.Fatalf("user_version after upgrade = %d, want %d", got, schemaVersion)
	}
	if cols := tableColumns(t, upgraded, "tasks"); !cols["workspace_repo"] {
		t.Fatalf("upgraded database has no tasks.workspace_repo: %v", cols)
	}

	got, err := upgraded.GetTask(ctx, "task-old")
	if err != nil {
		t.Fatalf("the existing task did not survive the upgrade: %v", err)
	}
	if got.Title != "before the upgrade" || got.WorkspaceBranch != "main" {
		t.Fatalf("row after the upgrade = %+v", got)
	}
	if got.WorkspaceRepo != "" {
		t.Fatalf("a task from before the column reads as %q, want unknown", got.WorkspaceRepo)
	}
}

// A fresh install gets the column from migration001, without running the
// numbered steps — so the two shapes have to agree or one of them is wrong.
func TestFreshInstallHasTheRepositoryColumn(t *testing.T) {
	s := openWorkspaceRepoStore(t)
	if cols := tableColumns(t, s, "tasks"); !cols["workspace_repo"] {
		t.Fatalf("fresh install has no tasks.workspace_repo: %v", cols)
	}
	if got := schemaVersionOf(t, s); got != schemaVersion {
		t.Fatalf("user_version = %d, want %d", got, schemaVersion)
	}
}
