package store

import (
	"context"
	"path/filepath"
	"testing"
)

// The identity tables shipped without a role on the account, and the column
// went into the base schema rather than a migration step. A Hub claimed by the
// earlier build is therefore at the current version with an account table that
// has no role -- and every account read fails with "no such column", starting
// with the login path.
func TestAnAccountTableFromBeforeTheRoleColumnIsRepairedOnOpen(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "kin.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.CreateUserWithIdentity(ctx,
		User{ID: "user-claimer", Email: "owner@example.com", Role: RoleOwner, CreatedAt: 1},
		UserIdentity{ID: "identity-1", UserID: "user-claimer", Provider: ProviderPassword,
			Subject: "owner@example.com", SecretHash: "hash", CreatedAt: 1},
	); err != nil {
		t.Fatal(err)
	}
	// Hand the table back the shape it had before the column existed: the
	// account, its credential, and version 39 stay; only the role goes away.
	if _, err := s.db.ExecContext(ctx, `ALTER TABLE users DROP COLUMN role`); err != nil {
		t.Fatalf("simulate a pre-role database: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(path)
	if err != nil {
		t.Fatalf("reopen a database whose account table has no role: %v", err)
	}
	t.Cleanup(func() { _ = reopened.Close() })

	// The login path is the read the missing column broke.
	user, _, err := reopened.UserByIdentity(ctx, ProviderPassword, "owner@example.com")
	if err != nil {
		t.Fatalf("the repaired account cannot be read: %v", err)
	}
	if user.Role != RoleOwner {
		t.Fatalf("role after the repair = %q, want the claiming account to keep %q", user.Role, RoleOwner)
	}
	// And the operator command that could not list anyone.
	users, err := reopened.ListUsers(ctx)
	if err != nil {
		t.Fatalf("the repaired account table cannot be listed: %v", err)
	}
	if len(users) != 1 || users[0].ID != "user-claimer" || users[0].Role != RoleOwner {
		t.Fatalf("accounts after the repair = %+v, want the claimer as owner", users)
	}
}

// An empty account table is repaired the same way and invents no owner: an
// unclaimed Hub must still offer itself for claiming.
func TestAnEmptyAccountTableFromBeforeTheRoleColumnGetsNoOwner(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "kin.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.ExecContext(ctx, `ALTER TABLE users DROP COLUMN role`); err != nil {
		t.Fatalf("simulate a pre-role database: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(path)
	if err != nil {
		t.Fatalf("reopen an empty database whose account table has no role: %v", err)
	}
	t.Cleanup(func() { _ = reopened.Close() })

	users, err := reopened.ListUsers(ctx)
	if err != nil {
		t.Fatalf("the repaired account table cannot be listed: %v", err)
	}
	if len(users) != 0 {
		t.Fatalf("accounts after the repair = %+v, want none", users)
	}
	if n, err := reopened.CountUsers(ctx); err != nil || n != 0 {
		t.Fatalf("CountUsers = %d, %v; want 0 so the Hub stays claimable", n, err)
	}
}

// The repair must not touch a database that already records roles: the account
// that registered as a member is a member afterwards.
func TestTheRoleRepairLeavesAnExistingMemberAlone(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "kin.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.CreateUserWithIdentity(ctx,
		User{ID: "user-member", Email: "member@example.com", Role: RoleMember, CreatedAt: 1},
		UserIdentity{ID: "identity-1", UserID: "user-member", Provider: ProviderPassword,
			Subject: "member@example.com", SecretHash: "hash", CreatedAt: 1},
	); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.Close() })

	user, _, err := reopened.UserByIdentity(ctx, ProviderPassword, "member@example.com")
	if err != nil {
		t.Fatal(err)
	}
	if user.Role != RoleMember {
		t.Fatalf("role after a reopen = %q, want %q left alone", user.Role, RoleMember)
	}
}

// Two accounts in a pre-role table is reachable: that build issued a second
// bootstrap code without a lock, so two claims could both get past it. Both
// held the daemon's authority then, and a single role cannot give it to both,
// so the repair makes the first-inserted account the owner rather than leave
// the Hub with nobody who can administer it.
func TestTheRoleRepairMakesTheEarliestOfTwoClaimantsTheOwner(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "kin.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	for i, id := range []string{"user-a", "user-b"} {
		if err := s.CreateUserWithIdentity(ctx,
			User{ID: id, Email: id + "@example.com", Role: RoleMember, CreatedAt: int64(i + 1)},
			UserIdentity{ID: "identity-" + id, UserID: id, Provider: ProviderPassword,
				Subject: id + "@example.com", SecretHash: "hash", CreatedAt: int64(i + 1)},
		); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.db.ExecContext(ctx, `ALTER TABLE users DROP COLUMN role`); err != nil {
		t.Fatalf("simulate a pre-role database: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(path)
	if err != nil {
		t.Fatalf("reopen a two-account database whose table has no role: %v", err)
	}
	t.Cleanup(func() { _ = reopened.Close() })

	users, err := reopened.ListUsers(ctx)
	if err != nil {
		t.Fatalf("the repaired account table cannot be listed: %v", err)
	}
	if len(users) != 2 {
		t.Fatalf("accounts after the repair = %+v, want both kept", users)
	}
	want := map[string]string{"user-a": RoleOwner, "user-b": RoleMember}
	for _, user := range users {
		if user.Role != want[user.ID] {
			t.Fatalf("account %s came out %q, want %q", user.ID, user.Role, want[user.ID])
		}
	}
}

// The version stamp alone does not describe the table. Version 39 was stamped once
// before `user_seq` existed on it, so a database can be current and still lack the
// column -- and then every queue read fails with "no such column", including the
// read the delivery path makes to answer a message the user can see.
func TestAQueueTableFromBeforeTheAnchorColumnIsRepairedOnOpen(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "kin.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	insertQueueTask(t, s, "task-old")
	// The shape commit d590e87 shipped at version 39, with a row queued by it.
	if _, err := s.db.ExecContext(ctx, `
		DROP TABLE task_pending_prompts;
		CREATE TABLE task_pending_prompts (
		  id              INTEGER PRIMARY KEY AUTOINCREMENT,
		  task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
		  prompt          TEXT NOT NULL,
		  agent           TEXT NOT NULL DEFAULT '',
		  model           TEXT,
		  permission_mode TEXT,
		  queued_at       INTEGER NOT NULL
		);
		CREATE INDEX idx_task_pending_prompts_queue ON task_pending_prompts(task_id, id);
		PRAGMA user_version = 39;
		INSERT INTO task_pending_prompts (task_id, prompt, queued_at)
		VALUES ('task-old', 'queued by the older build', 1);`); err != nil {
		t.Fatalf("recreate the shape 39 first shipped: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(path)
	if err != nil {
		t.Fatalf("reopen a version-39 database whose queue has no anchor column: %v", err)
	}
	t.Cleanup(func() { _ = reopened.Close() })

	var columns int
	if err := reopened.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM pragma_table_info('task_pending_prompts') WHERE name = 'user_seq'`,
	).Scan(&columns); err != nil {
		t.Fatal(err)
	}
	if columns != 1 {
		t.Fatal("user_seq was not added to the queue table")
	}
	// The row that was queued before the column existed is still deliverable, with
	// no anchor -- the delivery path writes the user event in that case.
	got, err := reopened.ListPendingPrompts(ctx, "task-old")
	if err != nil {
		t.Fatalf("the repaired queue cannot be read: %v", err)
	}
	if len(got) != 1 || got[0].Prompt != "queued by the older build" || got[0].UserSeq != 0 {
		t.Fatalf("queue after the repair = %+v, want the older row kept with no anchor", got)
	}
	// And a new row carries its anchor.
	appended, err := reopened.AppendPendingPrompt(ctx, PendingPrompt{
		TaskID: "task-old", Prompt: "queued after the repair", UserSeq: 42,
	})
	if err != nil {
		t.Fatal(err)
	}
	if appended.UserSeq != 42 {
		t.Fatalf("appended row has user_seq %d, want 42", appended.UserSeq)
	}
}
