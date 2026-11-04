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

	// DefaultLoginLinkTTL is minutes, not days, because of how the link travels:
	// an agent prints it into a chat transcript and a terminal scrollback, both
	// of which keep it long after it is spent. Half an hour is enough for "read
	// the link, open it", and a new one costs one command.
	DefaultLoginLinkTTL = 30 * time.Minute

	// DefaultLoginCodeTTL bounds the system-browser callback hop (T6): the app
	// is in the foreground holding an ASWebAuthenticationSession result, and
	// the exchange happens immediately. Five minutes covers a slow handoff
	// between browser and app; anything longer only extends the life of a
	// credential that was never meant to be stored.
	DefaultLoginCodeTTL = 5 * time.Minute

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

// ErrRegistrationClosed is returned when a bootstrap path is used on a Hub that
// already has an owner. New accounts are never created implicitly: the first
// owner is established by the terminal bootstrap code, and any later identity
// must be linked from an authenticated session.
var ErrRegistrationClosed = errors.New("auth: this hub already has an owner")

// ErrIdentityNotLinked means the provider authenticated somebody, but that
// identity is not attached to any account here. It is separate from
// ErrRegistrationClosed because the remedy is different and the provider
// callback is the only place that knows the difference: registration is not
// being attempted, a link is missing. Telling this person the Hub "already has
// an owner" hides the one action that fixes it (sign in with the password, then
// link the provider in Settings).
var ErrIdentityNotLinked = errors.New("auth: this sign-in is not linked to an account on this hub")

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

// ErrLoginLinkUnavailable means the supplied sign-in link is unknown, expired,
// already spent, or belongs to a disabled account. The cases are intentionally
// indistinguishable, exactly as they are for claim codes and invitations: the
// endpoint that spends it is unauthenticated.
var ErrLoginLinkUnavailable = errors.New("auth: this sign-in link is not valid")

// ErrLoginCodeUnavailable means the supplied device-bound login code is
// unknown, expired, already spent, bound to a different device, or its account
// has since been disabled. Like ErrLoginLinkUnavailable, the cases are
// deliberately indistinguishable: the endpoint that spends it is
// unauthenticated.
var ErrLoginCodeUnavailable = errors.New("auth: this sign-in code is not valid")

// ErrAccountDisabled means a link was requested for an account that has been
// switched off. Only the operator's CLI can ask, so saying so is safe and
// names the real reason instead of sending them looking for a typo.
var ErrAccountDisabled = errors.New("auth: that account is disabled")

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
	LoginLinkTTL time.Duration
	LoginCodeTTL time.Duration
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
	if cfg.LoginLinkTTL <= 0 {
		cfg.LoginLinkTTL = DefaultLoginLinkTTL
	}
	if cfg.LoginCodeTTL <= 0 {
		cfg.LoginCodeTTL = DefaultLoginCodeTTL
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
// ends every browser session and unspent sign-in link that account holds.
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
	// One transaction: the new hash, the end of the old sessions, and the
	// retirement of unspent sign-in links land together, so the password the CLI
	// is about to print is the only credential that works once it is printed.
	if err := s.store.ReplacePasswordAndEndSessions(ctx, identity.ID, user.ID, hash, s.now().UnixMilli()); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return store.User{}, ErrAccountNotFound
		}
		return store.User{}, err
	}
	return user, nil
}

// LoginLink is a freshly minted one-time sign-in link. Token is the only time
// the raw secret exists in memory; storage keeps its hash. ExpiresAt travels
// with it so the lifetime an operator is shown is the one that was written.
type LoginLink struct {
	Token     string
	ExpiresAt time.Time
}

// IssueLoginLink mints a one-time sign-in link for an account. The caller has
// already established which account -- this method deliberately takes a user id,
// not an address, because matching an email is an operator decision (the CLI's,
// where it can explain an ambiguity) and never an authentication path.
//
// Issuing a new link retires the account's older ones; see Store.IssueLoginToken.
func (s *Service) IssueLoginLink(ctx context.Context, userID string) (LoginLink, error) {
	user, err := s.store.GetUser(ctx, userID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return LoginLink{}, ErrAccountNotFound
		}
		return LoginLink{}, err
	}
	if user.DisabledAt != nil {
		return LoginLink{}, ErrAccountDisabled
	}
	token, err := NewToken()
	if err != nil {
		return LoginLink{}, err
	}
	now := s.now()
	expiresAt := now.Add(s.cfg.LoginLinkTTL)
	if err := s.store.IssueLoginToken(ctx, HashToken(token), userID,
		now.UnixMilli(), expiresAt.UnixMilli()); err != nil {
		return LoginLink{}, err
	}
	return LoginLink{Token: token, ExpiresAt: expiresAt}, nil
}

// ConsumeLoginLink spends a one-time sign-in link and opens a session.
//
// The token is lowercased before hashing because it is hex: a chat client or a
// person retyping it may change the case, and the token carries no other
// formatting that could be normalized away. A link that is expired, spent, or
// attached to a disabled account answers the same error, so the unauthenticated
// endpoint that calls this cannot be used to probe account state.
func (s *Service) ConsumeLoginLink(ctx context.Context, token string, meta SessionMeta) (Session, error) {
	token = strings.ToLower(strings.TrimSpace(token))
	if token == "" {
		return Session{}, ErrLoginLinkUnavailable
	}
	userID, err := s.store.ConsumeLoginToken(ctx, HashToken(token), s.now().UnixMilli())
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return Session{}, ErrLoginLinkUnavailable
		}
		return Session{}, err
	}
	user, err := s.store.GetUser(ctx, userID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return Session{}, ErrLoginLinkUnavailable
		}
		return Session{}, err
	}
	if user.DisabledAt != nil {
		return Session{}, ErrLoginLinkUnavailable
	}
	return s.openSession(ctx, user, meta)
}

// LoginCode is a freshly minted device-bound login code. Like LoginLink, Token
// is the only time the raw secret exists in memory.
type LoginCode struct {
	Token string
}

// NewLoginCode mints the device-bound code a system-browser sign-in hands back
// to the native app (G9/T6). userID is the account the OAuth callback already
// authenticated and deviceKey is an app-generated random string that never
// leaves the app except to start the flow and spend the code.
//
// The returned code travels on the app's own callback scheme — a hop no server
// log, proxy, or Referer sees — and is spent once, within LoginCodeTTL, by the
// one device key that started the flow.
func (s *Service) NewLoginCode(ctx context.Context, userID, deviceKey string) (LoginCode, error) {
	if strings.TrimSpace(deviceKey) == "" {
		return LoginCode{}, fmt.Errorf("auth: a login code needs a device key")
	}
	user, err := s.store.GetUser(ctx, userID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return LoginCode{}, ErrAccountNotFound
		}
		return LoginCode{}, err
	}
	if user.DisabledAt != nil {
		return LoginCode{}, ErrAccountDisabled
	}
	token, err := NewToken()
	if err != nil {
		return LoginCode{}, err
	}
	now := s.now()
	if err := s.store.IssueLoginCode(ctx, HashToken(token), deviceKey, userID,
		now.UnixMilli(), now.Add(s.cfg.LoginCodeTTL).UnixMilli()); err != nil {
		return LoginCode{}, err
	}
	return LoginCode{Token: token}, nil
}

// ExchangeLoginCode spends a device-bound code and opens a session. It is the
// first authenticated thing a fresh install does, so it gets the same
// indistinguishable-error treatment as every other unauthenticated path:
// unknown, expired, spent, wrong-device, and disabled all answer
// ErrLoginCodeUnavailable.
//
// What comes back is a one-time login link, not a session: the app opens the
// link in its own webview, where the cookie the session sets is first-party
// for the Hub origin the webview is on. Handing the session token across the
// bridge instead would put a live 30-day credential into code the console
// only half-controls.
func (s *Service) ExchangeLoginCode(ctx context.Context, token, deviceKey string, meta SessionMeta) (LoginLink, error) {
	token = strings.TrimSpace(token)
	deviceKey = strings.TrimSpace(deviceKey)
	if token == "" || deviceKey == "" {
		return LoginLink{}, ErrLoginCodeUnavailable
	}
	userID, err := s.store.ConsumeLoginCode(ctx, HashToken(token), deviceKey, s.now().UnixMilli())
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return LoginLink{}, ErrLoginCodeUnavailable
		}
		return LoginLink{}, err
	}
	link, err := s.IssueLoginLink(ctx, userID)
	if err != nil {
		if errors.Is(err, ErrAccountDisabled) || errors.Is(err, ErrAccountNotFound) {
			// The account was disabled between the callback and the exchange.
			// The code is spent either way; answer like any other failure.
			return LoginLink{}, ErrLoginCodeUnavailable
		}
		return LoginLink{}, err
	}
	return link, nil
}

// LoginIdentity resolves a federated login to its account. An unknown identity
// is refused on a claimed Hub rather than silently creating a second account:
// the alternative lets any GitHub user who can reach the URL take ownership.
//
// The one exception is D3's same-verified-email merge: when the provider
// asserts the address as verified and exactly one live account already carries
// it, the identity binds to that account instead of being refused. Two
// accounts sharing the address is ambiguous rather than convenient -- picking
// one would sign somebody into another person's Hub -- so multiple matches
// keep the refusal and the explicit link path. An unverified address never
// merges: a provider that did not check the mailbox asserted nothing worth
// binding an account to.
func (s *Service) LoginIdentity(ctx context.Context, ident ExternalIdentity, meta SessionMeta) (Session, error) {
	if err := validateExternalIdentity(ident); err != nil {
		return Session{}, err
	}
	user, identity, err := s.store.UserByIdentity(ctx, ident.Provider, ident.Subject)
	if err != nil {
		if !errors.Is(err, store.ErrNotFound) {
			return Session{}, err
		}
		merged, merr := s.mergeByEmail(ctx, ident, meta)
		if merr != nil {
			if errors.Is(merr, ErrIdentityNotLinked) {
				return Session{}, ErrIdentityNotLinked
			}
			return Session{}, merr
		}
		return merged, nil
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

// mergeByEmail binds a provider identity to the one live account whose address
// matches the provider's verified assertion. It returns ErrIdentityNotLinked
// when there is no unambiguous match: no account, more than one, or one that
// is disabled or deleted. Binding goes through AddIdentity, the same write the
// explicit link path uses, so an account acquires the credential by exactly
// one road; the difference is who vouched for the address -- the provider's
// verification instead of a live session.
//
// The match is decided on the password identity first, because that subject
// *is* the address; falling back to users.email covers accounts that only
// sign in through another provider. Disabled accounts are refused, not
// revived: D3 names that flow as its own next step.
func (s *Service) mergeByEmail(ctx context.Context, ident ExternalIdentity, meta SessionMeta) (Session, error) {
	if !ident.EmailVerified || NormalizeEmail(ident.Email) == "" {
		return Session{}, ErrIdentityNotLinked
	}
	email := NormalizeEmail(ident.Email)
	var match *store.User
	if user, _, err := s.store.UserByIdentity(ctx, store.ProviderPassword, email); err == nil {
		match = &user
	} else if !errors.Is(err, store.ErrNotFound) {
		return Session{}, err
	}
	if match == nil {
		users, err := s.store.ListUsers(ctx)
		if err != nil {
			return Session{}, err
		}
		for i := range users {
			if NormalizeEmail(users[i].Email) == email {
				if match != nil {
					// Two accounts carry the address. The refusal is the D3
					// answer: sign in to one of them and link explicitly.
					return Session{}, ErrIdentityNotLinked
				}
				match = &users[i]
			}
		}
	}
	if match == nil || match.DisabledAt != nil {
		return Session{}, ErrIdentityNotLinked
	}
	if err := s.LinkIdentity(ctx, match.ID, ident); err != nil {
		return Session{}, err
	}
	return s.openSession(ctx, *match, meta)
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

// AuthenticateSession resolves a session cookie to its account and the login
// row it came through. Callers that need to bind something to this specific
// login — a push registration, for one — need the session id, which the
// account alone does not carry.
func (s *Service) AuthenticateSession(ctx context.Context, token string) (store.AuthSession, store.User, error) {
	if token == "" {
		return store.AuthSession{}, store.User{}, store.ErrNotFound
	}
	return s.store.AuthenticateSession(ctx, HashToken(token), s.now().UnixMilli())
}

// Authenticate resolves a session cookie value to its account.
func (s *Service) Authenticate(ctx context.Context, token string) (store.User, error) {
	_, user, err := s.AuthenticateSession(ctx, token)
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
