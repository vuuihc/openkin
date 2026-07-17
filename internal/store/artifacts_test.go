package store

import (
	"context"
	"testing"
	"time"
)

func TestArtifactCRUD(t *testing.T) {
	s, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()

	now := NowMilli()
	srcID := "src-task-001"
	if err := s.InsertTask(ctx, Task{
		ID: srcID, Title: "Source Task", Agent: "test",
		Cwd: "/tmp", Prompt: "x", Status: "done", CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	a := Artifact{
		ID: "art-001", Title: "Test Artifact", Kind: ArtifactKindMarkdown,
		RelPath: "2026/07/art-001.md", Size: 42, Status: ArtifactSaved,
		SourceTaskID: &srcID, CreatedAt: now, UpdatedAt: now,
	}
	if err := s.InsertArtifact(ctx, a); err != nil {
		t.Fatal(err)
	}

	got, err := s.GetArtifact(ctx, a.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Title != "Test Artifact" || got.Kind != ArtifactKindMarkdown || got.Size != 42 {
		t.Fatalf("got %+v", got)
	}
	if got.SourceTaskID == nil || *got.SourceTaskID != srcID {
		t.Fatal("expected source_task_id")
	}

	list, err := s.ListArtifacts(ctx, ListArtifactsOpts{Status: ArtifactSaved})
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].ID != a.ID {
		t.Fatalf("list saved = %+v", list)
	}
	if list[0].SourceTaskTitle != "Source Task" {
		t.Fatalf("expected SourceTaskTitle='Source Task', got %q", list[0].SourceTaskTitle)
	}

	all, err := s.ListArtifacts(ctx, ListArtifactsOpts{})
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 1 {
		t.Fatalf("list all = %+v", all)
	}

	time.Sleep(2 * time.Millisecond)
	updated, err := s.UpdateArtifactStatus(ctx, a.ID, ArtifactArchived)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Status != ArtifactArchived {
		t.Fatalf("status = %q", updated.Status)
	}
	if updated.UpdatedAt < updated.CreatedAt {
		t.Fatal("updated_at should not go backwards")
	}

	archived, err := s.ListArtifacts(ctx, ListArtifactsOpts{Status: ArtifactArchived})
	if err != nil {
		t.Fatal(err)
	}
	if len(archived) != 1 {
		t.Fatalf("list archived = %+v", archived)
	}

	if _, err := s.GetArtifact(ctx, "nonexistent"); err != ErrNotFound {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
	if _, err := s.UpdateArtifactStatus(ctx, "nonexistent", ArtifactArchived); err != ErrNotFound {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

func TestArtifactListEmpty(t *testing.T) {
	s, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	list, err := s.ListArtifacts(context.Background(), ListArtifactsOpts{})
	if err != nil {
		t.Fatal(err)
	}
	if list == nil {
		t.Fatal("expected non-nil empty slice")
	}
	if len(list) != 0 {
		t.Fatalf("len=%d", len(list))
	}
}
