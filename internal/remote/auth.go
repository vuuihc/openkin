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
}

const (
	PrincipalMaster = "master"
	PrincipalDevice = "device"
)

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

	fail   *failLimiter
	device DeviceLookup
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
		ip := clientIP(r)
		if a.fail.blocked(ip) {
			http.Error(w, `{"error":"too many auth failures"}`, http.StatusTooManyRequests)
			return
		}
		got := extractToken(r)
		want, err := a.loadToken()
		if err == nil && want != "" && secureEqual(got, want) {
			ctx := context.WithValue(r.Context(), principalContextKey{}, Principal{Kind: PrincipalMaster, DeviceID: "master", Label: "daemon master token"})
			ctx = context.WithValue(ctx, tokenContextKey{}, got)
			next.ServeHTTP(w, r.WithContext(ctx))
			return
		}
		if a.device != nil {
			if principal, ok := a.device(r.Context(), got); ok {
				ctx := context.WithValue(r.Context(), principalContextKey{}, principal)
				ctx = context.WithValue(ctx, tokenContextKey{}, got)
				next.ServeHTTP(w, r.WithContext(ctx))
				return
			}
		}
		{
			a.fail.record(ip)
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("WWW-Authenticate", `Bearer realm="kin"`)
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}
	})
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

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
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
