package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/oklog/ulid/v2"

	"github.com/vuuihc/openkin/internal/store"
)

// Defaults for the Hub's account system.
const (
	DefaultSessionTTL   = 30 * 24 * time.Hour
	DefaultBootstrapTTL = 24 * time.Hour

	// minPasswordLen is a floor, not a policy. The Hub is single-owner and
	// reachable from the internet, so a trivially short password is worth
	// rejecting outright; beyond that, length is the user's call.
	minPasswordLen = 8

	// bootstrapAlphabet omits 0/O/1/I/L so a code read off `docker compose
	// logs` cannot be mistyped into a different valid code.
	bootstrapAlphabet = "ABCDEFGHJKMNPQRSTVWXYZ23456789"
	bootstrapGroups   = 2
	bootstrapGroupLen = 5
)

// ErrRegistrationClosed is returned when an unknown federated identity tries to
// sign in on an already-claimed Hub. New accounts are never created implicitly:
// the first owner is established by the terminal bootstrap code, and any later
// identity must be linked from an authenticated session.
var ErrRegistrationClosed = errors.New("auth: this hub already has an owner")

// ErrBootstrapUnavailable means the supplied claim code is unknown, expired, or
// already spent. The three cases are intentionally indistinguishable.
var ErrBootstrapUnavailable = errors.New("auth: claim code is not valid")

// ErrWeakPassword means the password failed the length floor.
var ErrWeakPassword = fmt.Errorf("auth: password must be at least %d characters", minPasswordLen)

// ErrIdentityTaken means the federated identity is already linked to an account.
var ErrIdentityTaken = errors.New("auth: that login is already linked to another account")

// ExternalIdentity is a verified assertion from an OIDC provider. Subject is
// the provider's stable user id and the only field used for matching; Email is
// carried for display and is never a matching key.
type ExternalIdentity struct {
	Provider      string
	Subject       string
	Email         string
	EmailVerified bool
	DisplayName   string
	Label         string
}

// SessionMeta is request context recorded on a new session for the device list.
type SessionMeta struct {
	UserAgent string
	IP        string
}

// Session is a freshly issued browser session. Token is the only time the raw
// credential exists in memory; storage keeps its hash.
type Session struct {
	Token     string
	ExpiresAt time.Time
	User      store.User
}

// Config tunes lifetimes. Zero values fall back to the defaults.
type Config struct {
	SessionTTL   time.Duration
	BootstrapTTL time.Duration
	Now          func() time.Time
}

// Service owns account creation, login, and session lifecycle.
type Service struct {
	store *store.Store
	cfg   Config
}

// New returns a Service backed by st.
func New(st *store.Store, cfg Config) *Service {
	if cfg.SessionTTL <= 0 {
		cfg.SessionTTL = DefaultSessionTTL
	}
	if cfg.BootstrapTTL <= 0 {
		cfg.BootstrapTTL = DefaultBootstrapTTL
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	return &Service{store: st, cfg: cfg}
}

func (s *Service) now() time.Time { return s.cfg.Now() }

// NeedsBootstrap reports whether the Hub is still unclaimed.
func (s *Service) NeedsBootstrap(ctx context.Context) (bool, error) {
	n, err := s.store.CountUsers(ctx)
	if err != nil {
		return false, err
	}
	return n == 0, nil
}

// IssueBootstrapCode mints a one-time owner-claim code and returns it in
// plaintext. Only the hash is persisted. Issuing a code invalidates any
// previous unused code.
func (s *Service) IssueBootstrapCode(ctx context.Context) (string, error) {
	code, err := newBootstrapCode()
	if err != nil {
		return "", err
	}
	now := s.now()
	if err := s.store.IssueBootstrapToken(ctx, HashToken(NormalizeCode(code)),
		now.UnixMilli(), now.Add(s.cfg.BootstrapTTL).UnixMilli()); err != nil {
		return "", err
	}
	return code, nil
}

// BootstrapCodeActive reports whether an unspent claim code exists, which the
// login surface uses to decide between "claim this hub" and "sign in".
func (s *Service) BootstrapCodeActive(ctx context.Context) (bool, error) {
	return s.store.HasActiveBootstrapToken(ctx, s.now().UnixMilli())
}

// ClaimWithPassword establishes the first owner using an email and password.
func (s *Service) ClaimWithPassword(ctx context.Context, code, email, password, displayName string, meta SessionMeta) (Session, error) {
	if err := validatePassword(password); err != nil {
		return Session{}, err
	}
	email = NormalizeEmail(email)
	if email == "" {
		return Session{}, fmt.Errorf("auth: email is required")
	}
	if strings.TrimSpace(displayName) == "" {
		displayName = email
	}
	return s.claim(ctx, code, store.User{
		Email:         email,
		EmailVerified: false,
		EmailSource:   store.ProviderPassword,
		DisplayName:   displayName,
	}, func(userID string, now time.Time) (store.UserIdentity, error) {
		hash, err := HashPassword(password)
		if err != nil {
			return store.UserIdentity{}, err
		}
		return store.UserIdentity{
			ID:         ulid.Make().String(),
			UserID:     userID,
			Provider:   store.ProviderPassword,
			Subject:    email,
			SecretHash: hash,
			Label:      "password",
			CreatedAt:  now.UnixMilli(),
		}, nil
	}, meta)
}

// ClaimWithIdentity establishes the first owner from a federated login.
func (s *Service) ClaimWithIdentity(ctx context.Context, code string, ident ExternalIdentity, meta SessionMeta) (Session, error) {
	if err := validateExternalIdentity(ident); err != nil {
		return Session{}, err
	}
	displayName := ident.DisplayName
	if strings.TrimSpace(displayName) == "" {
		displayName = ident.Email
	}
	if strings.TrimSpace(displayName) == "" {
		displayName = ident.Subject
	}
	return s.claim(ctx, code, store.User{
		Email:         NormalizeEmail(ident.Email),
		EmailVerified: ident.EmailVerified,
		EmailSource:   ident.Provider,
		DisplayName:   displayName,
	}, func(userID string, now time.Time) (store.UserIdentity, error) {
		return identityFromExternal(userID, ident, now), nil
	}, meta)
}

// claim is the shared body of the two bootstrap paths: it spends the code,
// creates the account and its first credential, and opens a session.
func (s *Service) claim(
	ctx context.Context,
	code string,
	user store.User,
	buildIdentity func(userID string, now time.Time) (store.UserIdentity, error),
	meta SessionMeta,
) (Session, error) {
	needs, err := s.NeedsBootstrap(ctx)
	if err != nil {
		return Session{}, err
	}
	if !needs {
		return Session{}, ErrRegistrationClosed
	}
	now := s.now()
	if err := s.store.ConsumeBootstrapToken(ctx, HashToken(NormalizeCode(code)), now.UnixMilli()); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return Session{}, ErrBootstrapUnavailable
		}
		return Session{}, err
	}

	user.ID = ulid.Make().String()
	user.CreatedAt = now.UnixMilli()
	// Claiming the Hub is what makes an account its owner, so the role is set
	// here rather than by either caller: both bootstrap paths mean the same thing.
	user.Role = store.RoleOwner
	identity, err := buildIdentity(user.ID, now)
	if err != nil {
		return Session{}, err
	}
	if err := s.store.CreateUserWithIdentity(ctx, user, identity); err != nil {
		return Session{}, err
	}
	return s.openSession(ctx, user, meta)
}

// LoginPassword authenticates an email/password pair. A missing account and a
// wrong password are indistinguishable to the caller and cost the same time.
func (s *Service) LoginPassword(ctx context.Context, email, password string, meta SessionMeta) (Session, error) {
	email = NormalizeEmail(email)
	user, identity, err := s.store.UserByIdentity(ctx, store.ProviderPassword, email)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			burnPasswordTime(password)
			return Session{}, ErrInvalidCredentials
		}
		return Session{}, err
	}
	if identity.SecretHash == "" {
		burnPasswordTime(password)
		return Session{}, ErrInvalidCredentials
	}
	if err := VerifyPassword(identity.SecretHash, password); err != nil {
		if errors.Is(err, ErrInvalidHash) {
			return Session{}, fmt.Errorf("auth: stored hash for identity %s is malformed: %w", identity.ID, err)
		}
		return Session{}, ErrInvalidCredentials
	}
	_ = s.store.TouchIdentity(ctx, identity.ID, s.now().UnixMilli())
	return s.openSession(ctx, user, meta)
}

// LoginIdentity resolves a federated login to its account. An unknown identity
// is refused on a claimed Hub rather than silently creating a second account:
// the alternative lets any GitHub user who can reach the URL take ownership.
func (s *Service) LoginIdentity(ctx context.Context, ident ExternalIdentity, meta SessionMeta) (Session, error) {
	if err := validateExternalIdentity(ident); err != nil {
		return Session{}, err
	}
	user, identity, err := s.store.UserByIdentity(ctx, ident.Provider, ident.Subject)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return Session{}, ErrRegistrationClosed
		}
		return Session{}, err
	}
	_ = s.store.TouchIdentity(ctx, identity.ID, s.now().UnixMilli())
	// The provider may have verified the address since the account was created;
	// record the upgrade, but never rewrite the account's email from here.
	if ident.EmailVerified && !user.EmailVerified && NormalizeEmail(ident.Email) == user.Email {
		if err := s.store.MarkEmailVerified(ctx, user.ID, ident.Provider); err != nil {
			return Session{}, err
		}
		user.EmailVerified = true
		user.EmailSource = ident.Provider
	}
	return s.openSession(ctx, user, meta)
}

// LinkIdentity attaches a federated login to the signed-in account. This is the
// only path that grows an account's set of credentials, and it requires a live
// session — an unauthenticated provider callback can never merge accounts.
func (s *Service) LinkIdentity(ctx context.Context, userID string, ident ExternalIdentity) error {
	if err := validateExternalIdentity(ident); err != nil {
		return err
	}
	if existing, _, err := s.store.UserByIdentity(ctx, ident.Provider, ident.Subject); err == nil {
		if existing.ID != userID {
			return ErrIdentityTaken
		}
		return nil
	} else if !errors.Is(err, store.ErrNotFound) {
		return err
	}
	now := s.now()
	return s.store.AddIdentity(ctx, identityFromExternal(userID, ident, now))
}

// Authenticate resolves a session cookie value to its account.
func (s *Service) Authenticate(ctx context.Context, token string) (store.User, error) {
	if token == "" {
		return store.User{}, store.ErrNotFound
	}
	_, user, err := s.store.AuthenticateSession(ctx, HashToken(token), s.now().UnixMilli())
	return user, err
}

// Logout revokes the session behind token.
func (s *Service) Logout(ctx context.Context, token string) error {
	if token == "" {
		return nil
	}
	return s.store.DeleteAuthSession(ctx, HashToken(token))
}

// RevokeOtherSessions drops every session for the account except keepToken.
func (s *Service) RevokeOtherSessions(ctx context.Context, userID, keepToken string) (int64, error) {
	return s.store.DeleteUserAuthSessions(ctx, userID, HashToken(keepToken))
}

// PruneSessions removes expired sessions.
func (s *Service) PruneSessions(ctx context.Context) (int64, error) {
	return s.store.PruneAuthSessions(ctx, s.now().UnixMilli())
}

func (s *Service) openSession(ctx context.Context, user store.User, meta SessionMeta) (Session, error) {
	token, err := NewToken()
	if err != nil {
		return Session{}, err
	}
	now := s.now()
	expires := now.Add(s.cfg.SessionTTL)
	session := store.AuthSession{
		ID:        ulid.Make().String(),
		TokenHash: HashToken(token),
		UserID:    user.ID,
		CreatedAt: now.UnixMilli(),
		ExpiresAt: expires.UnixMilli(),
		UserAgent: truncate(meta.UserAgent, 300),
		IP:        truncate(meta.IP, 64),
	}
	if err := s.store.CreateAuthSession(ctx, session); err != nil {
		return Session{}, err
	}
	return Session{Token: token, ExpiresAt: expires, User: user}, nil
}

func identityFromExternal(userID string, ident ExternalIdentity, now time.Time) store.UserIdentity {
	return store.UserIdentity{
		ID:        ulid.Make().String(),
		UserID:    userID,
		Provider:  ident.Provider,
		Subject:   ident.Subject,
		Label:     ident.Label,
		CreatedAt: now.UnixMilli(),
	}
}

func validateExternalIdentity(ident ExternalIdentity) error {
	if strings.TrimSpace(ident.Provider) == "" {
		return fmt.Errorf("auth: identity provider is required")
	}
	if strings.TrimSpace(ident.Subject) == "" {
		// An empty subject would collapse every user of that provider into one
		// identity, so it is a hard error rather than a skipped field.
		return fmt.Errorf("auth: identity subject is required")
	}
	return nil
}

func validatePassword(password string) error {
	if len(password) < minPasswordLen {
		return ErrWeakPassword
	}
	return nil
}

// NormalizeEmail lowercases and trims an address for use as a password-login
// subject. It is not used to match accounts across providers.
func NormalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

// NormalizeCode strips formatting so a code copied from logs with or without
// its separator both work.
func NormalizeCode(code string) string {
	replacer := strings.NewReplacer("-", "", " ", "", "\t", "")
	return strings.ToUpper(replacer.Replace(strings.TrimSpace(code)))
}

// NewToken returns a 32-byte random session token as hex.
func NewToken() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("auth: generate token: %w", err)
	}
	return hex.EncodeToString(raw), nil
}

// HashToken returns the fixed-size digest persisted for session tokens and
// bootstrap codes. Raw secrets are never stored.
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func newBootstrapCode() (string, error) {
	total := bootstrapGroups * bootstrapGroupLen
	raw := make([]byte, total)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("auth: generate claim code: %w", err)
	}
	var b strings.Builder
	for i := 0; i < total; i++ {
		if i > 0 && i%bootstrapGroupLen == 0 {
			b.WriteByte('-')
		}
		// The modulo bias over a 31-character alphabet is negligible and does
		// not meaningfully shrink the search space.
		b.WriteByte(bootstrapAlphabet[int(raw[i])%len(bootstrapAlphabet)])
	}
	return b.String(), nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
