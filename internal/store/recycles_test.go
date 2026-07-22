package store

import (
	"context"
	"path/filepath"
	"testing"
)

func TestProjectRecycleCRUD(t *testing.T) {
	dir := t.TempDir()
	st, err := Open(filepath.Join(dir, "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	ctx := context.Background()

	// Need project + task for FK.
	p := Project{
		ID: "proj1", Name: "P", Mode: ProjectModeShip, Status: ProjectActive,
		OnePagerRel: "p/ONE_PAGER.md", CreatedAt: 1, UpdatedAt: 1, LastActiveAt: 1,
	}
	if err := st.InsertProject(ctx, p, []string{"/tmp/p"}); err != nil {
		t.Fatal(err)
	}
	task := Task{
		ID: "task1", Title: "t", Agent: "kin", Cwd: "/tmp/p", Prompt: "hi",
		Status: "succeeded", CreatedAt: 1, ProjectID: "proj1",
	}
	if err := st.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}

	rec := ProjectRecycle{
		ID: "rec1", ProjectID: "proj1", TaskID: "task1",
		BaseOnePagerUpdatedAt: 100,
		Summary:               "did stuff",
		Suggestions: []RecycleSuggestion{
			{Target: RecycleTargetConclusions, Text: "learned X", Status: SuggestionPending},
		},
		Status:    RecycleStatusPending,
		CreatedAt: 200,
	}
	if err := st.InsertProjectRecycle(ctx, rec); err != nil {
		t.Fatal(err)
	}
	got, err := st.GetTaskRecycle(ctx, "task1")
	if err != nil {
		t.Fatal(err)
	}
	if got.Summary != "did stuff" || len(got.Suggestions) != 1 {
		t.Fatalf("got=%+v", got)
	}

	// Replace pending
	if err := st.DeletePendingRecyclesForTask(ctx, "task1"); err != nil {
		t.Fatal(err)
	}
	if _, err := st.GetTaskRecycle(ctx, "task1"); err == nil {
		t.Fatal("expected not found after delete")
	}

	rec.ID = "rec2"
	if err := st.InsertProjectRecycle(ctx, rec); err != nil {
		t.Fatal(err)
	}
	now := int64(300)
	rec.Suggestions[0].Status = SuggestionAccepted
	rec.Suggestions[0].FinalText = "learned X"
	rec.Suggestions[0].AcceptedAt = &now
	if err := st.UpdateProjectRecycleSuggestions(ctx, "rec2", rec.Suggestions, RecycleStatusResolved, &now); err != nil {
		t.Fatal(err)
	}
	got, err = st.GetProjectRecycle(ctx, "rec2")
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != RecycleStatusResolved || got.Suggestions[0].Status != SuggestionAccepted {
		t.Fatalf("got=%+v", got)
	}

	list, err := st.ListProjectRecycles(ctx, "proj1", 10)
	if err != nil || len(list) != 1 {
		t.Fatalf("list=%v err=%v", list, err)
	}
}
