package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/remote"
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

// TestScopeForPrincipalNamesWhoHoldsTheMachine is the switch every boundary in
// this area reads, and the arm worth pinning is the device one.
//
// A device credential is unscoped, which is sound only while pairing is
// operatorOnly: every device token was then minted by whoever holds the
// machine, so a device is that person's own client rather than a guest. Nothing
// in ScopeForPrincipal says so and nothing in it can check — that premise lives
// in the route table, and this test is where it is recorded. When members can
// pair their own devices, the device arm has to read the enrolling account's
// role instead of assuming one (`devices.owner_user_id` already exists to carry
// it), and the row below is what has to change with it.
//
// The rest of the table is the fail-closed direction: an account whose role is
// missing, or is a value nothing in the product writes, is narrowed rather than
// trusted. isOperator answers the same way for the same reason.
func TestScopeForPrincipalNamesWhoHoldsTheMachine(t *testing.T) {
	cases := []struct {
		name      string
		principal remote.Principal
		all       bool
		owner     string
	}{
		{"the master token", remote.Principal{Kind: remote.PrincipalMaster}, true, ""},
		{"a paired device", remote.Principal{Kind: remote.PrincipalDevice, DeviceID: "device-1"}, true, ""},
		{"the account that claimed this hub", remote.Principal{
			Kind: remote.PrincipalUser, UserID: "user-owner", Role: RoleOwner}, true, ""},
		{"a member", remote.Principal{
			Kind: remote.PrincipalUser, UserID: "user-member", Role: RoleMember}, false, "user-member"},
		{"an account with no role recorded", remote.Principal{
			Kind: remote.PrincipalUser, UserID: "user-none"}, false, "user-none"},
		{"an account with a role nothing writes", remote.Principal{
			Kind: remote.PrincipalUser, UserID: "user-other", Role: "admin"}, false, "user-other"},
		{"a user principal with no id", remote.Principal{
			Kind: remote.PrincipalUser, Role: RoleMember}, false, ""},
		{"the owner's role with no id to match", remote.Principal{
			Kind: remote.PrincipalUser, Role: RoleOwner}, true, ""},
		{"a kind nothing issues", remote.Principal{Kind: "service"}, false, ""},
		{"no principal at all", remote.Principal{}, false, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			scope := ScopeForPrincipal(tc.principal)
			if scope.All != tc.all {
				t.Fatalf("All = %v, want %v", scope.All, tc.all)
			}
			if scope.OwnerUserID != tc.owner {
				t.Fatalf("OwnerUserID = %q, want %q", scope.OwnerUserID, tc.owner)
			}
			// The role is what grants scope, not the presence of an id — the row
			// above with an owner role and no id is the one that says so. It also
			// records a difference from requireCwdForNonHolder (internal/task),
			// which returns early on an empty owner id without consulting the role
			// at all: the two agree today because a session always sets the id from
			// the account row, and this is where that assumption is visible.
			//
			// ActsForHolder is derived from this switch rather than restated, so
			// this assertion cannot fail against today's code. It is here to fail
			// against tomorrow's — the edit that gives one of them its own answer
			// is exactly the drift the two doc comments warn about.
			if ActsForHolder(tc.principal) != tc.all {
				t.Fatalf("ActsForHolder = %v, want %v", ActsForHolder(tc.principal), tc.all)
			}
		})
	}
}

// The zero scope is the one a handler produces by forgetting to build one, so
// what it matches is a security property rather than a default.
func TestAForgottenScopeMatchesNothing(t *testing.T) {
	var zero TaskScope
	for _, owner := range []string{"", "user-1"} {
		if zero.MatchesOwner(owner) {
			t.Fatalf("the zero scope matched owner %q; a handler that forgets to build one leaks", owner)
		}
	}
	if OwnedBy("   ").All || OwnedBy("").MatchesOwner("") {
		t.Fatal("a blank account produced a scope wider than nothing")
	}
	// And the unowned tasks a routine or an eval run creates belong to whoever
	// holds the machine, so they are outside every one-account scope.
	if OwnedBy("user-1").MatchesOwner("") {
		t.Fatal("an unowned task matched one account's scope")
	}
}
