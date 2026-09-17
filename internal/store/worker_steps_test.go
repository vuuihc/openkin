package store

import (
	"context"
	"errors"
	"testing"
)

func TestWorkerPlanPersistsAndUpdatesSteps(t *testing.T) {
	st, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	ctx := context.Background()
	now := NowMilli()
	if err := st.InsertTask(ctx, Task{
		ID: "worker-task", Title: "worker", Agent: "kin", Cwd: "/tmp",
		Prompt: "worker", Status: "queued", CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	plan := []WorkerStep{
		{
			TaskID: "worker-task", ExecutionID: "exec-1", StepIndex: 0,
			Role: "plan", Agent: "claude-code", Access: "read",
			CreatedAt: now, UpdatedAt: now,
		},
		{
			TaskID: "worker-task", ExecutionID: "exec-1", StepIndex: 1,
			Role: "execute", DependsOn: []int{0}, Agent: "codex", Access: "write",
			CreatedAt: now, UpdatedAt: now,
		},
	}
	if err := st.InsertWorkerPlan(ctx, plan); err != nil {
		t.Fatal(err)
	}
	if err := st.InsertWorkerPlan(ctx, plan); err != nil {
		t.Fatal("idempotent insert:", err)
	}
	running := "running"
	if err := st.UpdateWorkerStep(ctx, "worker-task", "exec-1", 0, WorkerStepPatch{
		Status: &running,
	}, now+1); err != nil {
		t.Fatal(err)
	}
	steps, err := st.ListWorkerSteps(ctx, "worker-task", "exec-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(steps) != 2 || steps[1].Access != "write" {
		t.Fatalf("steps=%+v", steps)
	}
	if steps[1].DependsOn == nil || len(steps[1].DependsOn) != 1 || steps[1].DependsOn[0] != 0 {
		t.Fatalf("dependencies=%v", steps[1].DependsOn)
	}
	if steps[0].Status != "running" {
		t.Fatalf("status=%q", steps[0].Status)
	}
	if err := st.DeleteTask(ctx, "worker-task"); err != nil {
		t.Fatal(err)
	}
	steps, err = st.ListWorkerSteps(ctx, "worker-task", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(steps) != 0 {
		t.Fatalf("worker steps survived task delete: %+v", steps)
	}
}

func TestWorkerStepTerminalUpdateCannotOverwriteCanceled(t *testing.T) {
	st, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	ctx := context.Background()
	now := NowMilli()
	if err := st.InsertTask(ctx, Task{
		ID: "worker-cancel-task", Title: "worker", Agent: "kin", Cwd: "/tmp",
		Prompt: "worker", Status: "queued", CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.InsertWorkerPlan(ctx, []WorkerStep{{
		TaskID: "worker-cancel-task", ExecutionID: "exec-1", StepIndex: 0,
		Agent: "codex", Access: "read", CreatedAt: now, UpdatedAt: now,
	}}); err != nil {
		t.Fatal(err)
	}
	canceled := "canceled"
	if err := st.UpdateWorkerStep(ctx, "worker-cancel-task", "exec-1", 0, WorkerStepPatch{
		Status: &canceled,
	}, now+1); err != nil {
		t.Fatal(err)
	}
	succeeded := "succeeded"
	if err := st.UpdateWorkerStep(ctx, "worker-cancel-task", "exec-1", 0, WorkerStepPatch{
		Status: &succeeded,
	}, now+2); !errors.Is(err, ErrNotFound) {
		t.Fatalf("late terminal update error=%v want ErrNotFound", err)
	}
	steps, err := st.ListWorkerSteps(ctx, "worker-cancel-task", "exec-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(steps) != 1 || steps[0].Status != "canceled" {
		t.Fatalf("steps=%+v", steps)
	}
}
