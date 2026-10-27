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

	// DefaultInviteTTL is longer than a claim code's day. A claim code is read
	// off a terminal on the machine in front of you; an invitation is sent to
	// someone who may not open it until the weekend.
	DefaultInviteTTL = 7 * 24 * time.Hour

	// minPasswordLen is a floor, not a policy. The Hub is single-owner and
	// reachable from the internet, so a trivially short password is worth
	// rejecting outright; beyond that, length is the user's call.
	minPasswordLen = 8

	// bootstrapAlphabet omits 0/O/1/I/L so a code read off `docker compose
	// logs` cannot be mistyped into a different valid code.
	bootstrapAlphabet = "ABCDEFGHJKMNPQRSTVWXYZ23456789"
	bootstrapGroups   = 2
	bootstrapGroupLen = 5

	// inviteGroups is twice the claim code's length on purpose. A claim code is
	// guarded by the Hub being unowned -- it can be spent once, by whoever gets
	// there first, and the machine it was printed on is usually the one being
	// claimed. An invitation is redeemed at an unauthenticated endpoint that
	// faces the internet, and guessing is the only attack it has, so the search
	// space is what has to carry it: 31^20 rather than 31^10.
	inviteGroups   = 4
	inviteGroupLen = 5
)

// ErrRegistrationClosed is returned when an unknown federated identity tries to
// sign in on an already-claimed Hub. New accounts are never created implicitly:
// the first owner is established by the terminal bootstrap code, and any later
// identity must be linked from an authenticated session.
var ErrRegistrationClosed = errors.New("auth: this hub already has an owner")

// ErrBootstrapUnavailable means the supplied claim code is unknown, expired, or
// already spent. The three cases are intentionally indistinguishable.
var ErrBootstrapUnavailable = errors.New("auth: claim code is not valid")

// ErrInviteUnavailable means the supplied invitation is unknown, expired,
// already spent, or offered to a Hub that still has no owner. The cases are
// intentionally indistinguishable, for the same reason ErrBootstrapUnavailable
// gives: an unauthenticated caller must not be able to probe which codes exist.
var ErrInviteUnavailable = errors.New("auth: invitation is not valid")

// ErrWeakPassword means the password failed the length floor.
var ErrWeakPassword = fmt.Errorf("auth: password must be at least %d characters", minPasswordLen)

// ErrIdentityTaken means the federated identity is already linked to an account.
var ErrIdentityTaken = errors.New("auth: that login is already linked to another account")

// ErrEmailTaken means the address already has a password account on this Hub.
//
// It is separate from ErrIdentityTaken because the two are told to different
// people. "That login is already linked to another account" is an answer to
// somebody who tried to attach a provider and found it in use; this is an answer
// to somebody who was invited, already has an account, and should be signing in
// instead. Only this one has an action in it.
var ErrEmailTaken = errors.New("auth: that email already has an account here")

// ErrAccountNotFound means no password credential exists for the address. The
// reset command runs on the Hub host, where saying so is safe and useful: the
// operator is the only audience, and a typo is the likely cause.
var ErrAccountNotFound = errors.New("auth: no password account with that email")

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
	InviteTTL    time.Duration
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
	if cfg.InviteTTL <= 0 {
		cfg.InviteTTL = DefaultInviteTTL
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

// claim is the shared body of the two bootstrap paths: it checks the Hub is
// still unowned, spends the code, and creates the account that now owns it.
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
	if err := s.store.ConsumeBootstrapToken(ctx, HashToken(NormalizeCode(code)), s.now().UnixMilli()); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return Session{}, ErrBootstrapUnavailable
		}
		return Session{}, err
	}
	// Claiming the Hub is what makes an account its owner, so the role is set
	// here rather than by either caller: both bootstrap paths mean the same thing.
	return s.createAccount(ctx, user, store.RoleOwner, buildIdentity, meta)
}

// Invitation is a freshly minted invitation. Code is the only time the raw
// secret exists in memory; storage keeps its hash. ExpiresAt travels with the
// code rather than being recomputed by the caller, so the lifetime an owner is
// shown is the one that was actually written.
type Invitation struct {
	Code      string
	ExpiresAt time.Time
}

// IssueInvite mints a one-time invitation. Outstanding invitations are left
// alone: an owner hands these out one per person, so minting one must not
// revoke another.
func (s *Service) IssueInvite(ctx context.Context) (Invitation, error) {
	code, err := newInviteCode()
	if err != nil {
		return Invitation{}, err
	}
	now := s.now()
	expiresAt := now.Add(s.cfg.InviteTTL)
	if err := s.store.IssueInviteToken(ctx, HashToken(NormalizeCode(code)),
		now.UnixMilli(), expiresAt.UnixMilli()); err != nil {
		return Invitation{}, err
	}
	return Invitation{Code: code, ExpiresAt: expiresAt}, nil
}

// RedeemInvite creates a member account from an owner-issued invitation. It is
// the second and only other way an account comes into being.
func (s *Service) RedeemInvite(
	ctx context.Context,
	code, email, password, displayName string,
	meta SessionMeta,
) (Session, error) {
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
	// An invitation is only meaningful on a Hub that already has an owner: it is
	// issued *by* that owner. Refusing here is what keeps a redeemable row from
	// producing a member where an owner should be -- the Hub would then count a
	// user, stop offering to be claimed, and leave no account able to issue
	// another invitation. That state has no way back through the API, so the
	// check is worth a query on a path this rare.
	needs, err := s.NeedsBootstrap(ctx)
	if err != nil {
		return Session{}, err
	}
	if needs {
		return Session{}, ErrInviteUnavailable
	}
	// Refuse a code that cannot work before asking anything else, because the
	// next question is answered differently for a registered and an unregistered
	// address. On a route anyone can call, that difference is an oracle: a
	// stranger with an invented code could read off which addresses have accounts
	// here, one guess at a time, without holding an invitation at all. Answering
	// the code first costs one read and closes it -- a caller who cannot present a
	// live invitation never reaches the question.
	//
	// It does not spend the invitation; ConsumeInviteToken below is still the only
	// thing that decides, and a code spent in between is refused exactly as an
	// unknown one is.
	//
	// What remains is a caller who *does* hold a live invitation asking after many
	// addresses without spending it. That is the price of the property below --
	// a join that cannot succeed must not burn the code -- and the caller is
	// somebody the owner handed a credential to, which is why it is the acceptable
	// side of the trade.
	tokenHash := HashToken(NormalizeCode(code))
	active, err := s.store.InviteTokenActive(ctx, tokenHash, s.now().UnixMilli())
	if err != nil {
		return Session{}, err
	}
	if !active {
		return Session{}, ErrInviteUnavailable
	}
	// Answer the one failure the invited person can fix before spending the
	// invitation. Consuming first would burn the code on a request that could not
	// have succeeded: the retry answers ErrInviteUnavailable, so somebody who
	// already had an account here would read a spent invitation as a wrong one
	// and have to ask the owner for a new link that fails the same way.
	//
	// The lookup is for the password identity specifically, because that is the
	// row this join would collide with -- a password account's subject *is* its
	// address. An account holding the same address through a provider is a
	// different identity and is not a collision: `users.email` is not unique and
	// the identity key is the (provider, subject) pair, so joining there creates
	// a second account rather than failing, which is the model this Hub already
	// had (ADR 0026).
	if _, _, err := s.store.UserByIdentity(ctx, store.ProviderPassword, email); err == nil {
		return Session{}, ErrEmailTaken
	} else if !errors.Is(err, store.ErrNotFound) {
		return Session{}, err
	}
	if err := s.store.ConsumeInviteToken(ctx, tokenHash, s.now().UnixMilli()); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return Session{}, ErrInviteUnavailable
		}
		return Session{}, err
	}
	// The id is chosen here rather than inside createAccount so the failure below
	// can tell this request's own row from somebody else's. Naming it `ownID`
	// keeps it distinct from the createAccount callback's parameter, which is the
	// same value handed back.
	ownID := ulid.Make().String()
	session, err := s.createAccount(ctx, store.User{
		ID:            ownID,
		Email:         email,
		EmailVerified: false,
		EmailSource:   store.ProviderPassword,
		DisplayName:   displayName,
	}, store.RoleMember, func(userID string, now time.Time) (store.UserIdentity, error) {
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
	if err != nil {
		// The check above is not atomic with this insert, so two joins racing on
		// one address can both pass it and one can lose at the unique index. The
		// invitation is spent by now -- but say what happened rather than
		// returning the index error, because the person can still sign in.
		//
		// Only a *different* account counts. When the row that turns up is the one
		// this call just asked for, the address was free and the session is what
		// failed; calling that ErrEmailTaken would answer a write failure with
		// advice to sign in to an account the person has no way to know exists.
		if found, _, lookupErr := s.store.UserByIdentity(ctx, store.ProviderPassword, email); lookupErr == nil {
			if found.ID != ownID {
				return Session{}, ErrEmailTaken
			}
		}
		return Session{}, err
	}
	return session, nil
}

// createAccount writes the account and its first credential and opens a
// session. The role is a parameter because the two ways in confer different
// ones, and each caller names it next to the token it just spent -- so which
// token produces which role is one line to read per token, rather than a
// decision made here on the caller's behalf.
func (s *Service) createAccount(
	ctx context.Context,
	user store.User,
	role string,
	buildIdentity func(userID string, now time.Time) (store.UserIdentity, error),
	meta SessionMeta,
) (Session, error) {
	now := s.now()
	// A caller that needs to recognize this row in a later lookup supplies the
	// id. Everything else leaves it empty and gets one here, which is why the
	// field is not simply overwritten.
	if user.ID == "" {
		user.ID = ulid.Make().String()
	}
	user.CreatedAt = now.UnixMilli()
	user.Role = role
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

// ResetPassword replaces the password credential of an existing account and
// ends every browser session that account holds.
//
// This is the recovery path ADR 0022 promised: a command on the Hub host, not an
// emailed link, because a self-hosted Hub has no mail path to send one through.
// Running it already requires the database, so it proves nothing about the
// person; what it does is replace a credential nobody can read (only its argon2
// hash is stored) with one the operator can hand to the phone that needs it.
//
// The new password is generated by the caller. Keeping the choice out of this
// method is what lets the CLI print a readable one and the tests pass a literal.
func (s *Service) ResetPassword(ctx context.Context, email, password string) (store.User, error) {
	if err := validatePassword(password); err != nil {
		return store.User{}, err
	}
	user, identity, err := s.store.UserByIdentity(ctx, store.ProviderPassword, NormalizeEmail(email))
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return store.User{}, ErrAccountNotFound
		}
		return store.User{}, err
	}
	hash, err := HashPassword(password)
	if err != nil {
		return store.User{}, err
	}
	// One transaction: the new hash and the end of the old sessions land
	// together, so the password the CLI is about to print is the only one that
	// works once it is printed.
	if err := s.store.ReplacePasswordAndEndSessions(ctx, identity.ID, user.ID, hash); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return store.User{}, ErrAccountNotFound
		}
		return store.User{}, err
	}
	return user, nil
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

func newBootstrapCode() (string, error) { return newCode(bootstrapGroups, bootstrapGroupLen) }

func newInviteCode() (string, error) { return newCode(inviteGroups, inviteGroupLen) }

// NewPassword returns a generated password for the operator's reset command.
// It keeps the code shape — grouped, upper case, without the characters that
// get misread off a terminal — because the operator reads it from one screen and
// types it into a phone. Twenty characters of a 30-symbol alphabet is far past
// the point where any online guessing against argon2id matters.
func NewPassword() (string, error) { return newCode(4, 5) }

// newCode builds a grouped code from the shared alphabet. Both kinds of code
// are read aloud and typed by hand, so they are the same shape and differ only
// in length.
func newCode(groups, groupLen int) (string, error) {
	total := groups * groupLen
	raw := make([]byte, total)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("auth: generate code: %w", err)
	}
	var b strings.Builder
	for i := 0; i < total; i++ {
		if i > 0 && i%groupLen == 0 {
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
