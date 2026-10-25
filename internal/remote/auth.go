package remote

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const tokenBytes = 32

// Principal identifies the authenticated client for audit and authorization.
type Principal struct {
	Kind     string
	DeviceID string
	Label    string
	// UserID is set for browser sessions authenticated by a login cookie. It is
	// the account key, never an email address.
	UserID string
	// Role is the account's role on this daemon and is set only for
	// PrincipalUser. It is what separates the account that claimed the Hub from
	// accounts that registered later, so it must be copied from the account
	// record rather than inferred from Kind.
	Role string
}

const (
	PrincipalMaster = "master"
	PrincipalDevice = "device"
	PrincipalUser   = "user"
)

// Identity is the stable key for whoever is behind this principal: the account
// for a browser session, the device for a paired client.
//
// Callers that key isolation, idempotency, or ownership on a principal must use
// this rather than reading DeviceID. A session principal carries no DeviceID, so
// DeviceID alone is the empty string for every account — which silently makes
// all of them the same caller everywhere it is used as a key.
func (p Principal) Identity() string {
	if p.UserID != "" {
		return p.UserID
	}
	return p.DeviceID
}

// SessionCookieName is the browser login cookie. The desktop shell and native
// clients keep using bearer credentials; only the web console uses this.
const SessionCookieName = "kin_session"

type principalContextKey struct{}
type tokenContextKey struct{}

// PrincipalFromContext returns the authenticated principal, if any.
func PrincipalFromContext(ctx context.Context) (Principal, bool) {
	p, ok := ctx.Value(principalContextKey{}).(Principal)
	return p, ok
}

// TokenFromContext returns the credential used for an authenticated request.
// Handlers that need credential-aware follow-up checks can read it from context.
func TokenFromContext(ctx context.Context) (string, bool) {
	token, ok := ctx.Value(tokenContextKey{}).(string)
	return token, ok && token != ""
}

// DeviceLookup authenticates a native-client token and returns its principal.
// The callback keeps the remote auth package independent from persistence.
type DeviceLookup func(context.Context, string) (Principal, bool)

// SessionLookup authenticates a browser login cookie and returns its principal.
// Like DeviceLookup it keeps this package free of persistence dependencies.
type SessionLookup func(context.Context, string) (Principal, bool)

// StateDirEnv overrides the daemon state directory. Containers set it to a
// mounted volume so the database and secrets do not live in the image layer.
const StateDirEnv = "KIN_STATE_DIR"

// StateDir returns the daemon state directory: $KIN_STATE_DIR when set,
// otherwise ~/.kin.
func StateDir() (string, error) {
	if dir := strings.TrimSpace(os.Getenv(StateDirEnv)); dir != "" {
		return dir, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("home dir: %w", err)
	}
	return filepath.Join(home, ".kin"), nil
}

// TokenFile returns the path of the daemon auth token.
func TokenFile(stateDir string) string {
	return filepath.Join(stateDir, "token")
}

// EnsureToken loads ~/.kin/token or generates a new 32-byte hex token on first run.
func EnsureToken(stateDir string) (string, error) {
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return "", fmt.Errorf("create state dir: %w", err)
	}
	path := TokenFile(stateDir)
	data, err := os.ReadFile(path)
	if err == nil {
		tok := strings.TrimSpace(string(data))
		if tok != "" {
			return tok, nil
		}
	} else if !os.IsNotExist(err) {
		return "", fmt.Errorf("read token: %w", err)
	}

	return writeNewToken(path)
}

// RotateToken regenerates ~/.kin/token (spec §7.3). Returns the new token.
// A running daemon that re-reads the token file per request picks this up
// without restart; the previous token stops working immediately.
func RotateToken(stateDir string) (string, error) {
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return "", fmt.Errorf("create state dir: %w", err)
	}
	return writeNewToken(TokenFile(stateDir))
}

// ReadToken reads the current token from stateDir (empty string if missing).
func ReadToken(stateDir string) (string, error) {
	data, err := os.ReadFile(TokenFile(stateDir))
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(data)), nil
}

func writeNewToken(path string) (string, error) {
	raw := make([]byte, tokenBytes)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generate token: %w", err)
	}
	tok := hex.EncodeToString(raw)
	if err := os.WriteFile(path, []byte(tok+"\n"), 0o600); err != nil {
		return "", fmt.Errorf("write token: %w", err)
	}
	return tok, nil
}

// Auth protects handlers with Bearer / ?token= auth (spec §6).
// Constant-time compare; 20 failed auth attempts per IP per minute.
//
// When constructed with NewFileAuth, the token is re-read from disk on every
// request so `kin token rotate` takes effect without restarting the daemon
// (see docs/IMPL_NOTES.md).
type Auth struct {
	// staticToken is used when tokenPath is empty (tests / fixed token).
	staticToken string
	// tokenPath, when non-empty, is read on each request.
	tokenPath string

	fail    *failLimiter
	device  DeviceLookup
	session SessionLookup
}

// NewAuth returns middleware-capable auth for a fixed token (tests).
func NewAuth(token string) *Auth {
	return &Auth{
		staticToken: token,
		fail:        newFailLimiter(20, time.Minute),
	}
}

// NewFileAuth returns auth that re-reads the token file per request.
func NewFileAuth(tokenPath string) *Auth {
	return &Auth{
		tokenPath: tokenPath,
		fail:      newFailLimiter(20, time.Minute),
	}
}

// SetDeviceLookup enables scoped device-token authentication in addition to the
// daemon master token. It is intentionally optional for compatibility tests.
func (a *Auth) SetDeviceLookup(lookup DeviceLookup) {
	a.device = lookup
}

// SetSessionLookup enables browser-cookie authentication. It is only wired up
// when the daemon runs in a role that has accounts.
func (a *Auth) SetSessionLookup(lookup SessionLookup) {
	a.session = lookup
}

func (a *Auth) loadToken() (string, error) {
	if a.tokenPath != "" {
		data, err := os.ReadFile(a.tokenPath)
		if err != nil {
			return "", fmt.Errorf("read auth token: %w", err)
		}
		tok := strings.TrimSpace(string(data))
		if tok == "" {
			return "", fmt.Errorf("read auth token: token is empty")
		}
		return tok, nil
	}
	return a.staticToken, nil
}

// Token returns the currently accepted token (from file or static).
// File load failures return an empty token; authentication uses loadToken so
// those failures are never treated as valid credentials.
func (a *Auth) Token() string {
	token, _ := a.loadToken()
	return token
}

// Middleware rejects unauthenticated requests with 401.
func (a *Auth) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, credential, ok := a.resolve(r)
		if ok {
			ctx := context.WithValue(r.Context(), principalContextKey{}, principal)
			ctx = context.WithValue(ctx, tokenContextKey{}, credential)
			next.ServeHTTP(w, r.WithContext(ctx))
			return
		}
		// Resolve first, and check the block only for callers it refused. A
		// caller presenting a valid credential is not guessing -- and the address
		// being counted is one they need not own: behind a tunnel that does not
		// preserve the peer, every visitor to the Hub shares a single one. Doing
		// this the other way round lets one stranger's failed guesses lock the
		// owner out of their own machine, which is the same failure as a global
		// counter and arrives by a shorter route.
		ip := ClientIP(r)
		if a.fail.blocked(ip) {
			http.Error(w, `{"error":"too many auth failures"}`, http.StatusTooManyRequests)
			return
		}
		a.fail.record(ip)
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("WWW-Authenticate", `Bearer realm="kin"`)
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
	})
}

// Identify resolves the caller's principal from the credentials the middleware
// accepts, without requiring one. Routes registered outside the middleware —
// health, version — use it to answer questions whose answer depends on who is
// asking. It never records a failed attempt: those routes stay reachable
// anonymously, so a stranger must not be able to spend someone else's budget.
func (a *Auth) Identify(r *http.Request) (Principal, bool) {
	principal, _, ok := a.resolve(r)
	return principal, ok
}

// resolve maps a request's credentials to a principal. Credential precedence
// lives here alone so the middleware and Identify can never disagree about who
// a caller is.
func (a *Auth) resolve(r *http.Request) (Principal, string, bool) {
	got := extractToken(r)
	want, err := a.loadToken()
	if err == nil && want != "" && secureEqual(got, want) {
		return Principal{Kind: PrincipalMaster, DeviceID: "master", Label: "daemon master token"}, got, true
	}
	if a.device != nil && got != "" {
		if principal, ok := a.device(r.Context(), got); ok {
			return principal, got, true
		}
	}
	// Cookie sessions are checked last: a request that carries an explicit
	// bearer credential is making a deliberate claim, and a stale cookie
	// from the browser must not shadow it.
	if a.session != nil {
		if cookie, err := r.Cookie(SessionCookieName); err == nil && cookie.Value != "" {
			if principal, ok := a.session(r.Context(), cookie.Value); ok {
				return principal, cookie.Value, true
			}
		}
	}
	return Principal{}, "", false
}

// AllowAttempt reports whether ip is still under the auth failure limit.
// Interactive endpoints (login, claim) use it so password guessing trips the
// same per-IP window as token guessing.
func (a *Auth) AllowAttempt(r *http.Request) bool {
	return !a.fail.blocked(ClientIP(r))
}

// NoteFailure records one failed attempt against the request's peer IP.
func (a *Auth) NoteFailure(r *http.Request) {
	a.fail.record(ClientIP(r))
}

func extractToken(r *http.Request) string {
	if h := r.Header.Get("Authorization"); h != "" {
		const p = "Bearer "
		if strings.HasPrefix(h, p) {
			return strings.TrimSpace(h[len(p):])
		}
		// Also accept raw "Bearer" case-insensitive prefix.
		if len(h) > 7 && strings.EqualFold(h[:7], "bearer ") {
			return strings.TrimSpace(h[7:])
		}
	}
	return r.URL.Query().Get("token")
}

func secureEqual(a, b string) bool {
	if len(a) != len(b) {
		// Still do a compare to reduce timing signal on length; use dummy.
		subtle.ConstantTimeCompare([]byte(a), []byte(a))
		return false
	}
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// NewSecret returns a cryptographically random URL-safe secret.
func NewSecret() (string, error) {
	raw := make([]byte, tokenBytes)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generate secret: %w", err)
	}
	return hex.EncodeToString(raw), nil
}

// HashToken returns the fixed-size digest persisted for device credentials and
// pairing sessions. Raw secrets never need to be stored.
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// peerAddrKey stores the address of the connection a request actually arrived
// on, before any middleware has rewritten RemoteAddr from a forwarding header.
type peerAddrKey struct{}

// WithPeerAddr records the TCP peer. The server installs this ahead of
// middleware.RealIP, because RealIP rewrites RemoteAddr from X-Forwarded-For,
// X-Real-IP or True-Client-IP -- all caller-supplied -- and anything that keys
// on "who is asking" must not be a value the asker chooses.
func WithPeerAddr(ctx context.Context, addr string) context.Context {
	return context.WithValue(ctx, peerAddrKey{}, addr)
}

// PeerAddr returns the recorded TCP peer, or "" when nothing recorded one.
func PeerAddr(ctx context.Context) string {
	addr, _ := ctx.Value(peerAddrKey{}).(string)
	return addr
}

// ClientIP is the address a per-caller decision is made about, and the one
// recorded as a session's origin.
//
// It prefers the peer captured by WithPeerAddr over RemoteAddr, because
// middleware.RealIP rewrites RemoteAddr from a header the caller chooses. The
// cost is real and belongs in the open: a Hub behind a tunnel that does not
// preserve the peer address sees every caller as one address, so they share one
// budget. That is a trusted-proxy setting waiting to be written, not a reason to
// trust the header -- trusting it is what makes the limit unenforceable, and the
// limit guards password guessing as well as invitation guessing. The middleware
// answers the obvious follow-up -- so one stranger can deny the owner their own
// machine -- by resolving credentials before consulting the limiter, so a caller
// holding a valid one is never counted against a shared budget.
//
// It is exported because there is exactly one answer to this question. A second
// helper that read RemoteAddr directly, with a comment explaining that RealIP
// had already folded the header in, is how the session audit column came to
// record whatever address the caller asked to be recorded as.
func ClientIP(r *http.Request) string {
	addr := r.RemoteAddr
	if peer := PeerAddr(r.Context()); peer != "" {
		addr = peer
	}
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return addr
	}
	return host
}

type failLimiter struct {
	mu       sync.Mutex
	limit    int
	window   time.Duration
	failures map[string][]time.Time
}

func newFailLimiter(limit int, window time.Duration) *failLimiter {
	return &failLimiter{
		limit:    limit,
		window:   window,
		failures: make(map[string][]time.Time),
	}
}

func (f *failLimiter) record(ip string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	now := time.Now()
	f.failures[ip] = append(prune(f.failures[ip], now, f.window), now)
}

func (f *failLimiter) blocked(ip string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	now := time.Now()
	f.failures[ip] = prune(f.failures[ip], now, f.window)
	return len(f.failures[ip]) >= f.limit
}

func prune(ts []time.Time, now time.Time, window time.Duration) []time.Time {
	cut := now.Add(-window)
	i := 0
	for i < len(ts) && ts[i].Before(cut) {
		i++
	}
	if i == 0 {
		return ts
	}
	return append([]time.Time(nil), ts[i:]...)
}
