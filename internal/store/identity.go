package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// ProviderPassword is the provider name for a locally-stored password identity.
// The subject is the normalized login address, so uniqueness of the login path
// lives here rather than on users.email.
const ProviderPassword = "password"

// Roles an account can hold on this daemon.
//
// RoleOwner is the account that claimed the Hub. It is the only role that may
// administer the daemon, which is what makes the operator check a role test
// rather than a "is signed in" test (ADR 0026). RoleMember is any account that
// registered afterwards; members drive tasks but cannot reconfigure the daemon
// they are talking to.
const (
	RoleOwner  = "owner"
	RoleMember = "member"
)

// User is an account. ID is the stable key for everything that references an
// account. Email is display/contact data and is deliberately not unique: two
// accounts may legitimately carry the same address, and nothing merges them.
type User struct {
	ID            string
	Email         string
	EmailVerified bool
	EmailSource   string
	DisplayName   string
	Role          string
	CreatedAt     int64
	DisabledAt    *int64
}

// IsOwner reports whether this account administers the daemon. An empty role
// reads as not-owner: a row that somehow lost its role must fail closed rather
// than inherit the claim the column exists to record.
func (u User) IsOwner() bool {
	return u.Role == RoleOwner
}

// UserIdentity is one login credential attached to an account. A user may have
// several, which is what lets a password login and a GitHub login reach the
// same account without either side trusting an email address.
type UserIdentity struct {
	ID         string
	UserID     string
	Provider   string
	Subject    string
	SecretHash string
	Label      string
	CreatedAt  int64
	LastUsedAt *int64
}

// AuthSession is a browser login session. TokenHash is never returned to
// clients; the raw token only ever exists in the cookie.
type AuthSession struct {
	ID         string
	TokenHash  string
	UserID     string
	CreatedAt  int64
	ExpiresAt  int64
	LastSeenAt *int64
	UserAgent  string
	IP         string
}

// CreateUserWithIdentity atomically creates an account and its first login
// credential. Partial success would strand an unreachable account, so both
// writes share one transaction.
func (s *Store) CreateUserWithIdentity(ctx context.Context, user User, identity UserIdentity) error {
	if strings.TrimSpace(user.ID) == "" || user.CreatedAt <= 0 {
		return fmt.Errorf("invalid user")
	}
	if identity.UserID != user.ID || identity.Provider == "" || identity.Subject == "" {
		return fmt.Errorf("invalid identity for user")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin create user: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO users (id, email, email_verified, email_source, display_name, role, created_at, disabled_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		user.ID, user.Email, boolToInt(user.EmailVerified), user.EmailSource,
		user.DisplayName, normalizeRole(user.Role), user.CreatedAt, user.DisabledAt); err != nil {
		return fmt.Errorf("insert user: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO user_identities (id, user_id, provider, subject, secret_hash, label, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		identity.ID, identity.UserID, identity.Provider, identity.Subject,
		identity.SecretHash, identity.Label, identity.CreatedAt); err != nil {
		return fmt.Errorf("insert identity: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit create user: %w", err)
	}
	return nil
}

// AddIdentity attaches another login credential to an existing account.
func (s *Store) AddIdentity(ctx context.Context, identity UserIdentity) error {
	if identity.ID == "" || identity.UserID == "" || identity.Provider == "" || identity.Subject == "" {
		return fmt.Errorf("invalid identity")
	}
	if _, err := s.db.ExecContext(ctx, `
		INSERT INTO user_identities (id, user_id, provider, subject, secret_hash, label, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		identity.ID, identity.UserID, identity.Provider, identity.Subject,
		identity.SecretHash, identity.Label, identity.CreatedAt); err != nil {
		return fmt.Errorf("add identity: %w", err)
	}
	return nil
}

// GetUser returns an account by id.
func (s *Store) GetUser(ctx context.Context, id string) (User, error) {
	return scanUser(s.db.QueryRowContext(ctx, `
		SELECT id, email, email_verified, email_source, display_name, role, created_at, disabled_at
		FROM users WHERE id = ?`, id))
}

// UserByIdentity resolves a login credential to its account. This is the only
// supported way to go from "someone authenticated" to "which account" — never
// by matching an email address.
func (s *Store) UserByIdentity(ctx context.Context, provider, subject string) (User, UserIdentity, error) {
	var identity UserIdentity
	var lastUsed sql.NullInt64
	err := s.db.QueryRowContext(ctx, `
		SELECT id, user_id, provider, subject, secret_hash, label, created_at, last_used_at
		FROM user_identities WHERE provider = ? AND subject = ?`, provider, subject).
		Scan(&identity.ID, &identity.UserID, &identity.Provider, &identity.Subject,
			&identity.SecretHash, &identity.Label, &identity.CreatedAt, &lastUsed)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, UserIdentity{}, ErrNotFound
	}
	if err != nil {
		return User{}, UserIdentity{}, fmt.Errorf("read identity: %w", err)
	}
	if lastUsed.Valid {
		identity.LastUsedAt = &lastUsed.Int64
	}
	user, err := s.GetUser(ctx, identity.UserID)
	if err != nil {
		return User{}, UserIdentity{}, err
	}
	return user, identity, nil
}

// ListIdentities returns every login credential attached to an account.
func (s *Store) ListIdentities(ctx context.Context, userID string) ([]UserIdentity, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, user_id, provider, subject, label, created_at, last_used_at
		FROM user_identities WHERE user_id = ? ORDER BY created_at`, userID)
	if err != nil {
		return nil, fmt.Errorf("list identities: %w", err)
	}
	defer rows.Close()

	var out []UserIdentity
	for rows.Next() {
		var identity UserIdentity
		var lastUsed sql.NullInt64
		if err := rows.Scan(&identity.ID, &identity.UserID, &identity.Provider,
			&identity.Subject, &identity.Label, &identity.CreatedAt, &lastUsed); err != nil {
			return nil, fmt.Errorf("scan identity: %w", err)
		}
		if lastUsed.Valid {
			identity.LastUsedAt = &lastUsed.Int64
		}
		out = append(out, identity)
	}
	return out, rows.Err()
}

// TouchIdentity records a successful login on the credential that was used.
func (s *Store) TouchIdentity(ctx context.Context, id string, now int64) error {
	if _, err := s.db.ExecContext(ctx,
		`UPDATE user_identities SET last_used_at = ? WHERE id = ?`, now, id); err != nil {
		return fmt.Errorf("touch identity: %w", err)
	}
	return nil
}

// MarkEmailVerified records that a provider has since verified the account's
// address, and which provider vouched for it. It deliberately cannot change the
// address itself: the account's email is not a key, and rewriting it from a
// provider response would let a provider silently re-point the account.
func (s *Store) MarkEmailVerified(ctx context.Context, userID, source string) error {
	if _, err := s.db.ExecContext(ctx,
		`UPDATE users SET email_verified = 1, email_source = ? WHERE id = ?`, source, userID); err != nil {
		return fmt.Errorf("mark email verified: %w", err)
	}
	return nil
}

// CountUsers reports how many accounts exist. Zero means the Hub is unclaimed,
// which is the only state in which bootstrap is accepted.
func (s *Store) CountUsers(ctx context.Context) (int, error) {
	var n int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&n); err != nil {
		return 0, fmt.Errorf("count users: %w", err)
	}
	return n, nil
}

// CreateAuthSession stores a browser session by token hash.
func (s *Store) CreateAuthSession(ctx context.Context, session AuthSession) error {
	if session.ID == "" || session.TokenHash == "" || session.UserID == "" ||
		session.CreatedAt <= 0 || session.ExpiresAt <= session.CreatedAt {
		return fmt.Errorf("invalid auth session")
	}
	if _, err := s.db.ExecContext(ctx, `
		INSERT INTO auth_sessions (id, token_hash, user_id, created_at, expires_at, user_agent, ip)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		session.ID, session.TokenHash, session.UserID, session.CreatedAt,
		session.ExpiresAt, session.UserAgent, session.IP); err != nil {
		return fmt.Errorf("create auth session: %w", err)
	}
	return nil
}

// AuthenticateSession resolves a session cookie to its account, rejecting
// expired rows and disabled accounts. Last-seen is refreshed at most once per
// hour so a busy console does not turn every request into a write.
func (s *Store) AuthenticateSession(ctx context.Context, tokenHash string, now int64) (AuthSession, User, error) {
	var session AuthSession
	var lastSeen sql.NullInt64
	err := s.db.QueryRowContext(ctx, `
		SELECT id, token_hash, user_id, created_at, expires_at, last_seen_at, user_agent, ip
		FROM auth_sessions WHERE token_hash = ?`, tokenHash).
		Scan(&session.ID, &session.TokenHash, &session.UserID, &session.CreatedAt,
			&session.ExpiresAt, &lastSeen, &session.UserAgent, &session.IP)
	if errors.Is(err, sql.ErrNoRows) {
		return AuthSession{}, User{}, ErrNotFound
	}
	if err != nil {
		return AuthSession{}, User{}, fmt.Errorf("read auth session: %w", err)
	}
	if session.ExpiresAt <= now {
		return AuthSession{}, User{}, ErrNotFound
	}
	if lastSeen.Valid {
		session.LastSeenAt = &lastSeen.Int64
	}
	user, err := s.GetUser(ctx, session.UserID)
	if err != nil {
		return AuthSession{}, User{}, err
	}
	if user.DisabledAt != nil {
		return AuthSession{}, User{}, ErrNotFound
	}
	if !lastSeen.Valid || now-lastSeen.Int64 > authSessionTouchInterval {
		if _, err := s.db.ExecContext(ctx,
			`UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?`, now, session.ID); err != nil {
			return AuthSession{}, User{}, fmt.Errorf("touch auth session: %w", err)
		}
	}
	return session, user, nil
}

// authSessionTouchInterval bounds last-seen writes to once per hour per session.
const authSessionTouchInterval = int64(60 * 60 * 1000)

// DeleteAuthSession revokes one session by token hash (logout).
func (s *Store) DeleteAuthSession(ctx context.Context, tokenHash string) error {
	if _, err := s.db.ExecContext(ctx,
		`DELETE FROM auth_sessions WHERE token_hash = ?`, tokenHash); err != nil {
		return fmt.Errorf("delete auth session: %w", err)
	}
	return nil
}

// DeleteUserAuthSessions revokes every session for an account, keeping one
// optional session alive (the caller's own) so a password change does not log
// the actor out of the page they are standing on.
func (s *Store) DeleteUserAuthSessions(ctx context.Context, userID, keepTokenHash string) (int64, error) {
	res, err := s.db.ExecContext(ctx,
		`DELETE FROM auth_sessions WHERE user_id = ? AND token_hash <> ?`, userID, keepTokenHash)
	if err != nil {
		return 0, fmt.Errorf("delete user auth sessions: %w", err)
	}
	n, _ := res.RowsAffected()
	return n, nil
}

// PruneAuthSessions deletes expired rows and reports how many were removed.
func (s *Store) PruneAuthSessions(ctx context.Context, now int64) (int64, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM auth_sessions WHERE expires_at <= ?`, now)
	if err != nil {
		return 0, fmt.Errorf("prune auth sessions: %w", err)
	}
	n, _ := res.RowsAffected()
	return n, nil
}

// IssueBootstrapToken stores the one-time owner-claim secret by hash. Any
// earlier unused token is consumed first: issuing a new code must make the old
// one stop working, otherwise a leaked log line stays valid forever.
func (s *Store) IssueBootstrapToken(ctx context.Context, tokenHash string, now, expiresAt int64) error {
	if tokenHash == "" || expiresAt <= now {
		return fmt.Errorf("invalid bootstrap token")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin issue bootstrap token: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx,
		`UPDATE bootstrap_tokens SET used_at = ? WHERE used_at IS NULL`, now); err != nil {
		return fmt.Errorf("invalidate bootstrap tokens: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO bootstrap_tokens (token_hash, created_at, expires_at) VALUES (?, ?, ?)`,
		tokenHash, now, expiresAt); err != nil {
		return fmt.Errorf("insert bootstrap token: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit issue bootstrap token: %w", err)
	}
	return nil
}

// IssueInviteToken stores a one-time invitation by hash.
//
// Unlike IssueBootstrapToken this does not invalidate what came before it. An
// owner hands these out one per person, and revoking everyone else's because a
// new one was minted would make the second invitation break the first.
func (s *Store) IssueInviteToken(ctx context.Context, tokenHash string, now, expiresAt int64) error {
	if tokenHash == "" || expiresAt <= now {
		return fmt.Errorf("invalid invite token")
	}
	if _, err := s.db.ExecContext(ctx,
		`INSERT INTO invite_tokens (token_hash, created_at, expires_at) VALUES (?, ?, ?)`,
		tokenHash, now, expiresAt); err != nil {
		return fmt.Errorf("insert invite token: %w", err)
	}
	return nil
}

// ConsumeInviteToken atomically spends an invitation. It returns ErrNotFound
// for unknown, expired, or already-used tokens so callers cannot distinguish
// them.
//
// Single use is enforced twice -- the read refuses a row that already carries a
// used_at, and the UPDATE only matches a row that does not -- and each alone is
// enough, which is deliberate rather than leftover. The read is the same shape
// ConsumeBootstrapToken uses; the conditional UPDATE is what still holds if the
// read and the write ever stop being one transaction, which is what the pool
// being capped at one connection quietly guarantees today. Neither is dead: a
// mutation that removes both is the only one the test notices, and that is the
// point at which the behaviour is genuinely gone.
func (s *Store) ConsumeInviteToken(ctx context.Context, tokenHash string, now int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin consume invite token: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var expiresAt int64
	var usedAt sql.NullInt64
	err = tx.QueryRowContext(ctx,
		`SELECT expires_at, used_at FROM invite_tokens WHERE token_hash = ?`, tokenHash).
		Scan(&expiresAt, &usedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("read invite token: %w", err)
	}
	if usedAt.Valid || expiresAt <= now {
		return ErrNotFound
	}
	res, err := tx.ExecContext(ctx,
		`UPDATE invite_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL`,
		now, tokenHash)
	if err != nil {
		return fmt.Errorf("consume invite token: %w", err)
	}
	// The row was read unspent a moment ago inside this transaction, so a zero
	// here means something outside it spent the same code in between. Reporting
	// that as "not found" is the same answer an already-used code gets, which is
	// the point: the caller must not be able to tell the two apart.
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit consume invite token: %w", err)
	}
	return nil
}

// ConsumeBootstrapToken atomically spends a bootstrap code. It returns
// ErrNotFound for unknown, expired, or already-used codes so callers cannot
// distinguish them.
func (s *Store) ConsumeBootstrapToken(ctx context.Context, tokenHash string, now int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin consume bootstrap token: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var expiresAt int64
	var usedAt sql.NullInt64
	err = tx.QueryRowContext(ctx,
		`SELECT expires_at, used_at FROM bootstrap_tokens WHERE token_hash = ?`, tokenHash).
		Scan(&expiresAt, &usedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("read bootstrap token: %w", err)
	}
	if usedAt.Valid || expiresAt <= now {
		return ErrNotFound
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE bootstrap_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL`,
		now, tokenHash); err != nil {
		return fmt.Errorf("consume bootstrap token: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit consume bootstrap token: %w", err)
	}
	return nil
}

// HasActiveBootstrapToken reports whether an unspent, unexpired code exists.
// The Hub uses it to decide between "claim me" and "log in".
func (s *Store) HasActiveBootstrapToken(ctx context.Context, now int64) (bool, error) {
	var n int
	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM bootstrap_tokens WHERE used_at IS NULL AND expires_at > ?`, now).Scan(&n)
	if err != nil {
		return false, fmt.Errorf("count bootstrap tokens: %w", err)
	}
	return n > 0, nil
}

func scanUser(row *sql.Row) (User, error) {
	var user User
	var verified int
	var disabled sql.NullInt64
	err := row.Scan(&user.ID, &user.Email, &verified, &user.EmailSource,
		&user.DisplayName, &user.Role, &user.CreatedAt, &disabled)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, ErrNotFound
	}
	if err != nil {
		return User{}, fmt.Errorf("read user: %w", err)
	}
	user.EmailVerified = verified != 0
	user.Role = normalizeRole(user.Role)
	if disabled.Valid {
		user.DisabledAt = &disabled.Int64
	}
	return user, nil
}

// normalizeRole maps anything unrecognized onto RoleMember. The column is the
// authority on who administers the daemon, so an unexpected value has to read as
// the unprivileged role rather than propagate.
func normalizeRole(role string) string {
	if strings.TrimSpace(role) == RoleOwner {
		return RoleOwner
	}
	return RoleMember
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
