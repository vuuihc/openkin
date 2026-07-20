package usagewindows

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const (
	claudeMessagesURL = "https://api.anthropic.com/v1/messages"
	// claudeOAuthTokenURL is the Claude Code OAuth token endpoint (refresh +
	// code exchange). Extracted from the Claude Code CLI binary.
	claudeOAuthTokenURL = "https://platform.claude.com/v1/oauth/token"
	// claudeOAuthClientID is the public Claude Code CLI OAuth client id.
	claudeOAuthClientID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
	// claudeKeychainService is the macOS Keychain service the Claude Code CLI
	// stores its OAuth credentials under.
	claudeKeychainService = "Claude Code-credentials"
	// claudeProbeModel is a cheap model used only to elicit rate-limit headers.
	claudeProbeModel = "claude-haiku-4-5-20251001"
	// claudeSystemPrompt is required: Anthropic only honors these OAuth tokens
	// for Claude Code requests.
	claudeSystemPrompt = "You are Claude Code, Anthropic's official CLI for Claude."
	// claudeRefreshSkew refreshes access tokens this far before expiresAt so
	// probes don't race an in-flight expiry.
	claudeRefreshSkew = 5 * time.Minute
)

// Default scopes match Claude Code CLI QXe when the stored credential has none.
var claudeDefaultScopes = []string{
	"user:profile",
	"user:inference",
	"user:sessions:claude_code",
	"user:mcp_servers",
	"user:file_upload",
}

// ClaudeProber probes Anthropic subscription windows using the OAuth token the
// Claude Code CLI stores (macOS Keychain, or ~/.claude/.credentials.json).
// When the access token is near expiry or a probe returns 401/403, it refreshes
// via the same OAuth endpoint the CLI uses and writes the new tokens back.
type ClaudeProber struct {
	// Home overrides the user home dir (for tests). Empty uses os.UserHomeDir.
	Home   string
	Client *http.Client
	// TokenURL overrides the OAuth token endpoint (for tests).
	TokenURL string
	// readToken overrides credential lookup (for tests).
	readToken func() (claudeStoredCred, error)
	// writeToken overrides credential persistence (for tests).
	writeToken func(claudeStoredCred) error
	// now overrides the clock (for tests).
	now func() time.Time
}

func (c *ClaudeProber) ID() string { return "claude" }

func (c *ClaudeProber) Probe(ctx context.Context) (Provider, error) {
	cred, err := c.loadCred()
	if err != nil {
		return Provider{Provider: "claude", Error: err.Error()}, nil
	}
	if cred.AccessToken == "" && cred.RefreshToken == "" {
		return Provider{Provider: "claude", Error: "claude not logged in"}, nil
	}

	// Proactively refresh when access is missing or near expiry.
	if cred.AccessToken == "" || c.accessExpiringSoon(cred) {
		if cred.RefreshToken == "" {
			return Provider{Provider: "claude", Plan: cred.Plan, Error: "claude token expired; re-login"}, nil
		}
		refreshed, rerr := c.refresh(ctx, cred)
		if rerr != nil {
			return Provider{Provider: "claude", Plan: cred.Plan, Error: rerr.Error()}, nil
		}
		cred = refreshed
	}

	prov, unauthorized := c.probeWithToken(ctx, cred.AccessToken, cred.Plan)
	if !unauthorized {
		return prov, nil
	}

	// Access rejected — refresh once and retry (CLI may have a newer refresh).
	if cred.RefreshToken == "" {
		return Provider{Provider: "claude", Plan: cred.Plan, Error: "claude token expired; re-login"}, nil
	}
	// Re-read in case the CLI refreshed between load and probe.
	if latest, lerr := c.loadCred(); lerr == nil && latest.AccessToken != "" && latest.AccessToken != cred.AccessToken {
		prov2, unauth2 := c.probeWithToken(ctx, latest.AccessToken, latest.Plan)
		if !unauth2 {
			return prov2, nil
		}
		cred = latest
	}
	refreshed, rerr := c.refresh(ctx, cred)
	if rerr != nil {
		return Provider{Provider: "claude", Plan: cred.Plan, Error: rerr.Error()}, nil
	}
	prov2, unauth2 := c.probeWithToken(ctx, refreshed.AccessToken, refreshed.Plan)
	if unauth2 {
		return Provider{Provider: "claude", Plan: refreshed.Plan, Error: "claude token expired; re-login"}, nil
	}
	return prov2, nil
}

// probeWithToken sends the minimal Messages request. unauthorized is true when
// the token was rejected (401/403) and no rate-limit headers were returned.
func (c *ClaudeProber) probeWithToken(ctx context.Context, token, plan string) (Provider, bool) {
	body := fmt.Sprintf(`{"model":%q,"max_tokens":1,"system":%q,`+
		`"messages":[{"role":"user","content":"ok"}]}`, claudeProbeModel, claudeSystemPrompt)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, claudeMessagesURL, strings.NewReader(body))
	if err != nil {
		return Provider{Provider: "claude", Plan: plan, Error: err.Error()}, false
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("anthropic-version", "2023-06-01")
	req.Header.Set("anthropic-beta", "oauth-2025-04-20")
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.client().Do(req)
	if err != nil {
		return Provider{Provider: "claude", Plan: plan, Error: probeError(err)}, false
	}
	defer func() { _ = resp.Body.Close() }()
	// Drain body so the connection can be reused.
	_, _ = io.Copy(io.Discard, resp.Body)

	if resp.Header.Get("anthropic-ratelimit-unified-5h-utilization") == "" &&
		resp.Header.Get("anthropic-ratelimit-unified-7d-utilization") == "" {
		if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
			return Provider{}, true
		}
		return Provider{Provider: "claude", Plan: plan, Error: fmt.Sprintf("no rate-limit headers (HTTP %d)", resp.StatusCode)}, false
	}
	return parseClaudeHeaders(resp.Header, plan), false
}

func (c *ClaudeProber) client() *http.Client {
	if c.Client != nil {
		return c.Client
	}
	return &http.Client{Timeout: 20 * time.Second}
}

func (c *ClaudeProber) clock() time.Time {
	if c.now != nil {
		return c.now()
	}
	return time.Now()
}

func (c *ClaudeProber) tokenURL() string {
	if c.TokenURL != "" {
		return c.TokenURL
	}
	return claudeOAuthTokenURL
}

// claudeStoredCred is the subset of Claude Code OAuth state we need to probe
// and refresh. Raw is the full credential blob for write-back preservation.
type claudeStoredCred struct {
	AccessToken  string
	RefreshToken string
	ExpiresAtMs  int64
	Scopes       []string
	Plan         string
	// Raw is the full JSON object as stored (keychain / file). Empty when the
	// test override only supplies tokens.
	Raw map[string]json.RawMessage
}

type claudeOAuthBlob struct {
	AccessToken      string   `json:"accessToken"`
	RefreshToken     string   `json:"refreshToken"`
	ExpiresAt        int64    `json:"expiresAt"`
	Scopes           []string `json:"scopes"`
	SubscriptionType string   `json:"subscriptionType"`
	RateLimitTier    string   `json:"rateLimitTier,omitempty"`
}

func (c *ClaudeProber) loadCred() (claudeStoredCred, error) {
	read := c.readToken
	if read == nil {
		read = c.readCredentials
	}
	return read()
}

func (c *ClaudeProber) accessExpiringSoon(cred claudeStoredCred) bool {
	if cred.ExpiresAtMs <= 0 {
		// Unknown expiry — still try with current access; 401 path will refresh.
		return false
	}
	deadline := time.UnixMilli(cred.ExpiresAtMs).Add(-claudeRefreshSkew)
	return !c.clock().Before(deadline)
}

// readCredentials returns the Claude Code OAuth tokens and plan. On macOS it
// reads the login Keychain; elsewhere it reads ~/.claude/.credentials.json.
func (c *ClaudeProber) readCredentials() (claudeStoredCred, error) {
	rawBytes, err := c.readRawBytes()
	if err != nil {
		return claudeStoredCred{}, err
	}
	return parseClaudeCredentialJSON(rawBytes)
}

func (c *ClaudeProber) readRawBytes() ([]byte, error) {
	if runtime.GOOS == "darwin" {
		out, err := exec.Command("security", "find-generic-password",
			"-s", claudeKeychainService, "-w").Output()
		if err != nil {
			return nil, fmt.Errorf("claude not logged in")
		}
		return bytes.TrimSpace(out), nil
	}
	home := c.Home
	if home == "" {
		h, err := os.UserHomeDir()
		if err != nil {
			return nil, err
		}
		home = h
	}
	out, err := os.ReadFile(filepath.Join(home, ".claude", ".credentials.json"))
	if err != nil {
		return nil, fmt.Errorf("claude not logged in")
	}
	return out, nil
}

func parseClaudeCredentialJSON(raw []byte) (claudeStoredCred, error) {
	var top map[string]json.RawMessage
	if err := json.Unmarshal(raw, &top); err != nil {
		return claudeStoredCred{}, fmt.Errorf("claude credentials unreadable")
	}
	oauthRaw, ok := top["claudeAiOauth"]
	if !ok {
		return claudeStoredCred{}, fmt.Errorf("claude credentials unreadable")
	}
	var oauth claudeOAuthBlob
	if err := json.Unmarshal(oauthRaw, &oauth); err != nil {
		return claudeStoredCred{}, fmt.Errorf("claude credentials unreadable")
	}
	return claudeStoredCred{
		AccessToken:  oauth.AccessToken,
		RefreshToken: oauth.RefreshToken,
		ExpiresAtMs:  oauth.ExpiresAt,
		Scopes:       oauth.Scopes,
		Plan:         oauth.SubscriptionType,
		Raw:          top,
	}, nil
}

type claudeRefreshRequest struct {
	GrantType    string `json:"grant_type"`
	RefreshToken string `json:"refresh_token"`
	ClientID     string `json:"client_id"`
	Scope        string `json:"scope"`
}

type claudeRefreshResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int64  `json:"expires_in"`
	Scope        string `json:"scope"`
}

func (c *ClaudeProber) refresh(ctx context.Context, cred claudeStoredCred) (claudeStoredCred, error) {
	scopes := cred.Scopes
	if len(scopes) == 0 {
		scopes = claudeDefaultScopes
	}
	body, err := json.Marshal(claudeRefreshRequest{
		GrantType:    "refresh_token",
		RefreshToken: cred.RefreshToken,
		ClientID:     claudeOAuthClientID,
		Scope:        strings.Join(scopes, " "),
	})
	if err != nil {
		return claudeStoredCred{}, fmt.Errorf("claude token refresh: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.tokenURL(), bytes.NewReader(body))
	if err != nil {
		return claudeStoredCred{}, fmt.Errorf("claude token refresh: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.client().Do(req)
	if err != nil {
		return claudeStoredCred{}, fmt.Errorf("claude token refresh: %s", probeError(err))
	}
	defer func() { _ = resp.Body.Close() }()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
			return claudeStoredCred{}, fmt.Errorf("claude token expired; re-login")
		}
		return claudeStoredCred{}, fmt.Errorf("claude token refresh failed (HTTP %d)", resp.StatusCode)
	}
	var tr claudeRefreshResponse
	if err := json.Unmarshal(respBody, &tr); err != nil || tr.AccessToken == "" {
		return claudeStoredCred{}, fmt.Errorf("claude token refresh: bad response")
	}

	now := c.clock()
	out := cred
	out.AccessToken = tr.AccessToken
	if tr.RefreshToken != "" {
		out.RefreshToken = tr.RefreshToken
	}
	if tr.ExpiresIn > 0 {
		out.ExpiresAtMs = now.Add(time.Duration(tr.ExpiresIn) * time.Second).UnixMilli()
	}
	if tr.Scope != "" {
		out.Scopes = strings.Fields(tr.Scope)
	}

	if err := c.persistCred(out); err != nil {
		// Still return the refreshed tokens for this probe; persistence is best-effort.
		// Surface a soft note only if we have no way to use the token again.
		_ = err
	}
	return out, nil
}

func (c *ClaudeProber) persistCred(cred claudeStoredCred) error {
	write := c.writeToken
	if write == nil {
		write = c.writeCredentials
	}
	return write(cred)
}

func (c *ClaudeProber) writeCredentials(cred claudeStoredCred) error {
	payload, err := buildClaudeCredentialJSON(cred)
	if err != nil {
		return err
	}
	if runtime.GOOS == "darwin" {
		return writeClaudeKeychain(payload)
	}
	home := c.Home
	if home == "" {
		h, err := os.UserHomeDir()
		if err != nil {
			return err
		}
		home = h
	}
	dir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	path := filepath.Join(dir, ".credentials.json")
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, payload, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func buildClaudeCredentialJSON(cred claudeStoredCred) ([]byte, error) {
	top := map[string]json.RawMessage{}
	for k, v := range cred.Raw {
		top[k] = v
	}
	// Merge oauth fields onto any previous oauth object so we keep rateLimitTier etc.
	var oauth claudeOAuthBlob
	if raw, ok := top["claudeAiOauth"]; ok {
		_ = json.Unmarshal(raw, &oauth)
	}
	oauth.AccessToken = cred.AccessToken
	oauth.RefreshToken = cred.RefreshToken
	oauth.ExpiresAt = cred.ExpiresAtMs
	if len(cred.Scopes) > 0 {
		oauth.Scopes = cred.Scopes
	}
	if cred.Plan != "" {
		oauth.SubscriptionType = cred.Plan
	}
	oauthBytes, err := json.Marshal(oauth)
	if err != nil {
		return nil, err
	}
	top["claudeAiOauth"] = oauthBytes
	return json.Marshal(top)
}

func writeClaudeKeychain(payload []byte) error {
	account := os.Getenv("USER")
	if account == "" {
		account = "Claude Code"
	}
	// Prefer the account name already stored in the Keychain entry.
	if out, err := exec.Command("security", "find-generic-password",
		"-s", claudeKeychainService).CombinedOutput(); err == nil {
		if acct := parseKeychainAccount(string(out)); acct != "" {
			account = acct
		}
	}
	// -U updates an existing item; password is passed via argv (same as CLI).
	cmd := exec.Command("security", "add-generic-password",
		"-U",
		"-s", claudeKeychainService,
		"-a", account,
		"-w", string(payload),
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("keychain write: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// parseKeychainAccount extracts "acct"<blob>="name" from security find output.
func parseKeychainAccount(out string) string {
	// Format: "acct"<blob>="vuuihc"
	const marker = `"acct"<blob>=`
	i := strings.Index(out, marker)
	if i < 0 {
		return ""
	}
	rest := out[i+len(marker):]
	rest = strings.TrimSpace(rest)
	if strings.HasPrefix(rest, `"`) {
		rest = rest[1:]
		if j := strings.Index(rest, `"`); j >= 0 {
			return rest[:j]
		}
	}
	return ""
}
