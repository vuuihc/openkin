package store

import (
	"context"
	"testing"
	"time"
)

// Session lifecycle: D13/G6/T7 — sliding 30 days, absolute 180 days, ≤20
// device sessions per account. The sliding decision and the absolute ceiling
// are store-level because both have to hold for every reader of a session
// (authentication, push delivery, the pruner), not just for one caller.

func seedSessionUser(t *testing.T, s *Store) {
	t.Helper()
	if err := s.CreateUserWithIdentity(context.Background(),
		User{ID: "user-1", Email: "owner@example.com", Role: RoleOwner, CreatedAt: 1},
		UserIdentity{ID: "identity-1", UserID: "user-1", Provider: ProviderPassword,
			Subject: "owner@example.com", SecretHash: "hash", CreatedAt: 1},
	); err != nil {
		t.Fatal(err)
	}
}

const (
	sliding30d = int64(30 * 24 * time.Hour / time.Millisecond)
	dayMs      = int64(24 * time.Hour / time.Millisecond)
)

func TestAuthenticateSessionSlidesExpiryOnUse(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	seedSessionUser(t, s)

	// A session opened 100 days ago, never used since: its row still says the
	// 30-day expiry, so it is dead on read.
	created := NowMilli() - 100*dayMs
	seedSession(t, s, "stale", "hash-stale", "user-1", created, created+sliding30d)
	if _, _, err := s.AuthenticateSession(ctx, "hash-stale", NowMilli(), sliding30d); err == nil {
		t.Fatal("a session unused for 100 days authenticated")
	}

	// A session opened 100 days ago but used 10 days ago lives: the sliding
	// window re-anchors on last use. The renewal is written, not just computed,
	// so the pruner — which sweeps on expires_at — sees the new anchor.
	used := NowMilli() - 10*dayMs
	seedSession(t, s, "active", "hash-active", "user-1", created, created+sliding30d)
	if _, err := s.db.ExecContext(ctx,
		`UPDATE auth_sessions SET last_seen_at = ? WHERE id = 'active'`, used); err != nil {
		t.Fatal(err)
	}
	session, _, err := s.AuthenticateSession(ctx, "hash-active", NowMilli(), sliding30d)
	if err != nil {
		t.Fatalf("a recently used session was refused: %v", err)
	}
	if session.ExpiresAt <= NowMilli() {
		t.Fatalf("expires_at %d was not re-anchored past now", session.ExpiresAt)
	}
}

func TestAuthenticateSessionDiesAtTheAbsoluteCeiling(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	seedSessionUser(t, s)

	// Exactly at the ceiling, used a minute ago: the sliding window would
	// happily keep going, but nothing outlives the ceiling. The refusal is the
	// point — a credential that never expires is a credential that never
	// rotates.
	created := NowMilli() - AuthSessionAbsoluteTTL
	used := NowMilli() - 60*1000
	seedSession(t, s, "ancient", "hash-ancient", "user-1", created, created+sliding30d)
	if _, err := s.db.ExecContext(ctx,
		`UPDATE auth_sessions SET last_seen_at = ? WHERE id = 'ancient'`, used); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.AuthenticateSession(ctx, "hash-ancient", NowMilli(), sliding30d); err == nil {
		t.Fatal("a session past the absolute ceiling authenticated")
	}
}

func TestPruneAuthSessionsRemovesSessionsPastTheAbsoluteCeiling(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	seedSessionUser(t, s)

	// The pruner is what retires ancient-but-used sessions: their sliding
	// expiry keeps moving, so expires_at alone would never fire.
	created := NowMilli() - (AuthSessionAbsoluteTTL + dayMs)
	seedSession(t, s, "ancient", "hash-ancient", "user-1", created, NowMilli()+sliding30d)
	seedSession(t, s, "young", "hash-young", "user-1", NowMilli(), NowMilli()+sliding30d)
	saveSessionDevice(t, s, "phone-ancient", "install-ancient", "token-ancient", "ancient")

	if _, err := s.PruneAuthSessions(ctx, NowMilli()); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM auth_sessions WHERE id IN ('ancient','young')`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("%d sessions left, want only 'young'", n)
	}
	devices, err := s.ListPushDevices(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(devices) != 0 {
		t.Fatalf("the evicted session's registration survived: %+v", devices)
	}
}

func TestEnforceAuthSessionCapEvictsOldest(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	seedSessionUser(t, s)

	// Four live sessions against a cap of 3: the oldest goes, and the phone
	// bound to it goes with it — a retired kiosk login must not keep ringing.
	now := NowMilli()
	seedSession(t, s, "s1", "hash-1", "user-1", now-4000, now+sliding30d)
	seedSession(t, s, "s2", "hash-2", "user-1", now-3000, now+sliding30d)
	seedSession(t, s, "s3", "hash-3", "user-1", now-2000, now+sliding30d)
	seedSession(t, s, "s4", "hash-4", "user-1", now-1000, now+sliding30d)
	saveSessionDevice(t, s, "phone-s1", "install-1", "token-1", "s1")
	saveSessionDevice(t, s, "phone-s2", "install-2", "token-2", "s2")

	if err := s.EnforceAuthSessionCap(ctx, "user-1", 3); err != nil {
		t.Fatal(err)
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id FROM auth_sessions WHERE user_id = 'user-1' ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var got []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		got = append(got, id)
	}
	if len(got) != 3 || got[0] != "s2" || got[1] != "s3" || got[2] != "s4" {
		t.Fatalf("sessions = %v, want s2..s4 (oldest evicted)", got)
	}
	devices, err := s.ListPushDevices(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(devices) != 1 || devices[0].OwnerSessionID != "s2" {
		t.Fatalf("devices = %+v, want only s2's registration", devices)
	}

	// A cap the account already fits leaves everything alone. The re-read is
	// the assertion: the first query's slice is history, not the current table.
	if err := s.EnforceAuthSessionCap(ctx, "user-1", 10); err != nil {
		t.Fatal(err)
	}
	var after int
	if err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM auth_sessions WHERE user_id = 'user-1'`).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if after != 3 {
		t.Fatalf("an over-fitting cap changed the count: %d", after)
	}
}

// The cap math runs in SQL, and SQLite reads a negative LIMIT as "no limit".
// An account under its cap makes the eviction count negative; an unclamped
// expression would delete the account's whole session list on every sign-in.
// The other cap tests cannot see this because they only exercise an account
// that is actually over the cap.
func TestEnforceAuthSessionCapUnderTheCapLeavesAllSessions(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	seedSessionUser(t, s)

	now := NowMilli()
	seedSession(t, s, "s1", "hash-1", "user-1", now-2000, now+sliding30d)
	seedSession(t, s, "s2", "hash-2", "user-1", now-1000, now+sliding30d)

	if err := s.EnforceAuthSessionCap(ctx, "user-1", 20); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM auth_sessions WHERE user_id = 'user-1'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("a sign-in under the cap deleted %d of 2 sessions", 2-n)
	}
}

func TestEnforceAuthSessionCapKeepsOtherAccounts(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	seedSessionUser(t, s)
	if err := s.CreateUserWithIdentity(context.Background(),
		User{ID: "user-2", Email: "member@example.com", Role: RoleMember, CreatedAt: 1},
		UserIdentity{ID: "identity-2", UserID: "user-2", Provider: ProviderPassword,
			Subject: "member@example.com", SecretHash: "hash", CreatedAt: 1},
	); err != nil {
		t.Fatal(err)
	}

	now := NowMilli()
	for i := 0; i < 4; i++ {
		id := "u1-" + string(rune('a'+i))
		seedSession(t, s, id, "hash-"+id, "user-1", now-int64(4000-i*1000), now+sliding30d)
	}
	seedSession(t, s, "u2-a", "hash-u2-a", "user-2", now-5000, now+sliding30d)

	if err := s.EnforceAuthSessionCap(ctx, "user-1", 3); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM auth_sessions WHERE user_id = 'user-2'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("another account lost %d session(s) to user-1's cap", 1-n)
	}
}
