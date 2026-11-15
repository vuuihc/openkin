// Package execcap provides scoped execution capabilities for workspace lifecycle.
//
// A capability is a compact HMAC-SHA256 token that binds an execution identity
// (task, execution, agent) to a set of scopes and an expiry. Capabilities are
// issued by the daemon, written to a file for the adapter process, and verified
// by the MCP bridge to authorize workspace lifecycle requests (request_workspace,
// complete_workspace) without exposing the global bearer token.
package execcap

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"
)

// Claims carries the execution identity embedded in a capability.
type Claims struct {
	TaskID      string   `json:"task_id"`
	ExecutionID string   `json:"execution_id"`
	Agent       string   `json:"agent"`
	Step        int      `json:"step,omitempty"`
	Model       string   `json:"model,omitempty"`
	Scopes      []string `json:"scopes"`
	ExpiresAt   int64    `json:"expires_at"`
	Nonce       string   `json:"nonce"`
}

// IsExpired reports whether the capability has expired relative to now.
func (c Claims) IsExpired(now time.Time) bool {
	return now.UnixMilli() > c.ExpiresAt
}

// Issuer creates and verifies HMAC-signed capabilities.
type Issuer struct {
	mu       sync.RWMutex
	secret   []byte
	issuedAt int64
}

// NewIssuer creates an Issuer with a random 32-byte secret.
func NewIssuer() *Issuer {
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		panic(fmt.Sprintf("execcap: generate secret: %v", err))
	}
	return &Issuer{
		secret:   secret,
		issuedAt: time.Now().UnixMilli(),
	}
}

// Issue creates a signed capability token string for the given claims.
// TaskID and ExecutionID are required; non-empty.
func (iss *Issuer) Issue(taskID, executionID, agent string, step int, model string, scopes []string, ttl time.Duration) (string, error) {
	if taskID == "" {
		return "", fmt.Errorf("execcap: task_id is required")
	}
	if executionID == "" {
		return "", fmt.Errorf("execcap: execution_id is required")
	}
	if ttl <= 0 {
		ttl = 5 * time.Minute
	}

	nonceBytes := make([]byte, 16)
	if _, err := rand.Read(nonceBytes); err != nil {
		return "", fmt.Errorf("execcap: generate nonce: %w", err)
	}
	nonce := base64.RawURLEncoding.EncodeToString(nonceBytes)

	if scopes == nil {
		scopes = []string{}
	}

	claims := Claims{
		TaskID:      taskID,
		ExecutionID: executionID,
		Agent:       agent,
		Step:        step,
		Model:       model,
		Scopes:      scopes,
		ExpiresAt:   time.Now().Add(ttl).UnixMilli(),
		Nonce:       nonce,
	}

	payload, err := json.Marshal(claims)
	if err != nil {
		return "", fmt.Errorf("execcap: marshal claims: %w", err)
	}

	iss.mu.RLock()
	sig := sign(payload, iss.secret)
	iss.mu.RUnlock()

	token := base64.RawURLEncoding.EncodeToString(payload) + "." + base64.RawURLEncoding.EncodeToString(sig)
	return token, nil
}

// Verify validates a capability token and returns the embedded claims.
// Returns an error if the token is malformed, signature is invalid, or claims
// are expired.
func (iss *Issuer) Verify(token string) (Claims, error) {
	parts := strings.SplitN(token, ".", 2)
	if len(parts) != 2 {
		return Claims{}, fmt.Errorf("execcap: malformed token")
	}

	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return Claims{}, fmt.Errorf("execcap: decode payload: %w", err)
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return Claims{}, fmt.Errorf("execcap: decode signature: %w", err)
	}

	iss.mu.RLock()
	expected := sign(payload, iss.secret)
	iss.mu.RUnlock()

	if !hmac.Equal(sig, expected) {
		return Claims{}, fmt.Errorf("execcap: invalid signature")
	}

	var claims Claims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return Claims{}, fmt.Errorf("execcap: unmarshal claims: %w", err)
	}

	if claims.IsExpired(time.Now()) {
		return Claims{}, fmt.Errorf("execcap: token expired")
	}

	return claims, nil
}

// Rotate generates a new secret. Previously issued tokens become invalid.
func (iss *Issuer) Rotate() {
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		panic(fmt.Sprintf("execcap: rotate secret: %v", err))
	}
	iss.mu.Lock()
	iss.secret = secret
	iss.issuedAt = time.Now().UnixMilli()
	iss.mu.Unlock()
}

// IssuedAt returns the timestamp (epoch ms) when the current secret was created.
func (iss *Issuer) IssuedAt() int64 {
	iss.mu.RLock()
	defer iss.mu.RUnlock()
	return iss.issuedAt
}

func sign(payload, secret []byte) []byte {
	mac := hmac.New(sha256.New, secret)
	mac.Write(payload)
	return mac.Sum(nil)
}
