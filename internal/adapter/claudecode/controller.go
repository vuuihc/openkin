package claudecode

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/vuuihc/kin/internal/adapter"
	"github.com/vuuihc/kin/internal/agent"
)

// Controller is a read-only control-plane completion via Claude CLI.
// It disables tools, session persistence, and uses plan/safe mode.
type Controller struct {
	Binary   string
	LookPath func(file string) (string, error)
	// Timeout default when request has none.
	Timeout time.Duration
	// Run allows tests to stub process execution.
	Run func(ctx context.Context, name string, args []string, cwd string) ([]byte, error)
}

// Complete implements agent.Controller.
func (c *Controller) Complete(ctx context.Context, req agent.ControlRequest) (agent.ControlResult, error) {
	bin := c.Binary
	if bin == "" {
		bin = "claude"
	}
	look := c.LookPath
	if look == nil {
		look = exec.LookPath
	}
	path, err := look(bin)
	if err != nil {
		return agent.ControlResult{}, fmt.Errorf("claude controller: binary not found: %w", err)
	}

	timeout := req.Timeout
	if timeout <= 0 {
		timeout = c.Timeout
	}
	if timeout <= 0 {
		timeout = 90 * time.Second
	}
	callCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	prompt := strings.TrimSpace(req.Prompt)
	if prompt == "" {
		return agent.ControlResult{}, fmt.Errorf("claude controller: empty prompt")
	}
	if len([]rune(prompt)) > 12000 {
		r := []rune(prompt)
		prompt = string(r[:12000]) + "…"
	}

	args := []string{
		"-p", prompt,
		"--output-format", "json",
		"--permission-mode", "plan",
		"--tools", "",
		"--no-session-persistence",
		"--safe-mode",
	}
	if m := strings.TrimSpace(req.Model); m != "" {
		args = append(args, "--model", m)
	}

	run := c.Run
	if run == nil {
		run = func(ctx context.Context, name string, args []string, cwd string) ([]byte, error) {
			cmd := exec.CommandContext(ctx, name, args...)
			if cwd != "" {
				cmd.Dir = cwd
			}
			cmd.Env = os.Environ()
			var stdout, stderr bytes.Buffer
			cmd.Stdout = &stdout
			cmd.Stderr = &stderr
			err := cmd.Run()
			if err != nil {
				msg := strings.TrimSpace(stderr.String())
				if msg == "" {
					msg = err.Error()
				}
				return stdout.Bytes(), fmt.Errorf("claude controller: %s", msg)
			}
			return stdout.Bytes(), nil
		}
	}

	out, err := run(callCtx, path, args, req.Cwd)
	if err != nil {
		return agent.ControlResult{}, err
	}
	text, usage, parseErr := parseControlJSON(out)
	if parseErr != nil {
		return agent.ControlResult{}, parseErr
	}
	if strings.TrimSpace(text) == "" {
		return agent.ControlResult{}, fmt.Errorf("claude controller: blank output")
	}
	if usage.Model == "" {
		usage.Model = req.Model
	}
	return agent.ControlResult{Text: text, Usage: usage}, nil
}

func parseControlJSON(raw []byte) (string, agent.ControlUsage, error) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return "", agent.ControlUsage{}, fmt.Errorf("claude controller: empty output")
	}
	// Prefer adapter result parsing for terminal text/usage.
	// Claude --output-format json may be a single result object or stream lines.
	var usage agent.ControlUsage
	// Try whole blob first.
	if res, ok := adapter.ParseResult(json.RawMessage(raw)); ok && strings.TrimSpace(res.Text) != "" {
		usage = agent.ControlUsage{
			Model:    res.Usage.Model,
			TokensIn: res.Usage.TokensIn,
			TokensOut: res.Usage.TokensOut,
			CachedTokens: res.Usage.CachedTokens,
			CostUSD:  res.Usage.CostUSD,
		}
		return res.Text, usage, nil
	}
	// Stream-json lines: take last parseable result/text.
	var lastText string
	for _, line := range bytes.Split(raw, []byte("\n")) {
		line = bytes.TrimSpace(line)
		if len(line) == 0 {
			continue
		}
		if res, ok := adapter.ParseResult(json.RawMessage(line)); ok && strings.TrimSpace(res.Text) != "" {
			lastText = res.Text
			usage = agent.ControlUsage{
				Model:        res.Usage.Model,
				TokensIn:     res.Usage.TokensIn,
				TokensOut:    res.Usage.TokensOut,
				CachedTokens: res.Usage.CachedTokens,
				CostUSD:      res.Usage.CostUSD,
			}
			continue
		}
		var m map[string]any
		if json.Unmarshal(line, &m) != nil {
			continue
		}
		if t, _ := m["result"].(string); strings.TrimSpace(t) != "" {
			lastText = t
		} else if t, _ := m["text"].(string); strings.TrimSpace(t) != "" {
			lastText = t
		}
	}
	if strings.TrimSpace(lastText) == "" {
		// Fall back to raw text if not JSON.
		if !json.Valid(raw) {
			return string(raw), usage, nil
		}
		return "", usage, fmt.Errorf("claude controller: could not parse output")
	}
	return lastText, usage, nil
}
