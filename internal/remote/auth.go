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

// EnsureToken loads ~/.kin/token or generates a new 32-byte hex token on first run.
func EnsureToken(stateDir string) (string, error) {
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return "", fmt.Errorf("create state dir: %w", err)
	}
	path := filepath.Join(stateDir, "token")
	data, err := os.ReadFile(path)
	if err == nil {
		tok := strings.TrimSpace(string(data))
		if tok != "" {
			return tok, nil
		}
	} else if !os.IsNotExist(err) {
		return "", fmt.Errorf("read token: %w", err)
	}

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
type Auth struct {
	token string
	fail  *failLimiter
}

// NewAuth returns middleware-capable auth for the given token.
func NewAuth(token string) *Auth {
	return &Auth{
		token: token,
		fail:  newFailLimiter(20, time.Minute),
	}
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
		if !secureEqual(got, a.token) {
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
