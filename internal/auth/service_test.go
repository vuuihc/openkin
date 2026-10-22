package auth

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
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

func TestLoginIdentityRefusesUnlinkedIdentityOnClaimedHub(t *testing.T) {
	svc, st := newTestService(t)
	ctx := context.Background()
	claimOwner(t, svc, st, "owner@example.com", "hunter2hunter2")

	// The provider asserts the owner's own verified address. That must still not
	// be enough: matching on email is exactly the merge this model forbids.
	_, err := svc.LoginIdentity(ctx, ExternalIdentity{
		Provider:      "oidc:https://github.com",
		Subject:       "12345",
		Email:         "owner@example.com",
		EmailVerified: true,
	}, SessionMeta{})
	if !errors.Is(err, ErrRegistrationClosed) {
		t.Fatalf("unlinked identity = %v, want ErrRegistrationClosed", err)
	}

	count, err := st.CountUsers(ctx)
	if err != nil {
		t.Fatalf("count users: %v", err)
	}
	if count != 1 {
		t.Fatalf("user count = %d, want 1; an unlinked login created an account", count)
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
