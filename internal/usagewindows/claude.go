package usagewindows

import (
	"context"
	"encoding/json"
	"fmt"
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
	// claudeKeychainService is the macOS Keychain service the Claude Code CLI
	// stores its OAuth credentials under.
	claudeKeychainService = "Claude Code-credentials"
	// claudeProbeModel is a cheap model used only to elicit rate-limit headers.
	claudeProbeModel = "claude-haiku-4-5-20251001"
	// claudeSystemPrompt is required: Anthropic only honors these OAuth tokens
	// for Claude Code requests.
	claudeSystemPrompt = "You are Claude Code, Anthropic's official CLI for Claude."
)

// ClaudeProber probes Anthropic subscription windows using the OAuth token the
// Claude Code CLI stores (macOS Keychain, or ~/.claude/.credentials.json).
type ClaudeProber struct {
	// Home overrides the user home dir (for tests). Empty uses os.UserHomeDir.
	Home   string
	Client *http.Client
	// readToken overrides credential lookup (for tests).
	readToken func() (token, plan string, err error)
}

func (c *ClaudeProber) ID() string { return "claude" }

func (c *ClaudeProber) Probe(ctx context.Context) (Provider, error) {
	read := c.readToken
	if read == nil {
		read = c.readCredentials
	}
	token, plan, err := read()
	if err != nil {
		return Provider{Provider: "claude", Error: err.Error()}, nil
	}
	if token == "" {
		return Provider{Provider: "claude", Error: "claude not logged in"}, nil
	}

	body := fmt.Sprintf(`{"model":%q,"max_tokens":1,"system":%q,`+
		`"messages":[{"role":"user","content":"ok"}]}`, claudeProbeModel, claudeSystemPrompt)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, claudeMessagesURL, strings.NewReader(body))
	if err != nil {
		return Provider{Provider: "claude", Error: err.Error()}, nil
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("anthropic-version", "2023-06-01")
	req.Header.Set("anthropic-beta", "oauth-2025-04-20")
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.client().Do(req)
	if err != nil {
		return Provider{Provider: "claude", Error: probeError(err)}, nil
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.Header.Get("anthropic-ratelimit-unified-5h-utilization") == "" &&
		resp.Header.Get("anthropic-ratelimit-unified-7d-utilization") == "" {
		if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
			return Provider{Provider: "claude", Plan: plan, Error: "claude token expired; re-login"}, nil
		}
		return Provider{Provider: "claude", Plan: plan, Error: fmt.Sprintf("no rate-limit headers (HTTP %d)", resp.StatusCode)}, nil
	}
	return parseClaudeHeaders(resp.Header, plan), nil
}

func (c *ClaudeProber) client() *http.Client {
	if c.Client != nil {
		return c.Client
	}
	return &http.Client{Timeout: 20 * time.Second}
}

type claudeCredential struct {
	ClaudeAiOauth struct {
		AccessToken      string `json:"accessToken"`
		SubscriptionType string `json:"subscriptionType"`
	} `json:"claudeAiOauth"`
}

// readCredentials returns the Claude Code OAuth access token and plan. On macOS
// it reads the login Keychain; elsewhere it reads ~/.claude/.credentials.json.
func (c *ClaudeProber) readCredentials() (string, string, error) {
	var raw []byte
	if runtime.GOOS == "darwin" {
		out, err := exec.Command("security", "find-generic-password",
			"-s", claudeKeychainService, "-w").Output()
		if err != nil {
			return "", "", fmt.Errorf("claude not logged in")
		}
		raw = out
	} else {
		home := c.Home
		if home == "" {
			h, err := os.UserHomeDir()
			if err != nil {
				return "", "", err
			}
			home = h
		}
		out, err := os.ReadFile(filepath.Join(home, ".claude", ".credentials.json"))
		if err != nil {
			return "", "", fmt.Errorf("claude not logged in")
		}
		raw = out
	}
	var cred claudeCredential
	if err := json.Unmarshal(raw, &cred); err != nil {
		return "", "", fmt.Errorf("claude credentials unreadable")
	}
	return cred.ClaudeAiOauth.AccessToken, cred.ClaudeAiOauth.SubscriptionType, nil
}
