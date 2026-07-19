package usagewindows

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const codexResponsesURL = "https://chatgpt.com/backend-api/codex/responses"

// codexDefaultModel is used when ~/.codex/config.toml does not pin a model.
// A valid model is required so the request reaches the rate limiter; when the
// account is already over its limit any model returns 429 + the headers.
const codexDefaultModel = "gpt-5.6-sol"

// CodexProber probes ChatGPT/Codex subscription windows using the OAuth token
// stored by the Codex CLI in ~/.codex/auth.json.
type CodexProber struct {
	// Home overrides the user home dir (for tests). Empty uses os.UserHomeDir.
	Home   string
	Client *http.Client
}

func (c *CodexProber) ID() string { return "codex" }

func (c *CodexProber) home() (string, error) {
	if c.Home != "" {
		return c.Home, nil
	}
	return os.UserHomeDir()
}

type codexAuth struct {
	Tokens struct {
		AccessToken string `json:"access_token"`
		AccountID   string `json:"account_id"`
	} `json:"tokens"`
}

func (c *CodexProber) Probe(ctx context.Context) (Provider, error) {
	home, err := c.home()
	if err != nil {
		return Provider{Provider: "codex", Error: "no home dir"}, nil
	}
	raw, err := os.ReadFile(filepath.Join(home, ".codex", "auth.json"))
	if err != nil {
		return Provider{Provider: "codex", Error: "codex not logged in"}, nil
	}
	var auth codexAuth
	if err := json.Unmarshal(raw, &auth); err != nil || auth.Tokens.AccessToken == "" {
		return Provider{Provider: "codex", Error: "codex credentials unreadable"}, nil
	}

	model := codexModel(home)
	body := fmt.Sprintf(`{"model":%q,"input":[{"type":"message","role":"user",`+
		`"content":[{"type":"input_text","text":"ok"}]}],"stream":true,"store":false}`, model)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, codexResponsesURL, strings.NewReader(body))
	if err != nil {
		return Provider{Provider: "codex", Error: err.Error()}, nil
	}
	req.Header.Set("Authorization", "Bearer "+auth.Tokens.AccessToken)
	req.Header.Set("chatgpt-account-id", auth.Tokens.AccountID)
	req.Header.Set("OpenAI-Beta", "responses=experimental")
	req.Header.Set("originator", "codex_cli_rs")
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.client().Do(req)
	if err != nil {
		return Provider{Provider: "codex", Error: probeError(err)}, nil
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.Header.Get("x-codex-primary-window-minutes") == "" &&
		resp.Header.Get("x-codex-secondary-window-minutes") == "" {
		if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
			return Provider{Provider: "codex", Error: "codex token expired; re-login"}, nil
		}
		return Provider{Provider: "codex", Error: fmt.Sprintf("no rate-limit headers (HTTP %d)", resp.StatusCode)}, nil
	}
	return parseCodexHeaders(resp.Header), nil
}

func (c *CodexProber) client() *http.Client {
	if c.Client != nil {
		return c.Client
	}
	return &http.Client{Timeout: 20 * time.Second}
}

// codexModel reads the pinned model from ~/.codex/config.toml, falling back to
// codexDefaultModel. It does a minimal line scan rather than pulling in a TOML
// dependency.
func codexModel(home string) string {
	f, err := os.Open(filepath.Join(home, ".codex", "config.toml"))
	if err != nil {
		return codexDefaultModel
	}
	defer func() { _ = f.Close() }()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if strings.HasPrefix(line, "[") { // stop at first table; top-level model only
			break
		}
		if v, ok := tomlString(line, "model"); ok && v != "" {
			return v
		}
	}
	return codexDefaultModel
}

// tomlString parses a top-level `key = "value"` line.
func tomlString(line, key string) (string, bool) {
	if !strings.HasPrefix(line, key) {
		return "", false
	}
	rest := strings.TrimSpace(strings.TrimPrefix(line, key))
	if !strings.HasPrefix(rest, "=") {
		return "", false
	}
	val := strings.TrimSpace(strings.TrimPrefix(rest, "="))
	val = strings.TrimSpace(strings.SplitN(val, "#", 2)[0])
	if len(val) >= 2 && (val[0] == '"' || val[0] == '\'') {
		return strings.Trim(val, "\"'"), true
	}
	return val, val != ""
}

// probeError shortens noisy transport errors.
func probeError(err error) string {
	msg := err.Error()
	if i := bytes.IndexByte([]byte(msg), '\n'); i > 0 {
		msg = msg[:i]
	}
	return msg
}
