package store

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestProjectCRUD(t *testing.T) {
	s, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()
	now := time.Now().UnixMilli()

	p := Project{
		ID:           "proj-1",
		Name:         "Raft notes",
		Mode:         ProjectModeLearn,
		Status:       ProjectActive,
		OnePagerRel:  "proj-1/ONE_PAGER.md",
		SoftProgress: SoftProgressFog,
		CreatedAt:    now,
		UpdatedAt:    now,
		LastActiveAt: now,
	}
	if err := s.InsertProject(ctx, p, []string{"/tmp/learn/raft"}); err != nil {
		t.Fatal(err)
	}

	got, err := s.GetProject(ctx, "proj-1")
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "Raft notes" || got.Mode != ProjectModeLearn {
		t.Fatalf("got %+v", got)
	}
	if len(got.Roots) != 1 || got.Roots[0] != "/tmp/learn/raft" {
		t.Fatalf("roots=%v", got.Roots)
	}

	byRoot, err := s.FindProjectByRoot(ctx, "/tmp/learn/raft")
	if err != nil {
		t.Fatal(err)
	}
	if byRoot.ID != "proj-1" {
		t.Fatalf("byRoot=%+v", byRoot)
	}

	name := "Raft study"
	mode := ProjectModeShip
	updated, err := s.UpdateProject(ctx, "proj-1", ProjectPatch{
		Name:            &name,
		Mode:            &mode,
		TouchLastActive: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Name != name || updated.Mode != mode {
		t.Fatalf("updated=%+v", updated)
	}

	list, err := s.ListProjects(ctx, ListProjectsOpts{Status: ProjectActive})
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("list=%+v", list)
	}

	// Task with project_id
	task := Task{
		ID:        "task-1",
		Title:     "t",
		Agent:     "kin",
		Cwd:       "/tmp/learn/raft",
		Prompt:    "hi",
		Status:    "queued",
		CreatedAt: now,
		ProjectID: "proj-1",
	}
	if err := s.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}
	tasks, err := s.ListTasks(ctx, ListTasksOpts{ProjectID: "proj-1"})
	if err != nil {
		t.Fatal(err)
	}
	if len(tasks) != 1 || tasks[0].ProjectID != "proj-1" {
		t.Fatalf("tasks=%+v", tasks)
	}

	if _, err := s.GetProject(ctx, "missing"); err != ErrNotFound {
		t.Fatalf("expected not found, got %v", err)
	}
}

func TestOnePagerTemplateAndDigest(t *testing.T) {
	md := DefaultOnePagerMarkdown("Demo", ProjectModeLearn)
	if !strings.Contains(md, "# Demo") || !strings.Contains(md, "## Teach-back") {
		t.Fatalf("template missing sections: %s", md)
	}
	// Fill sections with non-placeholder content.
	filled := strings.Replace(md, "你为什么做这个项目（用户主权；刷新不会改这里）。", "Understand Raft votes", 1)
	filled = strings.Replace(filled, "当下唯一主线（越短越好）。", "Read election chapter", 1)
	filled = strings.Replace(filled, "这是什么、给谁用、边界在哪（3～8 行即可）。", "Consensus learning notes", 1)
	filled = strings.Replace(filled, "## 下一步（你写的）\n1. \n2. \n3. \n", "## 下一步（你写的）\n1. Skim paper\n2. Draw diagram\n3. \n", 1)
	d := OnePagerDigest(filled, 800)
	if !strings.Contains(d, "North Star") || !strings.Contains(d, "Current Focus") {
		t.Fatalf("digest=%q", d)
	}
	prompt := BuildContinuePrompt("Demo", ProjectModeLearn, filled, "Continue")
	if !strings.Contains(prompt, "Continue") || !strings.Contains(prompt, "Project: Demo") {
		t.Fatalf("prompt=%q", prompt)
	}
	if !strings.Contains(prompt, "Mode focus:") {
		t.Fatalf("prompt missing mode strategy: %q", prompt)
	}
}
