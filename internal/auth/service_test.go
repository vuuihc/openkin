package auth

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/store"
)

func newTestService(t *testing.T) (*Service, *store.Store) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "kin.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return New(st, Config{}), st
}

func TestHashPasswordRoundTrip(t *testing.T) {
	hash, err := HashPassword("correct horse battery staple")
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	if !strings.HasPrefix(hash, "$argon2id$") {
		t.Fatalf("hash is not argon2id PHC: %q", hash)
	}
	if err := VerifyPassword(hash, "correct horse battery staple"); err != nil {
		t.Fatalf("verify correct password: %v", err)
	}
	if err := VerifyPassword(hash, "wrong password"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("verify wrong password = %v, want ErrInvalidCredentials", err)
	}
}

func TestHashPasswordUsesFreshSalt(t *testing.T) {
	a, err := HashPassword("same input")
	if err != nil {
		t.Fatalf("hash a: %v", err)
	}
	b, err := HashPassword("same input")
	if err != nil {
		t.Fatalf("hash b: %v", err)
	}
	if a == b {
		t.Fatal("two hashes of the same password are identical; salt is not random")
	}
}

func TestVerifyPasswordRejectsMalformedHash(t *testing.T) {
	for _, encoded := range []string{
		"",
		"not-a-hash",
		"$argon2i$v=19$m=65536,t=3,p=2$c2FsdA$aGFzaA",
		"$argon2id$v=19$m=65536,t=3,p=2$!!!$aGFzaA",
		"$argon2id$v=19$m=65536,t=3,p=2$c2FsdA$",
	} {
		if err := VerifyPassword(encoded, "whatever"); !errors.Is(err, ErrInvalidHash) {
			t.Fatalf("VerifyPassword(%q) = %v, want ErrInvalidHash", encoded, err)
		}
	}
}

func TestBootstrapCodeIsSingleUse(t *testing.T) {
	svc, _ := newTestService(t)
	ctx := context.Background()

	code, err := svc.IssueBootstrapCode(ctx)
	if err != nil {
		t.Fatalf("issue code: %v", err)
	}
	if _, err := svc.ClaimWithPassword(ctx, code, "owner@example.com", "hunter2hunter2", "", SessionMeta{}); err != nil {
		t.Fatalf("claim: %v", err)
	}

	// The Hub now has an owner, so a second claim is refused regardless of code.
	if _, err := svc.ClaimWithPassword(ctx, code, "other@example.com", "hunter2hunter2", "", SessionMeta{}); !errors.Is(err, ErrRegistrationClosed) {
		t.Fatalf("second claim = %v, want ErrRegistrationClosed", err)
	}
}

func TestBootstrapRejectsWrongCode(t *testing.T) {
	svc, _ := newTestService(t)
	ctx := context.Background()
	if _, err := svc.IssueBootstrapCode(ctx); err != nil {
		t.Fatalf("issue code: %v", err)
	}
	_, err := svc.ClaimWithPassword(ctx, "AAAAA-BBBBB", "owner@example.com", "hunter2hunter2", "", SessionMeta{})
	if !errors.Is(err, ErrBootstrapUnavailable) {
		t.Fatalf("wrong code = %v, want ErrBootstrapUnavailable", err)
	}
	needs, err := svc.NeedsBootstrap(ctx)
	if err != nil {
		t.Fatalf("needs bootstrap: %v", err)
	}
	if !needs {
		t.Fatal("a failed claim consumed the hub; it must stay unclaimed")
	}
}

func TestIssueBootstrapCodeInvalidatesPrevious(t *testing.T) {
	svc, _ := newTestService(t)
	ctx := context.Background()

	first, err := svc.IssueBootstrapCode(ctx)
	if err != nil {
		t.Fatalf("issue first: %v", err)
	}
	if _, err := svc.IssueBootstrapCode(ctx); err != nil {
		t.Fatalf("issue second: %v", err)
	}
	if _, err := svc.ClaimWithPassword(ctx, first, "owner@example.com", "hunter2hunter2", "", SessionMeta{}); !errors.Is(err, ErrBootstrapUnavailable) {
		t.Fatalf("stale code = %v, want ErrBootstrapUnavailable", err)
	}
}

func TestBootstrapCodeAcceptsFormatting(t *testing.T) {
	svc, _ := newTestService(t)
	ctx := context.Background()
	code, err := svc.IssueBootstrapCode(ctx)
	if err != nil {
		t.Fatalf("issue code: %v", err)
	}
	stripped := strings.ReplaceAll(code, "-", "")
	if _, err := svc.ClaimWithPassword(ctx, stripped, "owner@example.com", "hunter2hunter2", "", SessionMeta{}); err != nil {
		t.Fatalf("claim with separator stripped: %v", err)
	}
}

func TestBootstrapRejectsShortPassword(t *testing.T) {
	svc, _ := newTestService(t)
	ctx := context.Background()
	code, err := svc.IssueBootstrapCode(ctx)
	if err != nil {
		t.Fatalf("issue code: %v", err)
	}
	if _, err := svc.ClaimWithPassword(ctx, code, "owner@example.com", "short", "", SessionMeta{}); !errors.Is(err, ErrWeakPassword) {
		t.Fatalf("short password = %v, want ErrWeakPassword", err)
	}
}

func TestLoginPassword(t *testing.T) {
	svc, st := newTestService(t)
	ctx := context.Background()
	claimOwner(t, svc, st, "Owner@Example.com", "hunter2hunter2")

	t.Run("accepts correct password regardless of email case", func(t *testing.T) {
		session, err := svc.LoginPassword(ctx, "owner@EXAMPLE.com", "hunter2hunter2", SessionMeta{})
		if err != nil {
			t.Fatalf("login: %v", err)
		}
		if session.Token == "" {
			t.Fatal("login returned an empty session token")
		}
		user, err := svc.Authenticate(ctx, session.Token)
		if err != nil {
			t.Fatalf("authenticate: %v", err)
		}
		if user.Email != "owner@example.com" {
			t.Fatalf("email = %q, want normalized owner@example.com", user.Email)
		}
	})

	t.Run("rejects wrong password", func(t *testing.T) {
		if _, err := svc.LoginPassword(ctx, "owner@example.com", "wrong", SessionMeta{}); !errors.Is(err, ErrInvalidCredentials) {
			t.Fatalf("wrong password = %v, want ErrInvalidCredentials", err)
		}
	})

	t.Run("rejects unknown account with the same error", func(t *testing.T) {
		if _, err := svc.LoginPassword(ctx, "nobody@example.com", "hunter2hunter2", SessionMeta{}); !errors.Is(err, ErrInvalidCredentials) {
			t.Fatalf("unknown account = %v, want ErrInvalidCredentials", err)
		}
	})
}

func TestLoginLinkSignsInOnce(t *testing.T) {
	svc, st := newTestService(t)
	ctx := context.Background()
	owner := claimOwner(t, svc, st, "owner@example.com", "hunter2hunter2")

	link, err := svc.IssueLoginLink(ctx, owner.ID)
	if err != nil {
		t.Fatalf("issue login link: %v", err)
	}
	if len(link.Token) != 64 {
		t.Fatalf("token length = %d, want 64 hex characters", len(link.Token))
	}
	if !link.ExpiresAt.After(time.Now()) {
		t.Fatalf("link expiry %v is not in the future", link.ExpiresAt)
	}

	// Case is the one thing a chat client may change about a hex token; the
	// service lowercases before hashing so the link still works.
	session, err := svc.ConsumeLoginLink(ctx, strings.ToUpper(link.Token), SessionMeta{UserAgent: "phone", IP: "192.0.2.10"})
	if err != nil {
		t.Fatalf("consume login link: %v", err)
	}
	user, err := svc.Authenticate(ctx, session.Token)
	if err != nil {
		t.Fatalf("authenticate the new session: %v", err)
	}
	if user.ID != owner.ID {
		t.Fatalf("link signed in as %s, want %s", user.ID, owner.ID)
	}

	if _, err := svc.ConsumeLoginLink(ctx, link.Token, SessionMeta{}); !errors.Is(err, ErrLoginLinkUnavailable) {
		t.Fatalf("second use = %v, want ErrLoginLinkUnavailable", err)
	}
	if _, err := svc.ConsumeLoginLink(ctx, strings.Repeat("0", 64), SessionMeta{}); !errors.Is(err, ErrLoginLinkUnavailable) {
		t.Fatalf("unknown token = %v, want ErrLoginLinkUnavailable", err)
	}
	if _, err := svc.ConsumeLoginLink(ctx, "  ", SessionMeta{}); !errors.Is(err, ErrLoginLinkUnavailable) {
		t.Fatalf("empty token = %v, want ErrLoginLinkUnavailable", err)
	}
}

func TestLoginLinkExpires(t *testing.T) {
	now := time.Now()
	svc, st := newTestService(t)
	svc.cfg.Now = func() time.Time { return now }
	owner := claimOwner(t, svc, st, "owner@example.com", "hunter2hunter2")

	link, err := svc.IssueLoginLink(context.Background(), owner.ID)
	if err != nil {
		t.Fatalf("issue login link: %v", err)
	}
	if got, want := link.ExpiresAt, now.Add(DefaultLoginLinkTTL); !got.Equal(want) {
		t.Fatalf("expiry = %v, want %v", got, want)
	}
	svc.cfg.Now = func() time.Time { return now.Add(DefaultLoginLinkTTL + time.Second) }
	if _, err := svc.ConsumeLoginLink(context.Background(), link.Token, SessionMeta{}); !errors.Is(err, ErrLoginLinkUnavailable) {
		t.Fatalf("expired link = %v, want ErrLoginLinkUnavailable", err)
	}
}

// Minting a replacement has to retire the old link: these are pasted into chat
// transcripts and shell scrollback, so "issue a new one" cannot mean both work.
// Another account's link is untouched -- links are per person, like invitations.
func TestIssuingALoginLinkRetiresOnlyThatAccountsPreviousLink(t *testing.T) {
	svc, st := newTestService(t)
	ctx := context.Background()
	owner := claimOwner(t, svc, st, "owner@example.com", "hunter2hunter2")

	invite, err := svc.IssueInvite(ctx)
	if err != nil {
		t.Fatalf("issue invitation: %v", err)
	}
	member, err := svc.RedeemInvite(ctx, invite.Code, "member@example.com", "hunter2hunter2", "", SessionMeta{})
	if err != nil {
		t.Fatalf("redeem invitation: %v", err)
	}

	oldOwnerLink, err := svc.IssueLoginLink(ctx, owner.ID)
	if err != nil {
		t.Fatalf("issue first owner link: %v", err)
	}
	memberLink, err := svc.IssueLoginLink(ctx, member.User.ID)
	if err != nil {
		t.Fatalf("issue member link: %v", err)
	}
	newOwnerLink, err := svc.IssueLoginLink(ctx, owner.ID)
	if err != nil {
		t.Fatalf("issue second owner link: %v", err)
	}

	if _, err := svc.ConsumeLoginLink(ctx, oldOwnerLink.Token, SessionMeta{}); !errors.Is(err, ErrLoginLinkUnavailable) {
		t.Fatalf("retired owner link = %v, want ErrLoginLinkUnavailable", err)
	}
	if _, err := svc.ConsumeLoginLink(ctx, newOwnerLink.Token, SessionMeta{}); err != nil {
		t.Fatalf("current owner link: %v", err)
	}
	if _, err := svc.ConsumeLoginLink(ctx, memberLink.Token, SessionMeta{}); err != nil {
		t.Fatalf("member link was retired by the owner's link: %v", err)
	}
}

// The link is a bearer credential with no second factor, so only one concurrent
// caller may spend it.
func TestLoginLinkIsSingleUseUnderConcurrency(t *testing.T) {
	svc, st := newTestService(t)
	ctx := context.Background()
	owner := claimOwner(t, svc, st, "owner@example.com", "hunter2hunter2")
	link, err := svc.IssueLoginLink(ctx, owner.ID)
	if err != nil {
		t.Fatalf("issue login link: %v", err)
	}

	const callers = 8
	var wg sync.WaitGroup
	results := make(chan error, callers)
	for i := 0; i < callers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := svc.ConsumeLoginLink(ctx, link.Token, SessionMeta{})
			results <- err
		}()
	}
	wg.Wait()
	close(results)

	var succeeded int
	for err := range results {
		if err == nil {
			succeeded++
			continue
		}
		if !errors.Is(err, ErrLoginLinkUnavailable) {
			t.Fatalf("losing caller = %v, want ErrLoginLinkUnavailable", err)
		}
	}
	if succeeded != 1 {
		t.Fatalf("%d callers spent one link, want exactly 1", succeeded)
	}
}

// A reset is what an operator runs when a credential leaked. Ending sessions
// but leaving an unspent sign-in link live would leave exactly the way back in
// the reset was meant to close.
func TestResetPasswordRetiresUnusedLoginLinks(t *testing.T) {
	svc, st := newTestService(t)
	ctx := context.Background()
	owner := claimOwner(t, svc, st, "owner@example.com", "hunter2hunter2")
	link, err := svc.IssueLoginLink(ctx, owner.ID)
	if err != nil {
		t.Fatalf("issue login link: %v", err)
	}

	if _, err := svc.ResetPassword(ctx, "owner@example.com", "newpassword123"); err != nil {
		t.Fatalf("reset password: %v", err)
	}

	if _, err := svc.ConsumeLoginLink(ctx, link.Token, SessionMeta{}); !errors.Is(err, ErrLoginLinkUnavailable) {
		t.Fatalf("link issued before a reset = %v, want ErrLoginLinkUnavailable", err)
	}
}

// The disabled column has no product command yet, so the test writes it the way
// an operator eventually would: straight to the database.
func TestLoginLinkRefusesADisabledAccount(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "kin.db")
	st, err := store.Open(dbPath)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	svc := New(st, Config{})
	ctx := context.Background()
	owner := claimOwner(t, svc, st, "owner@example.com", "hunter2hunter2")
	link, err := svc.IssueLoginLink(ctx, owner.ID)
	if err != nil {
		t.Fatalf("issue login link: %v", err)
	}

	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open second connection: %v", err)
	}
	defer db.Close()
	if _, err := db.ExecContext(ctx,
		`UPDATE users SET disabled_at = ? WHERE id = ?`, time.Now().UnixMilli(), owner.ID); err != nil {
		t.Fatalf("disable account: %v", err)
	}

	if _, err := svc.IssueLoginLink(ctx, owner.ID); !errors.Is(err, ErrAccountDisabled) {
		t.Fatalf("issue for a disabled account = %v, want ErrAccountDisabled", err)
	}
	if _, err := svc.ConsumeLoginLink(ctx, link.Token, SessionMeta{}); !errors.Is(err, ErrLoginLinkUnavailable) {
		t.Fatalf("link for a disabled account = %v, want ErrLoginLinkUnavailable", err)
	}
}

// A Hub created before sign-in links existed has no login_tokens table. The
// upgrade path has to be opening the same database with the new binary: if the
// table is only created alongside new accounts, the first `kin hub init` on an
// upgraded deployment fails at the one moment somebody is locked out.
func TestLoginLinkSchemaIsAddedToAnOlderDatabase(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "kin.db")
	st, err := store.Open(dbPath)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	svc := New(st, Config{})
	ctx := context.Background()
	owner := claimOwner(t, svc, st, "owner@example.com", "hunter2hunter2")
	if err := st.Close(); err != nil {
		t.Fatalf("close store: %v", err)
	}

	// The database as an older build left it.
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open raw connection: %v", err)
	}
	if _, err := db.ExecContext(ctx, `DROP TABLE login_tokens`); err != nil {
		db.Close()
		t.Fatalf("drop login_tokens: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("close raw connection: %v", err)
	}

	st, err = store.Open(dbPath)
	if err != nil {
		t.Fatalf("reopen upgraded store: %v", err)
	}
	defer st.Close()
	svc = New(st, Config{})
	link, err := svc.IssueLoginLink(ctx, owner.ID)
	if err != nil {
		t.Fatalf("issue login link after the upgrade: %v", err)
	}
	if _, err := svc.ConsumeLoginLink(ctx, link.Token, SessionMeta{}); err != nil {
		t.Fatalf("consume login link after the upgrade: %v", err)
	}
}

func TestSessionLifecycle(t *testing.T) {
	svc, st := newTestService(t)
	ctx := context.Background()
	claimOwner(t, svc, st, "owner@example.com", "hunter2hunter2")

	session, err := svc.LoginPassword(ctx, "owner@example.com", "hunter2hunter2", SessionMeta{UserAgent: "test", IP: "127.0.0.1"})
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	if _, err := svc.Authenticate(ctx, session.Token); err != nil {
		t.Fatalf("authenticate: %v", err)
	}
	if err := svc.Logout(ctx, session.Token); err != nil {
		t.Fatalf("logout: %v", err)
	}
	if _, err := svc.Authenticate(ctx, session.Token); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("authenticate after logout = %v, want ErrNotFound", err)
	}
}

func TestAuthenticateRejectsExpiredSession(t *testing.T) {
	now := time.Now()
	svc, st := newTestService(t)
	svc.cfg.Now = func() time.Time { return now }

	ctx := context.Background()
	claimOwner(t, svc, st, "owner@example.com", "hunter2hunter2")
	session, err := svc.LoginPassword(ctx, "owner@example.com", "hunter2hunter2", SessionMeta{})
	if err != nil {
		t.Fatalf("login: %v", err)
	}

	svc.cfg.Now = func() time.Time { return now.Add(DefaultSessionTTL + time.Minute) }
	if _, err := svc.Authenticate(ctx, session.Token); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("expired session = %v, want ErrNotFound", err)
	}
}

func TestLogoutKeepsOtherSessions(t *testing.T) {
	svc, st := newTestService(t)
	ctx := context.Background()
	claimOwner(t, svc, st, "owner@example.com", "hunter2hunter2")

	first, err := svc.LoginPassword(ctx, "owner@example.com", "hunter2hunter2", SessionMeta{})
	if err != nil {
		t.Fatalf("login first: %v", err)
	}
	second, err := svc.LoginPassword(ctx, "owner@example.com", "hunter2hunter2", SessionMeta{})
	if err != nil {
		t.Fatalf("login second: %v", err)
	}
	if err := svc.Logout(ctx, first.Token); err != nil {
		t.Fatalf("logout: %v", err)
	}
	if _, err := svc.Authenticate(ctx, second.Token); err != nil {
		t.Fatalf("second session should survive: %v", err)
	}
}

func TestLoginIdentityMergesSameVerifiedEmail(t *testing.T) {
	svc, st := newTestService(t)
	ctx := context.Background()
	claimOwner(t, svc, st, "Owner@Example.com", "hunter2hunter2")

	// D3 (2026-11-04): a provider asserting the owner's own address as
	// *verified* binds the new identity to that account instead of refusing.
	// Matching normalizes case and whitespace; it never creates a second
	// account.
	session, err := svc.LoginIdentity(ctx, ExternalIdentity{
		Provider:      "oidc:https://github.com",
		Subject:       "12345",
		Email:         "  owner@example.com ",
		EmailVerified: true,
	}, SessionMeta{})
	if err != nil {
		t.Fatalf("same verified email = %v, want a session", err)
	}
	if session.User.Email != "owner@example.com" {
		t.Fatalf("session user = %q, want the owner account", session.User.Email)
	}
	count, err := st.CountUsers(ctx)
	if err != nil {
		t.Fatalf("count users: %v", err)
	}
	if count != 1 {
		t.Fatalf("user count = %d, want 1; the merge bound the identity, not a new account", count)
	}
	// The bound identity now signs in by itself.
	if _, err := svc.LoginIdentity(ctx, ExternalIdentity{
		Provider:      "oidc:https://github.com",
		Subject:       "12345",
		Email:         "owner@example.com",
		EmailVerified: true,
	}, SessionMeta{}); err != nil {
		t.Fatalf("second sign-in through the merged identity: %v", err)
	}
}

func TestLoginIdentityDoesNotMergeUnverifiedEmail(t *testing.T) {
	svc, st := newTestService(t)
	ctx := context.Background()
	claimOwner(t, svc, st, "owner@example.com", "hunter2hunter2")

	// A provider that did not verify the mailbox asserted nothing worth
	// binding an account to: the login is refused exactly as before.
	_, err := svc.LoginIdentity(ctx, ExternalIdentity{
		Provider:      "oidc:https://github.com",
		Subject:       "12345",
		Email:         "owner@example.com",
		EmailVerified: false,
	}, SessionMeta{})
	if !errors.Is(err, ErrIdentityNotLinked) {
		t.Fatalf("unverified email = %v, want ErrIdentityNotLinked", err)
	}

	count, err := st.CountUsers(ctx)
	if err != nil {
		t.Fatalf("count users: %v", err)
	}
	if count != 1 {
		t.Fatalf("user count = %d, want 1; an unverified email must not merge", count)
	}
}

func TestLoginIdentityRefusesMergeWhenTwoAccountsShareTheEmail(t *testing.T) {
	svc, st := newTestService(t)
	ctx := context.Background()
	claimOwner(t, svc, st, "owner@example.com", "hunter2hunter2")
	// Two accounts carry the same address, and the password lookup must not
	// single one of them out: the ambiguity the D3 rule answers is reached
	// through users.email, so both rows answer to it and no password identity
	// claims the address as its subject. Picking either would sign somebody
	// into the other's Hub.
	code, err := svc.IssueInvite(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.RedeemInvite(ctx, code.Code, "second@example.com", "hunter2hunter2", "", SessionMeta{}); err != nil {
		t.Fatalf("second account: %v", err)
	}
	users, err := st.ListUsers(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, u := range users {
		// Both rows answer to owner@example.com on users.email; the owner's
		// password identity moves aside so the address has no password owner.
		if _, err := st.DB().ExecContext(ctx,
			`UPDATE users SET email = ? WHERE id = ?`, "owner@example.com", u.ID); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := st.DB().ExecContext(ctx,
		`UPDATE user_identities SET subject = ? WHERE provider = ? AND subject = ?`,
		"kept@example.com", store.ProviderPassword, "owner@example.com"); err != nil {
		t.Fatal(err)
	}

	_, err = svc.LoginIdentity(ctx, ExternalIdentity{
		Provider:      "oidc:https://github.com",
		Subject:       "12345",
		Email:         "owner@example.com",
		EmailVerified: true,
	}, SessionMeta{})
	if !errors.Is(err, ErrIdentityNotLinked) {
		t.Fatalf("ambiguous email = %v, want ErrIdentityNotLinked", err)
	}

	count, err := st.CountUsers(ctx)
	if err != nil {
		t.Fatalf("count users: %v", err)
	}
	if count != 2 {
		t.Fatalf("user count = %d, want 2", count)
	}
}

func TestLoginIdentityDoesNotMergeIntoDisabledAccount(t *testing.T) {
	svc, st := newTestService(t)
	ctx := context.Background()
	claimOwner(t, svc, st, "owner@example.com", "hunter2hunter2")
	users, err := st.ListUsers(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.DB().ExecContext(ctx,
		`UPDATE users SET disabled_at = ? WHERE id = ?`, time.Now().UnixMilli(), users[0].ID); err != nil {
		t.Fatal(err)
	}

	_, err = svc.LoginIdentity(ctx, ExternalIdentity{
		Provider:      "oidc:https://github.com",
		Subject:       "12345",
		Email:         "owner@example.com",
		EmailVerified: true,
	}, SessionMeta{})
	if !errors.Is(err, ErrIdentityNotLinked) {
		t.Fatalf("disabled account = %v, want ErrIdentityNotLinked", err)
	}
}

func TestLinkIdentityThenLogin(t *testing.T) {
	svc, st := newTestService(t)
	ctx := context.Background()
	owner := claimOwner(t, svc, st, "owner@example.com", "hunter2hunter2")

	ident := ExternalIdentity{
		Provider:      "oidc:https://github.com",
		Subject:       "12345",
		Email:         "owner@example.com",
		EmailVerified: true,
		DisplayName:   "Owner",
	}
	if err := svc.LinkIdentity(ctx, owner.ID, ident); err != nil {
		t.Fatalf("link: %v", err)
	}
	// Linking twice from the same account is a no-op, not an error.
	if err := svc.LinkIdentity(ctx, owner.ID, ident); err != nil {
		t.Fatalf("relink same account: %v", err)
	}

	session, err := svc.LoginIdentity(ctx, ident, SessionMeta{})
	if err != nil {
		t.Fatalf("login via linked identity: %v", err)
	}
	if session.User.ID != owner.ID {
		t.Fatalf("linked login reached user %s, want %s", session.User.ID, owner.ID)
	}
}

// Unbind (G19: 合并后可解绑): a credential can be removed while another
// remains, the last credential cannot, and another account's credential id
// unlinks nothing.
func TestUnlinkIdentity(t *testing.T) {
	t.Run("removes one of two and keeps the other", func(t *testing.T) {
		svc, st := newTestService(t)
		ctx := context.Background()
		owner := claimOwner(t, svc, st, "owner@example.com", "hunter2hunter2")
		if err := svc.LinkIdentity(ctx, owner.ID, ExternalIdentity{
			Provider: "oidc:https://github.com", Subject: "12345",
		}); err != nil {
			t.Fatalf("link: %v", err)
		}
		ids, err := st.ListIdentities(ctx, owner.ID)
		if err != nil {
			t.Fatal(err)
		}
		if len(ids) != 2 {
			t.Fatalf("identities = %d, want 2", len(ids))
		}
		var linked string
		for _, id := range ids {
			if id.Provider != store.ProviderPassword {
				linked = id.ID
			}
		}
		if err := svc.UnlinkIdentity(ctx, owner.ID, linked); err != nil {
			t.Fatalf("unlink: %v", err)
		}
		ids, err = st.ListIdentities(ctx, owner.ID)
		if err != nil {
			t.Fatal(err)
		}
		if len(ids) != 1 || ids[0].Provider != store.ProviderPassword {
			t.Fatalf("identities after unlink = %+v, want only the password", ids)
		}
	})

	t.Run("refuses to remove the last credential", func(t *testing.T) {
		svc, st := newTestService(t)
		ctx := context.Background()
		owner := claimOwner(t, svc, st, "owner@example.com", "hunter2hunter2")
		ids, err := st.ListIdentities(ctx, owner.ID)
		if err != nil {
			t.Fatal(err)
		}
		if err := svc.UnlinkIdentity(ctx, owner.ID, ids[0].ID); !errors.Is(err, ErrLastCredential) {
			t.Fatalf("last credential = %v, want ErrLastCredential", err)
		}
		if _, err := svc.LoginPassword(ctx, "owner@example.com", "hunter2hunter2", SessionMeta{}); err != nil {
			t.Fatalf("the refused unbind broke sign-in: %v", err)
		}
	})

	t.Run("another account's id unlinks nothing", func(t *testing.T) {
		svc, st := newTestService(t)
		ctx := context.Background()
		owner := claimOwner(t, svc, st, "owner@example.com", "hunter2hunter2")
		if err := svc.LinkIdentity(ctx, owner.ID, ExternalIdentity{
			Provider: "oidc:https://github.com", Subject: "12345",
		}); err != nil {
			t.Fatalf("link: %v", err)
		}
		if err := svc.UnlinkIdentity(ctx, owner.ID, "01OTHERIDENTITY000000000000"); !errors.Is(err, store.ErrNotFound) {
			t.Fatalf("foreign id = %v, want ErrNotFound", err)
		}
		ids, err := st.ListIdentities(ctx, owner.ID)
		if err != nil {
			t.Fatal(err)
		}
		if len(ids) != 2 {
			t.Fatalf("the failed unbind changed the account: %d credentials left", len(ids))
		}
	})

	// Two devices unbind the account's two credentials at the same moment. The
	// guard lives in the delete's transaction, so exactly one of them wins and
	// the account always keeps a way in — a read-then-delete guard would let
	// both pass and strand the Hub.
	t.Run("concurrent unbinds never remove the last credential", func(t *testing.T) {
		svc, st := newTestService(t)
		ctx := context.Background()
		owner := claimOwner(t, svc, st, "owner@example.com", "hunter2hunter2")
		if err := svc.LinkIdentity(ctx, owner.ID, ExternalIdentity{
			Provider: "oidc:https://github.com", Subject: "12345",
		}); err != nil {
			t.Fatalf("link: %v", err)
		}
		ids, err := st.ListIdentities(ctx, owner.ID)
		if err != nil {
			t.Fatal(err)
		}

		start := make(chan struct{})
		var wg sync.WaitGroup
		results := make([]error, len(ids))
		for i, id := range ids {
			wg.Add(1)
			go func(i int, id string) {
				defer wg.Done()
				<-start
				results[i] = svc.UnlinkIdentity(ctx, owner.ID, id)
			}(i, id.ID)
		}
		close(start)
		wg.Wait()

		var succeeded int
		for _, err := range results {
			if err == nil {
				succeeded++
			} else if !errors.Is(err, ErrLastCredential) {
				t.Fatalf("unexpected unbind error: %v", err)
			}
		}
		if succeeded != 1 {
			t.Fatalf("%d unbinds succeeded, want exactly 1", succeeded)
		}
		left, err := st.ListIdentities(ctx, owner.ID)
		if err != nil {
			t.Fatal(err)
		}
		if len(left) != 1 {
			t.Fatalf("the concurrent unbinds left %d credentials, want 1", len(left))
		}
		// Which credential survives is whichever delete lost the race — the
		// guard keeps one way in, not one particular way. The sign-in check
		// must ask for the one that is actually there: the federated row signs
		// in through LoginIdentity, the password row through LoginPassword.
		if left[0].Provider == store.ProviderPassword {
			if _, err := svc.LoginPassword(ctx, "owner@example.com", "hunter2hunter2", SessionMeta{}); err != nil {
				t.Fatalf("the account can no longer sign in after two concurrent unbinds: %v", err)
			}
		} else {
			if _, err := svc.LoginIdentity(ctx, ExternalIdentity{
				Provider: left[0].Provider, Subject: "12345",
			}, SessionMeta{}); err != nil {
				t.Fatalf("the account can no longer sign in after two concurrent unbinds: %v", err)
			}
		}
	})
}

// The merge notification (G19: 合并后 24h 内通知设备) fires exactly on the
// merge path — a verified email that resolved to an existing account — and not
// on a plain sign-in or a fresh account.
func TestMergeByEmailNotifiesOnce(t *testing.T) {
	type mergeEvent struct{ userID, provider, label string }
	var merges []mergeEvent
	svc, st := newTestService(t)
	svc.cfg.OnMergedByEmail = func(userID, provider, label string) {
		merges = append(merges, mergeEvent{userID, provider, label})
	}
	ctx := context.Background()
	owner := claimOwner(t, svc, st, "owner@example.com", "hunter2hunter2")

	ident := ExternalIdentity{
		Provider: "oidc:https://github.com", Subject: "12345",
		Email: "owner@example.com", EmailVerified: true,
		DisplayName: "Owner",
	}
	session, err := svc.LoginIdentity(ctx, ident, SessionMeta{})
	if err != nil {
		t.Fatalf("merge login: %v", err)
	}
	if session.User.ID != owner.ID {
		t.Fatalf("merged into %s, want %s", session.User.ID, owner.ID)
	}
	if len(merges) != 1 || merges[0].userID != owner.ID {
		t.Fatalf("merge notifications = %+v, want exactly one for %s", merges, owner.ID)
	}

	// The second sign-in goes through the existing identity: no merge, no
	// second notification.
	if _, err := svc.LoginIdentity(ctx, ident, SessionMeta{}); err != nil {
		t.Fatalf("second login: %v", err)
	}
	if len(merges) != 1 {
		t.Fatalf("a plain sign-in notified again: %+v", merges)
	}
}

func TestLinkIdentityRejectsIdentityOwnedByAnotherAccount(t *testing.T) {
	svc, st := newTestService(t)
	ctx := context.Background()
	owner := claimOwner(t, svc, st, "owner@example.com", "hunter2hunter2")

	ident := ExternalIdentity{Provider: "oidc:https://github.com", Subject: "12345"}
	if err := svc.LinkIdentity(ctx, owner.ID, ident); err != nil {
		t.Fatalf("link: %v", err)
	}

	other := store.User{ID: "01OTHERUSER0000000000000000", CreatedAt: time.Now().UnixMilli()}
	if err := st.CreateUserWithIdentity(ctx, other, store.UserIdentity{
		ID: "01OTHERIDENTITY000000000000", UserID: other.ID,
		Provider: store.ProviderPassword, Subject: "other@example.com",
		CreatedAt: time.Now().UnixMilli(),
	}); err != nil {
		t.Fatalf("create second user: %v", err)
	}
	if err := svc.LinkIdentity(ctx, other.ID, ident); !errors.Is(err, ErrIdentityTaken) {
		t.Fatalf("steal identity = %v, want ErrIdentityTaken", err)
	}
}

func TestLoginIdentityRejectsEmptySubject(t *testing.T) {
	svc, _ := newTestService(t)
	_, err := svc.LoginIdentity(context.Background(), ExternalIdentity{
		Provider: "oidc:https://example.com",
	}, SessionMeta{})
	if err == nil {
		t.Fatal("empty subject was accepted; every provider user would collapse into one identity")
	}
}

func TestPruneSessions(t *testing.T) {
	now := time.Now()
	svc, st := newTestService(t)
	svc.cfg.Now = func() time.Time { return now }
	ctx := context.Background()
	claimOwner(t, svc, st, "owner@example.com", "hunter2hunter2")

	if _, err := svc.LoginPassword(ctx, "owner@example.com", "hunter2hunter2", SessionMeta{}); err != nil {
		t.Fatalf("login: %v", err)
	}
	svc.cfg.Now = func() time.Time { return now.Add(DefaultSessionTTL + time.Hour) }
	removed, err := svc.PruneSessions(ctx)
	if err != nil {
		t.Fatalf("prune: %v", err)
	}
	// Two sessions exist: the one the bootstrap claim opened, and this login.
	if removed != 2 {
		t.Fatalf("pruned %d sessions, want 2", removed)
	}
	if remaining, err := svc.PruneSessions(ctx); err != nil {
		t.Fatalf("second prune: %v", err)
	} else if remaining != 0 {
		t.Fatalf("second prune removed %d, want 0", remaining)
	}
}

// The per-account session cap (D13/G6/T7: ≤20 个设备会话) is enforced at
// sign-in: session 21 evicts the account's oldest session, not the one being
// opened, and every sign-in still succeeds.
func TestSessionCapEvictsTheOldestSignIn(t *testing.T) {
	now := time.Now()
	svc, st := newTestService(t)
	svc.cfg.Now = func() time.Time { return now }
	ctx := context.Background()
	claimOwner(t, svc, st, "owner@example.com", "hunter2hunter2")

	tokens := make([]string, 0, maxSessionsPerUser+1)
	for i := 0; i <= maxSessionsPerUser; i++ {
		session, err := svc.LoginPassword(ctx, "owner@example.com", "hunter2hunter2", SessionMeta{})
		if err != nil {
			t.Fatalf("login %d: %v", i+1, err)
		}
		tokens = append(tokens, session.Token)
	}
	// The claim session was opened first, so it is the one that had to go; the
	// newest sign-in is the one that just opened.
	if _, err := svc.Authenticate(ctx, tokens[0]); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("the oldest session survived the cap: %v", err)
	}
	if _, err := svc.Authenticate(ctx, tokens[maxSessionsPerUser]); err != nil {
		t.Fatalf("the newest sign-in was refused: %v", err)
	}
	if _, err := svc.Authenticate(ctx, tokens[1]); err != nil {
		t.Fatalf("the second-oldest session was evicted with the cap at %d: %v", maxSessionsPerUser, err)
	}
}

func claimOwner(t *testing.T, svc *Service, st *store.Store, email, password string) store.User {
	t.Helper()
	ctx := context.Background()
	needs, err := svc.NeedsBootstrap(ctx)
	if err != nil {
		t.Fatalf("needs bootstrap: %v", err)
	}
	if !needs {
		t.Fatal("test expected an unclaimed hub")
	}
	code, err := svc.IssueBootstrapCode(ctx)
	if err != nil {
		t.Fatalf("issue code: %v", err)
	}
	session, err := svc.ClaimWithPassword(ctx, code, email, password, "Owner", SessionMeta{})
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	return session.User
}

func TestResetPassword(t *testing.T) {
	svc, st := newTestService(t)
	ctx := context.Background()
	claimOwner(t, svc, st, "Owner@Example.com", "original-password")

	session, err := svc.LoginPassword(ctx, "owner@example.com", "original-password", SessionMeta{})
	if err != nil {
		t.Fatalf("login before reset: %v", err)
	}

	t.Run("replaces the credential and ends live sessions", func(t *testing.T) {
		user, err := svc.ResetPassword(ctx, "  Owner@EXAMPLE.com  ", "replacement-password")
		if err != nil {
			t.Fatalf("reset: %v", err)
		}
		if user.Email != "owner@example.com" {
			t.Fatalf("email = %q, want the normalized owner@example.com", user.Email)
		}

		if _, err := svc.LoginPassword(ctx, "owner@example.com", "original-password", SessionMeta{}); !errors.Is(err, ErrInvalidCredentials) {
			t.Fatalf("old password after reset = %v, want ErrInvalidCredentials", err)
		}
		if _, err := svc.LoginPassword(ctx, "owner@example.com", "replacement-password", SessionMeta{}); err != nil {
			t.Fatalf("new password after reset: %v", err)
		}
		// The session was opened with the retired credential, so it goes too.
		if _, err := svc.Authenticate(ctx, session.Token); !errors.Is(err, store.ErrNotFound) {
			t.Fatalf("session after reset = %v, want ErrNotFound", err)
		}
	})

	t.Run("refuses an unknown address without creating an account", func(t *testing.T) {
		if _, err := svc.ResetPassword(ctx, "nobody@example.com", "replacement-password"); !errors.Is(err, ErrAccountNotFound) {
			t.Fatalf("unknown address = %v, want ErrAccountNotFound", err)
		}
		users, err := st.ListUsers(ctx)
		if err != nil {
			t.Fatalf("list users: %v", err)
		}
		if len(users) != 1 {
			t.Fatalf("users after failed reset = %d, want 1", len(users))
		}
	})

	t.Run("refuses a short password", func(t *testing.T) {
		if _, err := svc.ResetPassword(ctx, "owner@example.com", "short"); !errors.Is(err, ErrWeakPassword) {
			t.Fatalf("short password = %v, want ErrWeakPassword", err)
		}
	})

	// A federated account has no password to replace. Minting one here would
	// quietly add a credential the owner of that identity never asked for, so
	// the command says the account does not exist rather than doing something
	// surprising to it.
	t.Run("refuses an account with no password identity", func(t *testing.T) {
		user := store.User{ID: "01FEDERATEDUSER000000000000", Email: "fed@example.com", CreatedAt: 1}
		if err := st.CreateUserWithIdentity(ctx, user, store.UserIdentity{
			ID: "01FEDERATEDIDENTITY0000000", UserID: user.ID,
			Provider: "oidc:https://id.example.com", Subject: "subject-1",
			CreatedAt: 1,
		}); err != nil {
			t.Fatalf("create federated account: %v", err)
		}
		if _, err := svc.ResetPassword(ctx, "fed@example.com", "replacement-password"); !errors.Is(err, ErrAccountNotFound) {
			t.Fatalf("federated account = %v, want ErrAccountNotFound", err)
		}
		if _, _, err := st.UserByIdentity(ctx, store.ProviderPassword, "fed@example.com"); !errors.Is(err, store.ErrNotFound) {
			t.Fatalf("a password identity was created anyway: %v", err)
		}
	})
}

func TestNewPasswordIsGroupedAndUnambiguous(t *testing.T) {
	password, err := NewPassword()
	if err != nil {
		t.Fatalf("generate password: %v", err)
	}
	if len(password) != 23 {
		t.Fatalf("password %q is %d chars, want 23 (four groups of five plus separators)", password, len(password))
	}
	for i, r := range password {
		if (i+1)%6 == 0 {
			if r != '-' {
				t.Fatalf("password %q has %q at separator position %d", password, r, i)
			}
			continue
		}
		if !strings.ContainsRune(bootstrapAlphabet, r) {
			t.Fatalf("password %q contains %q, which is not in the unambiguous alphabet", password, r)
		}
	}
	other, err := NewPassword()
	if err != nil {
		t.Fatalf("generate second password: %v", err)
	}
	if password == other {
		t.Fatal("two generated passwords are identical")
	}
}
