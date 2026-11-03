// KIN-NOTIFY-001: native device registry and the removal of the old channels.
package store

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

func openPushDeviceStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func TestPushDeviceRoundTrip(t *testing.T) {
	s := openPushDeviceStore(t)
	ctx := context.Background()
	id, err := s.SavePushDevice(ctx, PushDevice{
		ID: "d1", InstallID: "install-1", Platform: "ios", Token: "token-1",
		Environment: "sandbox", Name: "iPhone", CreatedAt: 1000, UpdatedAt: 1000,
	})
	if err != nil {
		t.Fatal(err)
	}
	if id != "d1" {
		t.Fatalf("id = %q", id)
	}
	devices, err := s.ListPushDevices(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(devices) != 1 || devices[0].Token != "token-1" || devices[0].InstallID != "install-1" {
		t.Fatalf("devices = %+v", devices)
	}
	got, err := s.GetPushDevice(ctx, "d1")
	if err != nil || got.Name != "iPhone" {
		t.Fatalf("get = %+v, %v", got, err)
	}
	if n, err := s.CountPushDevices(ctx); err != nil || n != 1 {
		t.Fatalf("count = %d, %v", n, err)
	}
}

func TestPushDeviceIsUniquePerInstall(t *testing.T) {
	s := openPushDeviceStore(t)
	ctx := context.Background()
	if _, err := s.SavePushDevice(ctx, PushDevice{
		ID: "d1", InstallID: "install-1", Platform: "ios", Token: "token-old",
		Environment: "sandbox", CreatedAt: 1000, UpdatedAt: 1000,
	}); err != nil {
		t.Fatal(err)
	}
	// Reinstalling the app keeps the installation id and mints a new token.
	id, err := s.SavePushDevice(ctx, PushDevice{
		ID: "d2", InstallID: "install-1", Platform: "ios", Token: "token-new",
		Environment: "production", Name: "iPhone", CreatedAt: 2000, UpdatedAt: 2000,
	})
	if err != nil {
		t.Fatal(err)
	}
	if id != "d1" {
		t.Fatalf("re-register reported id %q, want the stored row's d1", id)
	}
	devices, _ := s.ListPushDevices(ctx)
	if len(devices) != 1 {
		t.Fatalf("one install produced %d rows", len(devices))
	}
	if devices[0].Token != "token-new" || devices[0].Environment != "production" || devices[0].ID != "d1" {
		t.Fatalf("row was not updated in place: %+v", devices[0])
	}
}

func TestPushDeviceTokenMovesToTheNewInstall(t *testing.T) {
	s := openPushDeviceStore(t)
	ctx := context.Background()
	for _, d := range []PushDevice{
		{ID: "d1", InstallID: "install-1", Platform: "ios", Token: "token-1", Environment: "sandbox", CreatedAt: 1000, UpdatedAt: 1000},
		{ID: "d2", InstallID: "install-2", Platform: "ios", Token: "token-2", Environment: "sandbox", CreatedAt: 2000, UpdatedAt: 2000},
	} {
		if _, err := s.SavePushDevice(ctx, d); err != nil {
			t.Fatal(err)
		}
	}
	// Apple handed install-2 the token install-1 used to hold.
	if _, err := s.SavePushDevice(ctx, PushDevice{
		ID: "d3", InstallID: "install-2", Platform: "ios", Token: "token-1",
		Environment: "sandbox", CreatedAt: 3000, UpdatedAt: 3000,
	}); err != nil {
		t.Fatal(err)
	}
	devices, _ := s.ListPushDevices(ctx)
	if len(devices) != 1 || devices[0].InstallID != "install-2" || devices[0].Token != "token-1" {
		t.Fatalf("devices = %+v", devices)
	}
}

// KIN-NOTIFY-001: an event with no owner is the operator's own work. It may
// ring the operator's phone, never a member's.
func TestPushDevicesForOwnerDoesNotTreatEmptyOwnerAsEveryone(t *testing.T) {
	s := openPushDeviceStore(t)
	ctx := context.Background()
	for _, d := range []PushDevice{
		{ID: "operator", InstallID: "install-op", Platform: "ios", Token: "token-op", Environment: "sandbox", CreatedAt: 1000, UpdatedAt: 1000},
		{ID: "member", InstallID: "install-mem", Platform: "ios", Token: "token-mem", Environment: "sandbox", OwnerUserID: "user-1", CreatedAt: 2000, UpdatedAt: 2000},
	} {
		if _, err := s.SavePushDevice(ctx, d); err != nil {
			t.Fatal(err)
		}
	}

	operator, err := s.ListPushDevicesForOwner(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(operator) != 1 || operator[0].ID != "operator" {
		t.Fatalf("empty owner reached %+v", operator)
	}

	// An operator-wide row still receives a member's events; the member row
	// receives only its own.
	member, err := s.ListPushDevicesForOwner(ctx, "user-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(member) != 2 {
		t.Fatalf("member owner reached %+v", member)
	}
}

func TestPushDeviceDeleteAndResult(t *testing.T) {
	s := openPushDeviceStore(t)
	ctx := context.Background()
	for _, d := range []PushDevice{
		{ID: "d1", InstallID: "install-1", Platform: "ios", Token: "token-1", Environment: "sandbox", CreatedAt: 1000, UpdatedAt: 1000},
		{ID: "d2", InstallID: "install-2", Platform: "ios", Token: "token-2", Environment: "sandbox", CreatedAt: 2000, UpdatedAt: 2000},
	} {
		if _, err := s.SavePushDevice(ctx, d); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.MarkPushDeviceResult(ctx, "d1", 5000, ""); err != nil {
		t.Fatal(err)
	}
	got, _ := s.GetPushDevice(ctx, "d1")
	if got.LastOKAt != 5000 || got.LastError != "" {
		t.Fatalf("after success = %+v", got)
	}
	if err := s.MarkPushDeviceResult(ctx, "d1", 6000, "BadDeviceToken"); err != nil {
		t.Fatal(err)
	}
	got, _ = s.GetPushDevice(ctx, "d1")
	if got.LastError != "BadDeviceToken" || got.LastOKAt != 5000 {
		t.Fatalf("after failure = %+v", got)
	}
	if err := s.DeletePushDevice(ctx, "d1"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetPushDevice(ctx, "d1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("get after delete: %v", err)
	}
	if err := s.DeletePushDeviceByInstall(ctx, "install-2"); err != nil {
		t.Fatal(err)
	}
	if n, _ := s.CountPushDevices(ctx); n != 0 {
		t.Fatalf("count = %d", n)
	}
}

func TestPushDeviceByTokenDelete(t *testing.T) {
	s := openPushDeviceStore(t)
	ctx := context.Background()
	if _, err := s.SavePushDevice(ctx, PushDevice{
		ID: "d1", InstallID: "install-1", Platform: "ios", Token: "token-1",
		Environment: "sandbox", CreatedAt: 1000, UpdatedAt: 1000,
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.DeletePushDeviceByToken(ctx, "token-1"); err != nil {
		t.Fatal(err)
	}
	if n, _ := s.CountPushDevices(ctx); n != 0 {
		t.Fatalf("count = %d", n)
	}
}

func TestPushDeviceRequiresEveryField(t *testing.T) {
	s := openPushDeviceStore(t)
	ctx := context.Background()
	cases := []PushDevice{
		{InstallID: "i", Platform: "ios", Token: "t", Environment: "sandbox", UpdatedAt: 1},
		{ID: "d", Platform: "ios", Token: "t", Environment: "sandbox", UpdatedAt: 1},
		{ID: "d", InstallID: "i", Token: "t", Environment: "sandbox", UpdatedAt: 1},
		{ID: "d", InstallID: "i", Platform: "ios", Environment: "sandbox", UpdatedAt: 1},
		{ID: "d", InstallID: "i", Platform: "ios", Token: "t", UpdatedAt: 1},
		{ID: "d", InstallID: "i", Platform: "ios", Token: "t", Environment: "sandbox"},
	}
	for i, d := range cases {
		if _, err := s.SavePushDevice(ctx, d); err == nil {
			t.Errorf("case %d: expected an error", i)
		}
	}
}

func TestMigrationRemovesLegacyPushState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "kin.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	// Recreate what an older build left behind: browser subscriptions, the
	// Bark/ntfy settings, and the VAPID key.
	ctx := context.Background()
	if _, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS push_subscriptions (
		id TEXT PRIMARY KEY, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL,
		auth TEXT NOT NULL, created_at INTEGER NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	for key, value := range map[string]string{
		"notify.bark_url":    "https://api.day.app/example",
		"notify.ntfy_topic":  "example-topic",
		"push.vapid_private": "example-key",
		"ui.base_url":        "https://kin.example.com",
	} {
		if err := s.SetSetting(ctx, key, value); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.db.ExecContext(ctx, `PRAGMA user_version = 44`); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	s, err = Open(path)
	if err != nil {
		t.Fatalf("reopen after old schema: %v", err)
	}
	defer s.Close()
	for _, key := range []string{"notify.bark_url", "notify.ntfy_topic", "push.vapid_private"} {
		if _, err := s.GetSetting(ctx, key); !errors.Is(err, ErrNotFound) {
			t.Errorf("%s survived migration: %v", key, err)
		}
	}
	if got, err := s.GetSetting(ctx, "ui.base_url"); err != nil || got != "https://kin.example.com" {
		t.Errorf("ui.base_url was collateral damage: %q, %v", got, err)
	}
	var n int
	if err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='push_subscriptions'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Error("push_subscriptions survived migration")
	}
	// The native registry is usable straight after the upgrade.
	if _, err := s.SavePushDevice(ctx, PushDevice{
		ID: "d1", InstallID: "install-1", Platform: "ios", Token: "token-1",
		Environment: "sandbox", CreatedAt: 1000, UpdatedAt: 1000,
	}); err != nil {
		t.Fatalf("save after migration: %v", err)
	}
}

// KIN-NOTIFY-001: a registration made from a browser login belongs to that
// login, not only to the account. Signing out on the phone must stop it; an
// operator-wide row or a paired device's row has no session and must survive.
// KIN-NOTIFY-001: a v46 registry already holds rows when the session column is
// added. Operator-wide and paired-device rows keep the lifetime their
// credential gave them; a row that came from a login but carries no session
// (written by the pre-fix build) can never be ended, so the upgrade removes it
// instead of leaving it fail-open.
func TestUpgradeToSessionBindingKeepsExistingRows(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "kin.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range []PushDevice{
		{ID: "old", InstallID: "install-old", Platform: "ios", Token: "token-old",
			Environment: "sandbox", Name: "iPhone", CreatedAt: 1000, UpdatedAt: 1000},
		{ID: "member", InstallID: "install-member", Platform: "ios", Token: "token-member",
			Environment: "sandbox", OwnerUserID: "user-1", CreatedAt: 1000, UpdatedAt: 1000},
	} {
		if _, err := s.SavePushDevice(ctx, d); err != nil {
			t.Fatal(err)
		}
	}
	// Put the registry back to the schema before the session column.
	if _, err := s.db.ExecContext(ctx, `
		DROP INDEX IF EXISTS idx_push_devices_session;
		ALTER TABLE push_devices DROP COLUMN owner_session_id;
		PRAGMA user_version = 46;`); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	s, err = Open(path)
	if err != nil {
		t.Fatalf("reopen after v46 schema: %v", err)
	}
	defer s.Close()
	if v := schemaVersionOf(t, s); v != 47 {
		t.Fatalf("user_version = %d, want 47", v)
	}
	got, err := s.GetPushDevice(ctx, "old")
	if err != nil {
		t.Fatal(err)
	}
	if got.Token != "token-old" || got.OwnerSessionID != "" {
		t.Fatalf("upgraded row = %+v", got)
	}
	if _, err := s.GetPushDevice(ctx, "member"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("an unbound session registration survived the upgrade: %v", err)
	}
	if _, err := s.SavePushDevice(ctx, PushDevice{
		ID: "new", InstallID: "install-new", Platform: "ios", Token: "token-new",
		Environment: "sandbox", OwnerUserID: "user-1", OwnerSessionID: "session-1",
		CreatedAt: 2000, UpdatedAt: 2000,
	}); err != nil {
		t.Fatalf("save a session-bound row after the upgrade: %v", err)
	}
}

func TestPushDeviceSessionBindingRoundTrips(t *testing.T) {
	s := openPushDeviceStore(t)
	ctx := context.Background()
	if _, err := s.SavePushDevice(ctx, PushDevice{
		ID: "d1", InstallID: "install-1", Platform: "ios", Token: "token-1",
		Environment: "sandbox", OwnerUserID: "user-1", OwnerSessionID: "session-1",
		CreatedAt: 1000, UpdatedAt: 1000,
	}); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetPushDevice(ctx, "d1")
	if err != nil {
		t.Fatal(err)
	}
	if got.OwnerSessionID != "session-1" || got.OwnerUserID != "user-1" {
		t.Fatalf("owner = %q / session %q", got.OwnerUserID, got.OwnerSessionID)
	}
	devices, err := s.ListPushDevices(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(devices) != 1 || devices[0].OwnerSessionID != "session-1" {
		t.Fatalf("list = %+v", devices)
	}
}

func seedOwner(t *testing.T, s *Store) {
	t.Helper()
	if err := s.CreateUserWithIdentity(context.Background(),
		User{ID: "user-1", Email: "owner@example.com", Role: RoleOwner, CreatedAt: 1},
		UserIdentity{ID: "identity-1", UserID: "user-1", Provider: ProviderPassword,
			Subject: "owner@example.com", SecretHash: "hash", CreatedAt: 1},
	); err != nil {
		t.Fatal(err)
	}
}

func seedSession(t *testing.T, s *Store, id, tokenHash, userID string, createdAt, expiresAt int64) {
	t.Helper()
	if err := s.CreateAuthSession(context.Background(), AuthSession{
		ID: id, TokenHash: tokenHash, UserID: userID,
		CreatedAt: createdAt, ExpiresAt: expiresAt,
	}); err != nil {
		t.Fatal(err)
	}
}

func saveSessionDevice(t *testing.T, s *Store, id, install, token, sessionID string) {
	t.Helper()
	if _, err := s.SavePushDevice(context.Background(), PushDevice{
		ID: id, InstallID: install, Platform: "ios", Token: token,
		Environment: "sandbox", OwnerUserID: "user-1", OwnerSessionID: sessionID,
		CreatedAt: 1000, UpdatedAt: 1000,
	}); err != nil {
		t.Fatal(err)
	}
}

func TestLogoutDeletesOnlyTheSessionsRegistration(t *testing.T) {
	s := openPushDeviceStore(t)
	ctx := context.Background()
	seedOwner(t, s)
	seedSession(t, s, "session-1", "hash-1", "user-1", 1000, 9000)
	seedSession(t, s, "session-2", "hash-2", "user-1", 1000, 9000)
	saveSessionDevice(t, s, "phone-1", "install-1", "token-1", "session-1")
	saveSessionDevice(t, s, "phone-2", "install-2", "token-2", "session-2")
	if _, err := s.SavePushDevice(ctx, PushDevice{
		ID: "shared", InstallID: "install-shared", Platform: "ios", Token: "token-shared",
		Environment: "sandbox", CreatedAt: 1000, UpdatedAt: 1000,
	}); err != nil {
		t.Fatal(err)
	}

	if err := s.DeleteAuthSession(ctx, "hash-1"); err != nil {
		t.Fatal(err)
	}
	devices, err := s.ListPushDevices(ctx)
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]bool{}
	for _, d := range devices {
		byID[d.ID] = true
	}
	if byID["phone-1"] {
		t.Fatal("signing out left the phone registered")
	}
	if !byID["phone-2"] || !byID["shared"] {
		t.Fatalf("logout removed another session's or the shared row: %v", byID)
	}
}

func TestRevokingEveryOtherSessionDeletesItsRegistration(t *testing.T) {
	s := openPushDeviceStore(t)
	ctx := context.Background()
	seedOwner(t, s)
	seedSession(t, s, "session-keep", "hash-keep", "user-1", 1000, 9000)
	seedSession(t, s, "session-drop", "hash-drop", "user-1", 1000, 9000)
	saveSessionDevice(t, s, "phone-keep", "install-keep", "token-keep", "session-keep")
	saveSessionDevice(t, s, "phone-drop", "install-drop", "token-drop", "session-drop")

	if _, err := s.DeleteUserAuthSessions(ctx, "user-1", "hash-keep"); err != nil {
		t.Fatal(err)
	}
	devices, err := s.ListPushDevices(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(devices) != 1 || devices[0].ID != "phone-keep" {
		t.Fatalf("devices = %+v, want only the kept session's phone", devices)
	}
}

// The v46→v47 migration must tolerate a file that reports 46 while holding no
// registry at all: the numbered block guards on the table, and the every-open
// DDL then creates it whole. Without the guard the ALTER would fail the open.
func TestUpgradeFromV46WithoutTheRegistryCreatesIt(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "kin.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.ExecContext(ctx, `
		DROP TABLE push_devices;
		PRAGMA user_version = 46;`); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	s, err = Open(path)
	if err != nil {
		t.Fatalf("reopen without the registry: %v", err)
	}
	defer s.Close()
	if v := schemaVersionOf(t, s); v != 47 {
		t.Fatalf("user_version = %d, want 47", v)
	}
	if _, err := s.SavePushDevice(ctx, PushDevice{
		ID: "d1", InstallID: "install-1", Platform: "ios", Token: "token-1",
		Environment: "sandbox", CreatedAt: 1000, UpdatedAt: 1000,
	}); err != nil {
		t.Fatalf("save after the registry was recreated: %v", err)
	}
}

// The every-open reconciler is the safety net for a current-version file whose
// registry lost the column (a restore from an older copy, a hand edit). Opening
// it must add the column back rather than fail every query that names it.
func TestEveryOpenReconcilesAMissingSessionColumn(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "kin.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.SavePushDevice(ctx, PushDevice{
		ID: "d1", InstallID: "install-1", Platform: "ios", Token: "token-1",
		Environment: "sandbox", CreatedAt: 1000, UpdatedAt: 1000,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.ExecContext(ctx, `
		DROP INDEX IF EXISTS idx_push_devices_session;
		ALTER TABLE push_devices DROP COLUMN owner_session_id;`); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	s, err = Open(path)
	if err != nil {
		t.Fatalf("reopen with the column missing: %v", err)
	}
	defer s.Close()
	if v := schemaVersionOf(t, s); v != 47 {
		t.Fatalf("user_version = %d, want 47", v)
	}
	got, err := s.GetPushDevice(ctx, "d1")
	if err != nil {
		t.Fatal(err)
	}
	if got.OwnerSessionID != "" || got.Token != "token-1" {
		t.Fatalf("reconciled row = %+v", got)
	}
}

// KIN-NOTIFY-001: a password reset ends every login the account holds, so the
// phones registered through those logins go too. Another account's phone, an
// operator-wide row, and a paired-device row are untouched.
func TestPasswordResetDeletesEverySessionsRegistration(t *testing.T) {
	s := openPushDeviceStore(t)
	ctx := context.Background()
	seedOwner(t, s)
	seedSession(t, s, "session-1", "hash-1", "user-1", 1000, 9000)
	seedSession(t, s, "session-2", "hash-2", "user-1", 1000, 9000)
	saveSessionDevice(t, s, "phone-1", "install-1", "token-1", "session-1")
	saveSessionDevice(t, s, "phone-2", "install-2", "token-2", "session-2")
	if err := s.CreateUserWithIdentity(ctx,
		User{ID: "user-2", Email: "other@example.com", Role: RoleMember, CreatedAt: 1},
		UserIdentity{ID: "identity-2", UserID: "user-2", Provider: ProviderPassword,
			Subject: "other@example.com", SecretHash: "hash", CreatedAt: 1},
	); err != nil {
		t.Fatal(err)
	}
	seedSession(t, s, "session-other", "hash-other", "user-2", 1000, 9000)
	saveSessionDevice(t, s, "phone-other", "install-other", "token-other", "session-other")
	for _, d := range []PushDevice{
		{ID: "operator", InstallID: "install-op", Platform: "ios", Token: "token-op",
			Environment: "sandbox", CreatedAt: 1000, UpdatedAt: 1000},
		{ID: "paired", InstallID: "install-paired", Platform: "ios", Token: "token-paired",
			Environment: "sandbox", OwnerUserID: "user-1", OwnerDeviceID: "device-1",
			CreatedAt: 1000, UpdatedAt: 1000},
	} {
		if _, err := s.SavePushDevice(ctx, d); err != nil {
			t.Fatal(err)
		}
	}

	if err := s.ReplacePasswordAndEndSessions(ctx, "identity-1", "user-1", "new-hash"); err != nil {
		t.Fatal(err)
	}
	devices, err := s.ListPushDevices(ctx)
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]bool{}
	for _, d := range devices {
		byID[d.ID] = true
	}
	for _, gone := range []string{"phone-1", "phone-2"} {
		if byID[gone] {
			t.Errorf("password reset left %s registered", gone)
		}
	}
	for _, kept := range []string{"phone-other", "operator", "paired"} {
		if !byID[kept] {
			t.Errorf("password reset removed %s", kept)
		}
	}
}

func TestPruningSessionsDeletesTheExpiredOnesRegistration(t *testing.T) {
	s := openPushDeviceStore(t)
	ctx := context.Background()
	seedOwner(t, s)
	seedSession(t, s, "session-old", "hash-old", "user-1", 1000, 2000)
	seedSession(t, s, "session-live", "hash-live", "user-1", 1000, 9000)
	saveSessionDevice(t, s, "phone-old", "install-old", "token-old", "session-old")
	saveSessionDevice(t, s, "phone-live", "install-live", "token-live", "session-live")

	if _, err := s.PruneAuthSessions(ctx, 3000); err != nil {
		t.Fatal(err)
	}
	devices, err := s.ListPushDevices(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(devices) != 1 || devices[0].ID != "phone-live" {
		t.Fatalf("devices = %+v, want only the live session's phone", devices)
	}
}

func TestAuthSessionLive(t *testing.T) {
	s := openPushDeviceStore(t)
	ctx := context.Background()
	seedOwner(t, s)
	now := time.Now().UnixMilli()
	seedSession(t, s, "session-live", "hash-live", "user-1", now-1000, now+60_000)
	seedSession(t, s, "session-over", "hash-over", "user-1", now-2000, now-1000)

	if !s.AuthSessionLive(ctx, "session-live") {
		t.Fatal("a live session was reported as ended")
	}
	if s.AuthSessionLive(ctx, "session-over") {
		t.Fatal("an expired session was reported as live")
	}
	if s.AuthSessionLive(ctx, "") || s.AuthSessionLive(ctx, "missing") {
		t.Fatal("an unknown session was reported as live")
	}

	// A disabled account is refused by authentication, so its session must not
	// keep a phone ringing either.
	disabledAt := now - 500
	if err := s.CreateUserWithIdentity(ctx,
		User{ID: "user-2", Email: "other@example.com", Role: RoleMember,
			CreatedAt: 1, DisabledAt: &disabledAt},
		UserIdentity{ID: "identity-2", UserID: "user-2", Provider: ProviderPassword,
			Subject: "other@example.com", SecretHash: "hash", CreatedAt: 1},
	); err != nil {
		t.Fatal(err)
	}
	seedSession(t, s, "session-disabled", "hash-disabled", "user-2", now-1000, now+60_000)
	if s.AuthSessionLive(ctx, "session-disabled") {
		t.Fatal("a disabled account's session was reported as live")
	}
}
