package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func newScopeTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func insertScopedTask(t *testing.T, s *Store, id, owner string) {
	t.Helper()
	err := s.InsertTask(context.Background(), Task{
		ID: id, Title: id, Agent: "claude-code", Cwd: "/tmp/project",
		Prompt: "do the thing", Status: "queued",
		CreatedAt: time.Now().UnixMilli(), OwnerUserID: owner,
	})
	if err != nil {
		t.Fatalf("insert %s: %v", id, err)
	}
}

func listIDs(t *testing.T, s *Store, scope TaskScope) []string {
	t.Helper()
	tasks, err := s.ListTasks(context.Background(), ListTasksOpts{Scope: scope, Limit: 50})
	if err != nil {
		t.Fatalf("list tasks: %v", err)
	}
	ids := make([]string, 0, len(tasks))
	for _, task := range tasks {
		ids = append(ids, task.ID)
	}
	return ids
}

func sameIDs(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	seen := make(map[string]bool, len(got))
	for _, id := range got {
		seen[id] = true
	}
	for _, id := range want {
		if !seen[id] {
			return false
		}
	}
	return true
}

// TestTaskScopeDecidesWhatOneAccountSees is the contract account isolation
// rests on. It is written against the store rather than the HTTP layer so a
// failure points at the predicate, not at whichever handler forgot to apply it.
func TestTaskScopeDecidesWhatOneAccountSees(t *testing.T) {
	s := newScopeTestStore(t)
	insertScopedTask(t, s, "task-alice", "user-alice")
	insertScopedTask(t, s, "task-bob", "user-bob")
	insertScopedTask(t, s, "task-unowned", "")

	cases := []struct {
		name  string
		scope TaskScope
		want  []string
	}{
		{
			// The master token and the Hub's owner. Unowned tasks are in here
			// on purpose: a standalone daemon writes nothing else, and a
			// routine creates them with no principal at all.
			name:  "unscoped sees every task including unowned ones",
			scope: Unscoped(),
			want:  []string{"task-alice", "task-bob", "task-unowned"},
		},
		{
			name:  "an account sees only what it created",
			scope: OwnedBy("user-alice"),
			want:  []string{"task-alice"},
		},
		{
			name:  "an account does not inherit unowned tasks",
			scope: OwnedBy("user-bob"),
			want:  []string{"task-bob"},
		},
		{
			name:  "an unknown account sees nothing",
			scope: OwnedBy("user-carol"),
			want:  nil,
		},
		{
			// Fail closed. A handler that forgot to build a scope returns an
			// empty list, which someone reports, rather than every task on the
			// daemon, which nobody notices.
			name:  "the zero scope matches nothing",
			scope: TaskScope{},
			want:  nil,
		},
		{
			name:  "a blank account id matches nothing rather than everything",
			scope: OwnedBy("   "),
			want:  nil,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := listIDs(t, s, tc.scope)
			if !sameIDs(got, tc.want) {
				t.Fatalf("ids = %v, want %v", got, tc.want)
			}
		})
	}
}

// TestMatchesAgreesWithTheQuery pins the in-memory predicate to the SQL one.
// The live event stream filters with Matches while the list endpoint filters
// with predicate; if they drift, the stream becomes a way around the list.
func TestMatchesAgreesWithTheQuery(t *testing.T) {
	s := newScopeTestStore(t)
	insertScopedTask(t, s, "task-alice", "user-alice")
	insertScopedTask(t, s, "task-bob", "user-bob")
	insertScopedTask(t, s, "task-unowned", "")

	scopes := []TaskScope{Unscoped(), OwnedBy("user-alice"), OwnedBy("user-bob"), OwnedBy("user-carol"), {}}
	for _, id := range []string{"task-alice", "task-bob", "task-unowned"} {
		task, err := s.GetTask(context.Background(), id)
		if err != nil {
			t.Fatalf("get %s: %v", id, err)
		}
		for _, scope := range scopes {
			var inQuery bool
			for _, got := range listIDs(t, s, scope) {
				if got == id {
					inQuery = true
					break
				}
			}
			if got := scope.Matches(task); got != inQuery {
				t.Fatalf("scope %+v on %s: Matches=%v but the query says %v", scope, id, got, inQuery)
			}
		}
	}
}

// TestInsertTaskRoundTripsTheOwner guards the write side. The column existed
// for several migrations without anything ever writing it, which made every
// scope above silently equivalent to "unowned".
func TestInsertTaskRoundTripsTheOwner(t *testing.T) {
	s := newScopeTestStore(t)
	insertScopedTask(t, s, "task-alice", "user-alice")
	insertScopedTask(t, s, "task-unowned", "")

	task, err := s.GetTask(context.Background(), "task-alice")
	if err != nil {
		t.Fatalf("get owned task: %v", err)
	}
	if task.OwnerUserID != "user-alice" {
		t.Fatalf("owner = %q, want user-alice", task.OwnerUserID)
	}

	// An unowned task has to stay NULL, not become the empty string: the
	// predicate compares for equality, so '' would read as a real account.
	var owner *string
	if err := s.DB().QueryRowContext(context.Background(),
		`SELECT owner_user_id FROM tasks WHERE id = ?`, "task-unowned").Scan(&owner); err != nil {
		t.Fatalf("read raw owner: %v", err)
	}
	if owner != nil {
		t.Fatalf("unowned task stored owner %q, want SQL NULL", *owner)
	}
}
