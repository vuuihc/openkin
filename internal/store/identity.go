package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
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

// OwnerAccountID returns the account that claimed this node, or "" when the
// node has no accounts (the token-only local mode). Node-wide events — a
// routine disabling itself, a worker going offline — are the operator's, and
// this is how the notifier names them without a task to look up.
func (s *Store) OwnerAccountID(ctx context.Context) (string, error) {
	var id string
	err := s.db.QueryRowContext(ctx,
		`SELECT id FROM users WHERE role = ? ORDER BY created_at, id LIMIT 1`,
		RoleOwner).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("owner account: %w", err)
	}
	return id, nil
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
	// Renewed reports that this authentication slid ExpiresAt and wrote it.
	// It is a property of the call, not of the row: callers that hand the
	// expiry to a client (the session cookie) use it to know whether the
	// client's copy is now stale.
	Renewed bool
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

// DeleteUserIdentity removes one login credential from an account, scoped to
// that account: an id guessed from another account's screen unlinks nothing.
// ErrNotFound covers both a wrong id and a wrong account, because the two are
// indistinguishable to the caller and neither changed anything.
//
// The last-credential guard lives in the delete's own transaction, not in the
// caller's snapshot: two concurrent unbinds of an account's two credentials
// would each see "two, safe" and both delete, leaving an account with no way
// to sign in and no bootstrap path back. The count is re-checked in the same
// write that removes the row, so one of the two unbinds loses instead.
func (s *Store) DeleteUserIdentity(ctx context.Context, userID, identityID string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("delete user identity: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	res, err := tx.ExecContext(ctx, `
		DELETE FROM user_identities
		WHERE id = ? AND user_id = ?
		  AND (SELECT COUNT(*) FROM user_identities WHERE user_id = ?) > 1`,
		identityID, userID, userID)
	if err != nil {
		return fmt.Errorf("delete user identity: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		// The two reasons a row survives are indistinguishable to the caller
		// and neither changed anything: the id is not this account's, or it is
		// the last credential the account holds.
		return ErrNotFound
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("delete user identity: %w", err)
	}
	return nil
}

// ReplacePasswordAndEndSessions swaps one password credential and ends every
// session and unspent sign-in link that account holds, in one transaction.
//
// The writes are one act. Landing the new hash but failing to end the sessions
// leaves the retired credential working; ending them but failing to land the
// hash leaves an account whose password nobody knows; and retiring neither the
// sessions nor the links leaves a reset that did not reset. All of it under one
// commit means the CLI can print the new password only after the reset is real,
// and that a contention failure is a failure the operator sees and retries
// rather than a half-applied one.
//
// It takes the identity and its account together so a mismatched pair updates
// nothing. The old secret is not required: whoever runs this already holds the
// database.
func (s *Store) ReplacePasswordAndEndSessions(ctx context.Context, identityID, userID, secret string, now int64) error {
	if strings.TrimSpace(identityID) == "" || strings.TrimSpace(userID) == "" {
		return fmt.Errorf("invalid password reset")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin password reset: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	res, err := tx.ExecContext(ctx,
		`UPDATE user_identities SET secret_hash = ? WHERE id = ? AND user_id = ?`,
		secret, identityID, userID)
	if err != nil {
		return fmt.Errorf("set identity secret: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("set identity secret: %w", err)
	}
	if n == 0 {
		return ErrNotFound
	}
	// A password reset ends every login this account holds, so the phones
	// registered through those logins end with it. Leaving the rows would keep
	// a lost phone listed and testable even though its session is gone.
	if _, err := tx.ExecContext(ctx, `
		DELETE FROM push_devices
		WHERE owner_session_id <> ''
		  AND owner_session_id IN (SELECT id FROM auth_sessions WHERE user_id = ?)`,
		userID); err != nil {
		return fmt.Errorf("end password reset push devices: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM auth_sessions WHERE user_id = ?`, userID); err != nil {
		return fmt.Errorf("end auth sessions: %w", err)
	}
	// An unspent sign-in link is a bearer credential too. A reset is what an
	// operator runs when one leaked, so leaving the link live would leave the
	// attacker a way back in that the reset appeared to close.
	if _, err := tx.ExecContext(ctx,
		`UPDATE login_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL`,
		now, userID); err != nil {
		return fmt.Errorf("retire login tokens: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit password reset: %w", err)
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

// ListUsers returns every account, oldest first. It exists for the operator's
// command line, not for an HTTP surface: the Hub deliberately has no user
// directory, and a member must not be able to enumerate the other accounts.
func (s *Store) ListUsers(ctx context.Context) ([]User, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, email, email_verified, email_source, display_name, role, created_at, disabled_at
		FROM users ORDER BY created_at`)
	if err != nil {
		return nil, fmt.Errorf("list users: %w", err)
	}
	defer rows.Close()
	var users []User
	for rows.Next() {
		user, err := scanUser(rows)
		if err != nil {
			return nil, err
		}
		users = append(users, user)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list users: %w", err)
	}
	return users, nil
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
//
// slidingTTL is the account system's session lifetime, applied as a sliding
// window (D13): a session that is used gets its expiry re-anchored on the last
// use, so daily use keeps it alive well past created_at + slidingTTL — but no
// renewal crosses the absolute ceiling, and a session never used within its
// window dies on schedule. The renewal is written, not just computed: the
// pruner sweeps on expires_at, so an expiry that only existed in read logic
// would get sessions deleted while they were still in use.
func (s *Store) AuthenticateSession(ctx context.Context, tokenHash string, now, slidingTTL int64) (AuthSession, User, error) {
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
	if lastSeen.Valid {
		session.LastSeenAt = &lastSeen.Int64
	}
	// A session that has been used lives from its last use; one that never was
	// lives from its creation. Either way the absolute ceiling ends it.
	effectiveExpiry := session.ExpiresAt
	if lastSeen.Valid && lastSeen.Int64 > session.CreatedAt {
		effectiveExpiry = lastSeen.Int64 + slidingTTL
	}
	if effectiveExpiry <= now || session.CreatedAt+AuthSessionAbsoluteTTL <= now {
		return AuthSession{}, User{}, ErrNotFound
	}
	user, err := s.GetUser(ctx, session.UserID)
	if err != nil {
		return AuthSession{}, User{}, err
	}
	if user.DisabledAt != nil {
		return AuthSession{}, User{}, ErrNotFound
	}
	if !lastSeen.Valid || now-lastSeen.Int64 > authSessionTouchInterval {
		// The renewal rides the same write as the last-seen touch, and the new
		// expiry is clamped to the absolute ceiling: a session first opened 179
		// days ago gets the one day it has left, not another sliding window.
		newExpiry := now + slidingTTL
		if ceiling := session.CreatedAt + AuthSessionAbsoluteTTL; newExpiry > ceiling {
			newExpiry = ceiling
		}
		if _, err := s.db.ExecContext(ctx,
			`UPDATE auth_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?`,
			now, newExpiry, session.ID); err != nil {
			return AuthSession{}, User{}, fmt.Errorf("touch auth session: %w", err)
		}
		session.ExpiresAt = newExpiry
		session.Renewed = true
	}
	return session, user, nil
}

// authSessionTouchInterval bounds last-seen writes to once per hour per session.
const authSessionTouchInterval = int64(60 * 60 * 1000)

// DeleteAuthSession revokes one session by token hash (logout).
//
// The push registrations made from that session go with it. They are deleted by
// subquery before the session row, because once the row is gone there is
// nothing left to match them to — and a phone showing the sign-in screen must
// not keep ringing with the account that just left.
func (s *Store) DeleteAuthSession(ctx context.Context, tokenHash string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("delete auth session: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
		DELETE FROM push_devices
		WHERE owner_session_id <> ''
		  AND owner_session_id IN (SELECT id FROM auth_sessions WHERE token_hash = ?)`,
		tokenHash); err != nil {
		return fmt.Errorf("delete session push devices: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM auth_sessions WHERE token_hash = ?`, tokenHash); err != nil {
		return fmt.Errorf("delete auth session: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("delete auth session: %w", err)
	}
	return nil
}

// DeleteUserAuthSessions revokes every session for an account, keeping one
// optional session alive (the caller's own) so a password change does not log
// the actor out of the page they are standing on. Registrations bound to a
// revoked session are removed with it.
func (s *Store) DeleteUserAuthSessions(ctx context.Context, userID, keepTokenHash string) (int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("delete user auth sessions: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
		DELETE FROM push_devices
		WHERE owner_session_id <> ''
		  AND owner_session_id IN (
			SELECT id FROM auth_sessions WHERE user_id = ? AND token_hash <> ?
		  )`, userID, keepTokenHash); err != nil {
		return 0, fmt.Errorf("delete user session push devices: %w", err)
	}
	res, err := tx.ExecContext(ctx,
		`DELETE FROM auth_sessions WHERE user_id = ? AND token_hash <> ?`, userID, keepTokenHash)
	if err != nil {
		return 0, fmt.Errorf("delete user auth sessions: %w", err)
	}
	n, _ := res.RowsAffected()
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("delete user auth sessions: %w", err)
	}
	return n, nil
}

// AuthSessionAbsoluteTTL is the hard ceiling on a browser session's life, no
// matter how often it is used. The sliding window (created_at + SessionTTL, or
// last_seen_at + SessionTTL once the session has been used) answers "is this
// login still active"; the absolute ceiling answers "should one credential
// live forever". Together they are D13: 滑动 30 天、绝对 180 天.
const AuthSessionAbsoluteTTL = int64(180 * 24 * 60 * 60 * 1000) // 180d in ms

// MaxAuthSessionsPerUser caps concurrent device sessions per account (D13,
// G6, T7: 单账号并发 ≤20 个设备会话). Sessions are devices, not WebSocket
// connections — a sign-in on a new browser or phone is a new session. When the
// cap would be exceeded, the account's oldest sessions are evicted, so the
// twentieth sign-in on a shared kiosk silently retires the stalest login
// instead of refusing the fresh one.
const MaxAuthSessionsPerUser = 20

// PruneAuthSessions deletes expired rows and reports how many were removed.
// Expired registrations are removed with their session for the same reason a
// logout removes them: the phone no longer has a live credential.
//
// The absolute ceiling is enforced here too: a session past created_at +
// AuthSessionAbsoluteTTL is deleted even when a sliding window would keep it
// alive. authenticate does the same check at read time (with the renewal that
// only AuthenticateSession can compute), so a session can never live past the
// ceiling even if this sweep has not run.
func (s *Store) PruneAuthSessions(ctx context.Context, now int64) (int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("prune auth sessions: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
		DELETE FROM push_devices
		WHERE owner_session_id <> ''
		  AND owner_session_id IN (SELECT id FROM auth_sessions WHERE expires_at <= ?)`,
		now); err != nil {
		return 0, fmt.Errorf("prune session push devices: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		DELETE FROM push_devices
		WHERE owner_session_id <> ''
		  AND owner_session_id IN (SELECT id FROM auth_sessions WHERE created_at <= ?)`,
		now-AuthSessionAbsoluteTTL); err != nil {
		return 0, fmt.Errorf("prune absolute-ttl push devices: %w", err)
	}
	res, err := tx.ExecContext(ctx, `DELETE FROM auth_sessions WHERE expires_at <= ?`, now)
	if err != nil {
		return 0, fmt.Errorf("prune auth sessions: %w", err)
	}
	n, _ := res.RowsAffected()
	if _, err := tx.ExecContext(ctx, `DELETE FROM auth_sessions WHERE created_at <= ?`,
		now-AuthSessionAbsoluteTTL); err != nil {
		return 0, fmt.Errorf("prune absolute-ttl auth sessions: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("prune auth sessions: %w", err)
	}
	return n, nil
}

// EnforceAuthSessionCap keeps an account's live sessions at or below max,
// deleting its oldest sessions (by created_at, then id for a stable order) and
// their push registrations until it fits. The cap is enforced at sign-in: one
// login opens at most one session, so deleting down to max-1 before the insert
// leaves room. Registrations bound to an evicted session go with it — a
// retired kiosk login must not keep ringing the kiosk's phone.
//
// The caller passes max explicitly so tests can exercise the eviction without
// minting 21 rows.
func (s *Store) EnforceAuthSessionCap(ctx context.Context, userID string, max int) error {
	if max <= 0 {
		return fmt.Errorf("invalid session cap")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("enforce auth session cap: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	// The eviction count is clamped at zero: SQLite reads a negative LIMIT as
	// "no limit", so an account under its cap would delete every session it
	// owns instead of none. The subquery selects the evictees once so the
	// push-device delete and the session delete see the same rows: sessions the
	// account is keeping have to stay exactly as they are, and a registration
	// bound to a session that survives must survive with it.
	if _, err := tx.ExecContext(ctx, `
		DELETE FROM push_devices
		WHERE owner_session_id <> ''
		  AND owner_session_id IN (
			SELECT id FROM auth_sessions
			WHERE user_id = ?
			ORDER BY created_at, id
			LIMIT MAX(0, (SELECT COUNT(*) FROM auth_sessions WHERE user_id = ?) - ?)
		  )`, userID, userID, max); err != nil {
		return fmt.Errorf("delete evicted session push devices: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		DELETE FROM auth_sessions
		WHERE id IN (
			SELECT id FROM auth_sessions
			WHERE user_id = ?
			ORDER BY created_at, id
			LIMIT MAX(0, (SELECT COUNT(*) FROM auth_sessions WHERE user_id = ?) - ?)
		)`, userID, userID, max); err != nil {
		return fmt.Errorf("delete evicted sessions: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("enforce auth session cap: %w", err)
	}
	return nil
}

// AuthSessionLive reports whether a browser session still exists, has not
// expired, and belongs to an account that is still enabled. Delivery asks this
// before ringing a phone whose registration is bound to that session, so a
// revocation that raced a send — or a row left behind by a crash between the
// two deletes — still cannot deliver. A disabled account is not live either:
// authentication already refuses it, so its phone must not keep ringing.
//
// An empty id, a missing row, or a read failure all answer false: a
// notification nobody can vouch for is not sent.
func (s *Store) AuthSessionLive(ctx context.Context, sessionID string) bool {
	if sessionID == "" {
		return false
	}
	var n int
	if err := s.db.QueryRowContext(ctx, `
		SELECT COUNT(*)
		FROM auth_sessions s
		JOIN users u ON u.id = s.user_id
		WHERE s.id = ? AND s.expires_at > ? AND u.disabled_at IS NULL`,
		sessionID, time.Now().UnixMilli()).Scan(&n); err != nil {
		return false
	}
	return n > 0
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

// InviteTokenActive reports whether one invitation is still redeemable, without
// spending it.
//
// It exists so a caller can refuse a code that cannot work before asking
// anything else. A join that checked the address first would answer differently
// for a registered and an unregistered address, which on an unauthenticated
// route is a way to ask which addresses have accounts here: one query per guess,
// no invitation required. Answering the code first means a caller who cannot
// present a live one never reaches the question.
//
// The read is deliberately not the authority on spending. ConsumeInviteToken
// stays the single place that decides, so a code spent between this read and
// that write is refused exactly as an unknown one is.
func (s *Store) InviteTokenActive(ctx context.Context, tokenHash string, now int64) (bool, error) {
	var n int
	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM invite_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`,
		tokenHash, now).Scan(&n)
	if err != nil {
		return false, fmt.Errorf("count invite tokens: %w", err)
	}
	return n > 0, nil
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

// IssueLoginToken stores a one-time sign-in link secret for one account.
//
// Issuing a new link retires that account's outstanding links. A link is handed
// over in chat or terminal output, which are the two places credentials outlive
// the conversation, so minting a replacement has to mean the previous one
// stopped working. Other accounts are untouched: links are issued one per
// person, exactly like invitations.
func (s *Store) IssueLoginToken(ctx context.Context, tokenHash, userID string, now, expiresAt int64) error {
	if tokenHash == "" || userID == "" || expiresAt <= now {
		return fmt.Errorf("invalid login token")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin issue login token: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx,
		`UPDATE login_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL`,
		now, userID); err != nil {
		return fmt.Errorf("invalidate login tokens: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO login_tokens (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
		tokenHash, userID, now, expiresAt); err != nil {
		return fmt.Errorf("insert login token: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit issue login token: %w", err)
	}
	return nil
}

// ConsumeLoginToken atomically spends a sign-in link and returns the account it
// belongs to. ErrNotFound covers unknown, expired, and already-used links so a
// caller cannot tell them apart.
//
// Single use is enforced the same two ways ConsumeInviteToken explains: the read
// refuses a spent row, and the conditional UPDATE only matches an unspent one.
func (s *Store) ConsumeLoginToken(ctx context.Context, tokenHash string, now int64) (string, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", fmt.Errorf("begin consume login token: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var userID string
	var expiresAt int64
	var usedAt sql.NullInt64
	err = tx.QueryRowContext(ctx,
		`SELECT user_id, expires_at, used_at FROM login_tokens WHERE token_hash = ?`, tokenHash).
		Scan(&userID, &expiresAt, &usedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", fmt.Errorf("read login token: %w", err)
	}
	if usedAt.Valid || expiresAt <= now {
		return "", ErrNotFound
	}
	res, err := tx.ExecContext(ctx,
		`UPDATE login_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL`,
		now, tokenHash)
	if err != nil {
		return "", fmt.Errorf("consume login token: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return "", ErrNotFound
	}
	if err := tx.Commit(); err != nil {
		return "", fmt.Errorf("commit consume login token: %w", err)
	}
	return userID, nil
}

// IssueLoginCode stores a short-lived device-bound login code (T6): the one
// credential a system-browser sign-in hands back to the native app. The hash
// and the device key are stored, never the code itself, and the device key is
// what makes the code worthless on any phone but the one that started the flow.
//
// userID is the account the OAuth callback already authenticated; writing it at
// issue time (rather than resolving an email at exchange time) means the
// exchange is a lookup, not a second matching decision a caller could steer.
//
// Codes are not links: a link is spent by a POST from any browser on the
// origin, while a code is spent by the app that first showed up asking for it.
// That binding is why no "retire the account's older codes" step exists — the
// natural revocation is per-device, and an account-level sweep would break two
// phones signing in at once.
func (s *Store) IssueLoginCode(ctx context.Context, codeHash, deviceKey, userID string, now, expiresAt int64) error {
	if codeHash == "" || deviceKey == "" || userID == "" || expiresAt <= now {
		return fmt.Errorf("invalid login code")
	}
	if _, err := s.db.ExecContext(ctx,
		`INSERT INTO login_codes (code_hash, device_key, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
		codeHash, deviceKey, userID, now, expiresAt); err != nil {
		return fmt.Errorf("insert login code: %w", err)
	}
	return nil
}

// ConsumeLoginCode atomically spends a login code for one device and returns
// the account the flow authenticated. ErrNotFound covers unknown, expired,
// already-used, and wrong-device codes, so an unauthenticated caller cannot
// tell them apart.
//
// Single use is the same two-sided check ConsumeLoginToken uses: the read
// refuses a spent row and the conditional UPDATE only matches an unspent one.
func (s *Store) ConsumeLoginCode(ctx context.Context, codeHash, deviceKey string, now int64) (string, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", fmt.Errorf("begin consume login code: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var userID string
	var expiresAt int64
	var usedAt sql.NullInt64
	err = tx.QueryRowContext(ctx,
		`SELECT user_id, expires_at, used_at FROM login_codes WHERE code_hash = ? AND device_key = ?`,
		codeHash, deviceKey).
		Scan(&userID, &expiresAt, &usedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", fmt.Errorf("read login code: %w", err)
	}
	if usedAt.Valid || expiresAt <= now {
		return "", ErrNotFound
	}
	res, err := tx.ExecContext(ctx,
		`UPDATE login_codes SET used_at = ? WHERE code_hash = ? AND device_key = ? AND used_at IS NULL`,
		now, codeHash, deviceKey)
	if err != nil {
		return "", fmt.Errorf("consume login code: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return "", ErrNotFound
	}
	if err := tx.Commit(); err != nil {
		return "", fmt.Errorf("commit consume login code: %w", err)
	}
	return userID, nil
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

func scanUser(row rowScanner) (User, error) {
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
