package browserworker

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/oklog/ulid/v2"

	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/task"
)

func TestExecutePersistsEvidenceAndEvents(t *testing.T) {
	st := openTestStore(t)
	engine := task.NewEngineFromAdapters(st, nil, task.NewBus(), 1)
	t.Cleanup(engine.Close)
	taskID := insertRunningTask(t, st)

	script := workerScript(t, `#!/bin/sh
IFS= read line
printf '%s\n' '{"id":"request","type":"result","ok":true,"evidence":[{"kind":"action","size":5,"sha256":"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824","body_base64":"aGVsbG8="}]}'
`)
	artifactsDir := t.TempDir()
	runner, err := New(Config{
		Command:      []string{"sh", script},
		WorkingDir:   filepath.Dir(script),
		DownloadDir:  t.TempDir(),
		UploadDir:    t.TempDir(),
		ArtifactsDir: artifactsDir,
		Store:        st,
		Engine:       engine,
		Bus:          task.NewBus(),
	})
	if err != nil {
		t.Fatal(err)
	}

	if err := runner.Execute(context.Background(), taskID, Action{
		Type: "screenshot",
		Name: "home",
	}); err != nil {
		t.Fatal(err)
	}
	artifacts, err := st.ListArtifacts(context.Background(), store.ListArtifactsOpts{})
	if err != nil {
		t.Fatal(err)
	}
	if len(artifacts) != 1 || artifacts[0].SourceTaskID == nil || *artifacts[0].SourceTaskID != taskID {
		t.Fatalf("artifacts=%+v", artifacts)
	}
	content, err := os.ReadFile(filepath.Join(artifactsDir, artifacts[0].RelPath))
	if err != nil {
		t.Fatal(err)
	}
	var envelope map[string]any
	if err := json.Unmarshal(content, &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope["sha256"] != "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" {
		t.Fatalf("envelope=%v", envelope)
	}

	events, err := st.ListEvents(context.Background(), taskID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 3 || events[0].Type != "browser_action_started" ||
		events[1].Type != "browser_evidence" || events[2].Type != "browser_action_finished" {
		t.Fatalf("events=%+v", events)
	}
}

func TestExecuteUsesTaskApprovalForSideEffect(t *testing.T) {
	st := openTestStore(t)
	engine := task.NewEngineFromAdapters(st, nil, task.NewBus(), 1)
	t.Cleanup(engine.Close)
	taskID := insertRunningTask(t, st)

	script := workerScript(t, `#!/bin/sh
IFS= read line
printf '%s\n' '{"id":"request","type":"approval_required","action":{"type":"click","selector":"#send","side_effect":true}}'
IFS= read approval
printf '%s\n' '{"id":"request","type":"result","ok":true,"evidence":[]}'
`)
	runner, err := New(Config{
		Command:      []string{"sh", script},
		WorkingDir:   filepath.Dir(script),
		DownloadDir:  t.TempDir(),
		UploadDir:    t.TempDir(),
		ArtifactsDir: t.TempDir(),
		Store:        st,
		Engine:       engine,
	})
	if err != nil {
		t.Fatal(err)
	}

	done := make(chan error, 1)
	go func() {
		done <- runner.Execute(context.Background(), taskID, Action{
			Type: "click", Selector: "#send", SideEffect: true,
		})
	}()

	var approval store.Approval
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		list, listErr := st.ListPendingForTask(context.Background(), taskID)
		if listErr == nil && len(list) == 1 {
			approval = list[0]
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if approval.ID == "" {
		t.Fatal("browser approval was not created")
	}
	if _, err := engine.Decide(context.Background(), approval.ID, store.DecisionApproved, "test"); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestCancelStopsWorkerProcess(t *testing.T) {
	st := openTestStore(t)
	engine := task.NewEngineFromAdapters(st, nil, task.NewBus(), 1)
	t.Cleanup(engine.Close)
	taskID := insertRunningTask(t, st)
	script := workerScript(t, `#!/bin/sh
IFS= read line
sleep 10
`)
	runner, err := New(Config{
		Command:      []string{"sh", script},
		WorkingDir:   filepath.Dir(script),
		DownloadDir:  t.TempDir(),
		UploadDir:    t.TempDir(),
		ArtifactsDir: t.TempDir(),
		Store:        st,
		Engine:       engine,
	})
	if err != nil {
		t.Fatal(err)
	}

	done := make(chan error, 1)
	go func() {
		done <- runner.Execute(context.Background(), taskID, Action{Type: "screenshot"})
	}()
	time.Sleep(50 * time.Millisecond)
	if !runner.Cancel(taskID) {
		t.Fatal("expected active browser action")
	}
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("expected cancellation error")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("worker did not stop after cancellation")
	}
}

func TestRedactWorkerError(t *testing.T) {
	message := redactWorkerError(
		`failed /Users/alice/private.txt Bearer abc123 https://example.com/?token=secret`,
	)
	if strings.Contains(message, "private.txt") ||
		strings.Contains(message, "abc123") ||
		strings.Contains(message, "token=secret") {
		t.Fatalf("message was not redacted: %q", message)
	}
}

func openTestStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

func insertRunningTask(t *testing.T, st *store.Store) string {
	t.Helper()
	id := ulid.Make().String()
	if err := st.InsertTask(context.Background(), store.Task{
		ID: id, Title: "Browser test", Agent: "kin", Cwd: t.TempDir(),
		Prompt: "browser", Status: task.StatusRunning, CreatedAt: store.NowMilli(),
	}); err != nil {
		t.Fatal(err)
	}
	return id
}

func workerScript(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "worker.sh")
	if err := os.WriteFile(path, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}
	return path
}
