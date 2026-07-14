package remote

import (
	"crypto/rand"
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

	fail *failLimiter
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

// Token returns the currently accepted token (from file or static).
func (a *Auth) Token() string {
	if a.tokenPath != "" {
		data, err := os.ReadFile(a.tokenPath)
		if err == nil {
			if tok := strings.TrimSpace(string(data)); tok != "" {
				return tok
			}
		}
	}
	return a.staticToken
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
		want := a.Token()
		if !secureEqual(got, want) {
			a.fail.record(ip)
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("WWW-Authenticate", `Bearer realm="kin"`)
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
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
