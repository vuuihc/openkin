package store

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestTaskLimitWaitUpsertAndConcurrentClaim(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	ctx := context.Background()
	task := Task{
		ID: "01LIMITWAIT000000000000001", Title: "quota", Agent: "claude-code",
		Cwd: "/tmp", Prompt: "work", Status: "failed", CreatedAt: time.Now().UnixMilli(),
	}
	if err := s.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}
	wait := TaskLimitWait{
		TaskID: task.ID, EventEpoch: 2, UserSeq: 7, Agent: task.Agent,
		Provider: "claude", ResetAt: time.Now().Add(time.Hour).Unix(),
		State: "waiting", NextProbeAt: time.Now().Add(-time.Second).UnixMilli(),
		FirstWaitAt: time.Now().Add(-time.Minute).UnixMilli(),
	}
	if err := s.UpsertTaskLimitWait(ctx, wait); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetTaskLimitWait(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.EventEpoch != 2 || got.UserSeq != 7 || got.Provider != "claude" {
		t.Fatalf("unexpected wait: %+v", got)
	}

	var wg sync.WaitGroup
	results := make(chan error, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := s.ClaimTaskLimitWait(ctx, task.ID, time.Now().UnixMilli())
			results <- err
		}()
	}
	wg.Wait()
	close(results)
	var claimed int
	for err := range results {
		if err == nil {
			claimed++
			continue
		}
		if !errors.Is(err, ErrConflict) {
			t.Fatalf("claim error: %v", err)
		}
	}
	if claimed != 1 {
		t.Fatalf("claimed=%d want 1", claimed)
	}
}

func TestTaskLimitWaitMigration018AndCascade(t *testing.T) {
	path := filepath.Join(t.TempDir(), "kin.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB().Exec(`DROP TABLE task_limit_waits; PRAGMA user_version = 17`); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	var version int
	if err := s.DB().QueryRow(`PRAGMA user_version`).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if version != schemaVersion {
		t.Fatalf("version=%d want %d", version, schemaVersion)
	}
	ctx := context.Background()
	task := Task{
		ID: "01LIMITWAIT000000000000002", Title: "quota", Agent: "kin",
		Cwd: "/tmp", Prompt: "work", Status: "failed", CreatedAt: time.Now().UnixMilli(),
	}
	if err := s.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}
	if err := s.UpsertTaskLimitWait(ctx, TaskLimitWait{
		TaskID: task.ID, State: "waiting", NextProbeAt: time.Now().UnixMilli(),
		FirstWaitAt: time.Now().UnixMilli(), UpdatedAt: time.Now().UnixMilli(),
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteTask(ctx, task.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetTaskLimitWait(ctx, task.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("wait after task delete: %v", err)
	}
}

func TestRequeueTaskLimitWaitClaimsOnRestart(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	ctx := context.Background()
	task := Task{
		ID: "01LIMITWAIT000000000000003", Title: "quota", Agent: "kin",
		Cwd: "/tmp", Prompt: "work", Status: "failed", CreatedAt: time.Now().UnixMilli(),
	}
	if err := s.InsertTask(ctx, task); err != nil {
		t.Fatal(err)
	}
	if err := s.UpsertTaskLimitWait(ctx, TaskLimitWait{
		TaskID: task.ID, State: "waiting", NextProbeAt: time.Now().Add(-time.Second).UnixMilli(),
		FirstWaitAt: time.Now().UnixMilli(), UpdatedAt: time.Now().UnixMilli(),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ClaimTaskLimitWait(ctx, task.ID, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if err := s.RequeueTaskLimitWaitClaims(ctx); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetTaskLimitWait(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.State != "waiting" || got.ClaimedAt != 0 {
		t.Fatalf("requeued wait = %+v", got)
	}
}
