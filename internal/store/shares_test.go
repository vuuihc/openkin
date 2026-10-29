package store

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
)

// A share link is one row: which task, the digest of the token, and whether the
// owner has taken it back. What is pinned here is the liveness rule — a link is
// live only while it is neither revoked nor expired — because every public read
// goes through it.

func openShareStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func insertShare(t *testing.T, s *Store, id, taskID, hash string, createdAt, expiresAt int64) {
	t.Helper()
	if err := s.InsertSessionShare(context.Background(), SessionShare{
		ID: id, TaskID: taskID, TokenHash: hash, CreatedAt: createdAt, ExpiresAt: expiresAt,
	}); err != nil {
		t.Fatal(err)
	}
}

func TestSessionShareIsLiveUntilRevoked(t *testing.T) {
	s := openShareStore(t)
	ctx := context.Background()
	insertShare(t, s, "share-1", "task-a", "hash-1", 1000, 0)

	share, ok, err := s.ActiveSessionShare(ctx, "task-a", 2000)
	if err != nil || !ok || share.ID != "share-1" {
		t.Fatalf("active share = %+v, ok=%v, err=%v", share, ok, err)
	}
	byToken, ok, err := s.SessionShareByTokenHash(ctx, "hash-1", 2000)
	if err != nil || !ok || byToken.TaskID != "task-a" {
		t.Fatalf("share by token = %+v, ok=%v, err=%v", byToken, ok, err)
	}

	if _, err := s.RevokeSessionShares(ctx, "task-a", 3000); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := s.ActiveSessionShare(ctx, "task-a", 4000); ok {
		t.Fatal("a revoked share is still active")
	}
	if _, ok, _ := s.SessionShareByTokenHash(ctx, "hash-1", 4000); ok {
		t.Fatal("a revoked share still resolves by token")
	}
	// Revoking again closes nothing and is not an error.
	if n, err := s.RevokeSessionShares(ctx, "task-a", 5000); err != nil || n != 0 {
		t.Fatalf("second revoke = %d, %v", n, err)
	}
}

func TestSessionShareExpires(t *testing.T) {
	s := openShareStore(t)
	ctx := context.Background()
	insertShare(t, s, "share-2", "task-b", "hash-2", 1000, 2000)

	if _, ok, _ := s.ActiveSessionShare(ctx, "task-b", 1999); !ok {
		t.Fatal("share should be live before its expiry")
	}
	if _, ok, _ := s.ActiveSessionShare(ctx, "task-b", 2000); ok {
		t.Fatal("share should be dead at its expiry instant")
	}
	if _, ok, _ := s.SessionShareByTokenHash(ctx, "hash-2", 2000); ok {
		t.Fatal("an expired share still resolves by token")
	}
}

// Revoking one task's link must not close another task's.
func TestRevokingOneTaskLeavesOtherSharesAlone(t *testing.T) {
	s := openShareStore(t)
	ctx := context.Background()
	insertShare(t, s, "share-a", "task-a", "hash-a", 1000, 0)
	insertShare(t, s, "share-b", "task-b", "hash-b", 1000, 0)

	if _, err := s.RevokeSessionShares(ctx, "task-a", 2000); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := s.SessionShareByTokenHash(ctx, "hash-b", 3000); !ok {
		t.Fatal("revoking task-a closed task-b's link")
	}
}

// The share table arrived after databases were already in the field, so a
// database stamped with the current version but missing the table has to be
// repaired on open — the same lesson the recurrence column taught.
func TestSessionShareTableIsReconciledOnOpen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "kin.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`DROP TABLE session_shares`); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(path)
	if err != nil {
		t.Fatalf("reopen without the share table: %v", err)
	}
	defer func() { _ = reopened.Close() }()
	if err := reopened.InsertSessionShare(context.Background(), SessionShare{
		ID: "share-r", TaskID: "task-r", TokenHash: "hash-r", CreatedAt: 1,
	}); err != nil {
		t.Fatalf("insert after reconcile: %v", err)
	}
}

func TestListMessageEventsKeepsOnlyMessagesInOrder(t *testing.T) {
	s := openShareStore(t)
	ctx := context.Background()
	if err := s.InsertTask(ctx, Task{
		ID: "task-m", Title: "t", Agent: "kin", Cwd: "/tmp", Prompt: "p",
		Status: "running", CreatedAt: NowMilli(),
	}); err != nil {
		t.Fatal(err)
	}
	appendEvent := func(typ, payload string) {
		t.Helper()
		if _, err := s.AppendEvent(ctx, "task-m", typ, json.RawMessage(payload)); err != nil {
			t.Fatal(err)
		}
	}
	appendEvent("message", `{"role":"user","content":[{"type":"text","text":"hi"}]}`)
	appendEvent("tool_use", `{"name":"Bash"}`)
	appendEvent("message", `{"role":"assistant","content":[{"type":"text","text":"hello"}]}`)

	events, err := s.ListMessageEvents(ctx, "task-m", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 || events[0].Seq >= events[1].Seq {
		t.Fatalf("events = %+v", events)
	}
	for _, ev := range events {
		if ev.Type != "message" {
			t.Fatalf("non-message event leaked into the conversation: %q", ev.Type)
		}
	}
	// A limit is a limit, and it keeps the newest rows — returned oldest-first
	// so a reader still sees the conversation in order.
	limited, err := s.ListMessageEvents(ctx, "task-m", 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(limited) != 1 || limited[0].Seq != events[len(events)-1].Seq {
		t.Fatalf("limited = %+v, want the newest of %+v", limited, events)
	}
}

// A deleted task must not leave a readable link behind. The public read 404s on
// a missing task anyway, but a row that points at nothing is a row that keeps
// answering "this link exists" to the owner's console.
func TestDeletingATaskRemovesItsShare(t *testing.T) {
	s := openShareStore(t)
	ctx := context.Background()
	if err := s.InsertTask(ctx, Task{
		ID: "task-gone", Title: "t", Agent: "kin", Cwd: "/tmp", Prompt: "p",
		Status: "finished", CreatedAt: NowMilli(),
	}); err != nil {
		t.Fatal(err)
	}
	insertShare(t, s, "share-gone", "task-gone", "hash-gone", 1000, 0)
	if err := s.DeleteTask(ctx, "task-gone"); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := s.SessionShareByTokenHash(ctx, "hash-gone", 2000); ok {
		t.Fatal("a deleted task's share still resolves")
	}
}
