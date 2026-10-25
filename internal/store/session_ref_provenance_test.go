package store

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
)

// A native session id is only resumable on the machine whose agent produced it
// (ADR 0022 D6). These tests pin the two halves of storing that: the provenance
// exists on every database, and it never outlives the ref it describes.

func seedTaskWithSession(t *testing.T, st *Store, id, ref, device string) Task {
	t.Helper()
	task := Task{
		ID:         id,
		Title:      "seeded",
		Agent:      "claudecode",
		Cwd:        "/tmp/project",
		Prompt:     "hello",
		Status:     "succeeded",
		CreatedAt:  NowMilli(),
		SessionRef: &ref,
	}
	if device != "" {
		task.SessionRefDeviceID = &device
	}
	if err := st.InsertTask(context.Background(), task); err != nil {
		t.Fatal(err)
	}
	return task
}

func TestTaskRoundTripsTheSessionRefProvenance(t *testing.T) {
	st, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	seedTaskWithSession(t, st, "task-with-device", "sess-1", "node-abc")
	got, err := st.GetTask(context.Background(), "task-with-device")
	if err != nil {
		t.Fatal(err)
	}
	if got.SessionRef == nil || *got.SessionRef != "sess-1" {
		t.Fatalf("session_ref=%v", got.SessionRef)
	}
	if got.SessionRefDeviceID == nil || *got.SessionRefDeviceID != "node-abc" {
		t.Fatalf("session_ref_device_id=%v, want node-abc", got.SessionRefDeviceID)
	}
}

func TestReplacingTheRefNeverKeepsTheOldProvenance(t *testing.T) {
	st, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	ctx := context.Background()
	seedTaskWithSession(t, st, "task-replace", "sess-old", "node-abc")

	// A caller with no provenance to give. The old one named a machine that did
	// not produce this ref, so it has to go, not linger.
	next := "sess-new"
	if err := st.UpdateTask(ctx, "task-replace", TaskPatch{SessionRef: &next}); err != nil {
		t.Fatal(err)
	}
	got, err := st.GetTask(ctx, "task-replace")
	if err != nil {
		t.Fatal(err)
	}
	if got.SessionRef == nil || *got.SessionRef != "sess-new" {
		t.Fatalf("session_ref=%v", got.SessionRef)
	}
	if got.SessionRefDeviceID != nil {
		t.Fatalf("provenance survived a ref replacement: %v", *got.SessionRefDeviceID)
	}
}

func TestClearingTheRefClearsItsProvenance(t *testing.T) {
	st, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	ctx := context.Background()
	seedTaskWithSession(t, st, "task-clear", "sess-1", "node-abc")

	// The handoff path: a new agent or a new machine cannot use this ref.
	if err := st.UpdateTask(ctx, "task-clear", TaskPatch{ClearSessionRef: true}); err != nil {
		t.Fatal(err)
	}
	got, err := st.GetTask(ctx, "task-clear")
	if err != nil {
		t.Fatal(err)
	}
	if got.SessionRef != nil {
		t.Fatalf("session_ref survived the clear: %v", *got.SessionRef)
	}
	// A provenance without a ref would read as "the ref is still over there".
	if got.SessionRefDeviceID != nil {
		t.Fatalf("provenance survived the clear: %v", *got.SessionRefDeviceID)
	}
}

func TestProvenanceIsAddedToDatabasesWrittenBeforeIt(t *testing.T) {
	path := filepath.Join(t.TempDir(), "kin.db")
	st, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	seedTaskWithSession(t, st, "task-before-provenance", "sess-legacy", "node-abc")

	// Hand the row back the shape it had before this column existed. The ref
	// stays; only the record of where it came from goes away.
	if _, err := st.DB().Exec(`ALTER TABLE tasks DROP COLUMN session_ref_device_id`); err != nil {
		t.Fatalf("simulate a pre-provenance database: %v", err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(path)
	if err != nil {
		t.Fatalf("reopen a pre-provenance database: %v", err)
	}
	defer reopened.Close()
	got, err := reopened.GetTask(context.Background(), "task-before-provenance")
	if err != nil {
		t.Fatal(err)
	}
	if got.SessionRef == nil || *got.SessionRef != "sess-legacy" {
		t.Fatalf("the ref must survive the upgrade: %v", got.SessionRef)
	}
	// Empty, and read as local by the resume path: that is what a ref written
	// before this column existed actually was.
	if got.SessionRefDeviceID != nil {
		t.Fatalf("upgraded row invented a provenance: %v", *got.SessionRefDeviceID)
	}
}

func TestRetryClearsTheRefProvenanceToo(t *testing.T) {
	// The retry mutation writes raw SQL instead of going through TaskPatch, so
	// it is the one place the two columns can drift apart with nothing to
	// notice. Driven through the real entry point rather than grepped for: a
	// string that has to appear somewhere is not the same claim as a row that
	// has to come out clean.
	ctx := context.Background()
	st, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	seedTaskWithSession(t, st, "01RETRYSESS000000000000001", "sess-1", "node-abc")
	event, err := st.AppendEvent(ctx, "01RETRYSESS000000000000001", "message", json.RawMessage(`{"role":"user"}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.ApplyRetryMutation(ctx, RetryMutation{
		TaskID:             "01RETRYSESS000000000000001",
		FromSeq:            event.Seq,
		ExpectedEventEpoch: 0,
		Prompt:             "again",
		UserPayload:        json.RawMessage(`{"role":"user","text":"again"}`),
	}); err != nil {
		t.Fatal(err)
	}
	got, err := st.GetTask(ctx, "01RETRYSESS000000000000001")
	if err != nil {
		t.Fatal(err)
	}
	if got.SessionRef != nil {
		t.Fatalf("retry kept the session ref: %v", *got.SessionRef)
	}
	if got.SessionRefDeviceID != nil {
		t.Fatalf("retry kept the ref provenance without the ref: %v", *got.SessionRefDeviceID)
	}
}
