package store

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestExportDirectoryExcludesCredentialsAndSecrets(t *testing.T) {
	s := openDeviceTestStore(t)
	ctx := context.Background()
	if err := s.SetSettings(ctx, map[string]string{
		"ui.theme":              "dark",
		"provider.api_key":      "sk-secret",
		"daemon.token":          "master-secret",
		"providers":             `{"entries":[{"api_key":"sk-nested"}]}`,
		"push.apns.private_key": "-----BEGIN PRIVATE KEY-----\napns-secret\n-----END PRIVATE KEY-----",
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.InsertDeviceCredential(ctx, DeviceCredential{
		ID: "ios-device", TokenHash: "hash", CreatedAt: NowMilli(),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SavePushDevice(ctx, PushDevice{
		ID: "push-1", InstallID: "install-0001", Platform: "ios",
		Token:       "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
		Environment: "sandbox", UpdatedAt: NowMilli(),
	}); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if err := s.ExportDirectory(ctx, dir); err != nil {
		t.Fatal(err)
	}
	settings, err := os.ReadFile(filepath.Join(dir, "settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(settings)
	if strings.Contains(text, "sk-secret") || strings.Contains(text, "master-secret") ||
		strings.Contains(text, "sk-nested") || strings.Contains(text, "apns-secret") {
		t.Fatalf("secret leaked in settings export: %s", text)
	}
	if _, err := os.Stat(filepath.Join(dir, "device_credentials.jsonl")); !os.IsNotExist(err) {
		t.Fatal("device credentials were exported")
	}
	if _, err := os.Stat(filepath.Join(dir, "push_devices.jsonl")); !os.IsNotExist(err) {
		t.Fatal("push device tokens were exported")
	}
}

// G17: an export is a backup, and a backup that authenticates nobody is the
// whole point. Session rows replay into the sessions they came from, one-time
// token hashes spend without the origin, and identity secret hashes invite
// offline guessing — so none of them may leave the machine in the package.
func TestExportDirectoryExcludesLiveCredentials(t *testing.T) {
	s := openDeviceTestStore(t)
	ctx := context.Background()
	now := NowMilli()
	user := User{
		ID: "01USER", Email: "owner@example.com", Role: RoleOwner, CreatedAt: now,
	}
	if err := s.CreateUserWithIdentity(ctx, user, UserIdentity{
		ID: "01IDENT", UserID: user.ID, Provider: ProviderPassword,
		Subject: "owner@example.com", SecretHash: "argon2-hash", CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.CreateAuthSession(ctx, AuthSession{
		ID: "01SESSION", TokenHash: "session-hash", UserID: user.ID,
		CreatedAt: now, ExpiresAt: now + 1000,
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.IssueLoginToken(ctx, "login-hash", user.ID, now, now+1000); err != nil {
		t.Fatal(err)
	}
	if err := s.IssueLoginCode(ctx, "code-hash", "device-key", user.ID, now, now+1000); err != nil {
		t.Fatal(err)
	}
	if err := s.IssueBootstrapToken(ctx, "bootstrap-hash", now, now+1000); err != nil {
		t.Fatal(err)
	}
	if err := s.IssueInviteToken(ctx, "invite-hash", now, now+1000); err != nil {
		t.Fatal(err)
	}

	dir := t.TempDir()
	if err := s.ExportDirectory(ctx, dir); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{
		"auth_sessions.jsonl", "user_identities.jsonl", "login_tokens.jsonl",
		"login_codes.jsonl", "bootstrap_tokens.jsonl", "invite_tokens.jsonl",
	} {
		if _, err := os.Stat(filepath.Join(dir, name)); !os.IsNotExist(err) {
			t.Fatalf("%s was exported", name)
		}
	}
	// The account itself still travels: a restore that lost the users table
	// would lose the Hub's owner and every project's permissions with it.
	if _, err := os.Stat(filepath.Join(dir, "users.jsonl")); err != nil {
		t.Fatalf("users were not exported: %v", err)
	}
}

// G17: the export→restore round trip. A restored Hub keeps its people,
// projects, tasks, and message order, and carries none of the credentials an
// export excludes — the restore signs everyone out by construction.
func TestRestoreDirectoryRoundTrips(t *testing.T) {
	src := openDeviceTestStore(t)
	ctx := context.Background()
	now := NowMilli()

	user := User{ID: "01USER", Email: "owner@example.com", Role: RoleOwner, CreatedAt: now}
	if err := src.CreateUserWithIdentity(ctx, user, UserIdentity{
		ID: "01IDENT", UserID: user.ID, Provider: ProviderPassword,
		Subject: "owner@example.com", SecretHash: "argon2-hash", CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := src.InsertProject(ctx, Project{
		ID: "proj-1", Name: "proj-1", Mode: ProjectModeShip, Status: "active",
		OnePagerRel: "ONEPAGER.md", CreatedAt: now, UpdatedAt: now,
	}, []string{"/tmp/proj"}); err != nil {
		t.Fatal(err)
	}
	if err := src.InsertTask(ctx, Task{
		ID: "task-1", Title: "first", Agent: "kin", Cwd: ".", Prompt: "p",
		Status: "completed", CreatedAt: now, OwnerUserID: user.ID,
		WorkspaceScope: ".", EventEpoch: 1,
	}); err != nil {
		t.Fatal(err)
	}
	// Three messages in a deliberate non-alphabetical order: the restore has to
	// put them back the way they were read out.
	msgs := []KinMessage{
		{Role: "user", Content: "one"},
		{Role: "assistant", Content: "two"},
		{Role: "user", Content: "three"},
	}
	if err := src.ReplaceKinMessages(ctx, "task-1", msgs); err != nil {
		t.Fatal(err)
	}
	if err := src.SetSettings(ctx, map[string]string{
		"ui.theme":         "dark",
		"provider.api_key": "sk-secret",
	}); err != nil {
		t.Fatal(err)
	}
	// A live session exists in the source; the export must not carry it and the
	// restore must not resurrect it.
	if err := src.CreateAuthSession(ctx, AuthSession{
		ID: "01SESSION", TokenHash: "session-hash", UserID: user.ID,
		CreatedAt: now, ExpiresAt: now + 1000,
	}); err != nil {
		t.Fatal(err)
	}

	dir := t.TempDir()
	if err := src.ExportDirectory(ctx, dir); err != nil {
		t.Fatal(err)
	}

	dst := openDeviceTestStore(t)
	if err := dst.RestoreDirectory(ctx, dir); err != nil {
		t.Fatalf("restore: %v", err)
	}

	gotUser, err := dst.GetUser(ctx, user.ID)
	if err != nil {
		t.Fatalf("restored user: %v", err)
	}
	if gotUser.Email != "owner@example.com" || gotUser.Role != RoleOwner {
		t.Fatalf("restored user = %+v", gotUser)
	}
	gotMsgs, err := dst.LoadKinMessages(ctx, "task-1")
	if err != nil {
		t.Fatalf("restored messages: %v", err)
	}
	if len(gotMsgs) != 3 || gotMsgs[0].Content != "one" || gotMsgs[2].Content != "three" {
		t.Fatalf("restored messages out of order: %+v", gotMsgs)
	}
	// Sessions and identity secrets do not exist in the archive, so the
	// restored database cannot authenticate anybody.
	if _, _, err := dst.AuthenticateSession(ctx, "session-hash", now); !errors.Is(err, ErrNotFound) {
		t.Fatalf("restored db authenticated a session the export excluded: %v", err)
	}
	var n int
	if err := dst.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM user_identities`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("restored db carries %d identities the export excluded", n)
	}
	// The secret setting stays out of the round trip; the non-secret one lands.
	settings, err := dst.GetSetting(ctx, "ui.theme")
	if err != nil || settings != "dark" {
		t.Fatalf("restored ui.theme = %q, %v", settings, err)
	}
	if v, err := dst.GetSetting(ctx, "provider.api_key"); err == nil && v == "sk-secret" {
		t.Fatal("a secret setting traveled through the restore")
	}
}

// A snapshot must refuse to carry the tables an export excludes: one appearing
// by hand means the package was assembled outside this code path.
func TestRestoreDirectoryRefusesExcludedTables(t *testing.T) {
	s := openDeviceTestStore(t)
	ctx := context.Background()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "auth_sessions.jsonl"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := s.RestoreDirectory(ctx, dir); err == nil {
		t.Fatal("a restore archive carrying auth_sessions was accepted")
	}
}
