package codex

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

// Controller is a read-only control-plane completion via Codex CLI.
// Uses read-only sandbox and ephemeral session flags.
type Controller struct {
	Binary   string
	LookPath func(file string) (string, error)
	Timeout  time.Duration
	Run      func(ctx context.Context, name string, args []string, cwd string) ([]byte, error)
}

// Complete implements agent.Controller.
func (c *Controller) Complete(ctx context.Context, req agent.ControlRequest) (agent.ControlResult, error) {
	bin := c.Binary
	if bin == "" {
		bin = "codex"
	}
	look := c.LookPath
	if look == nil {
		look = exec.LookPath
	}
	path, err := look(bin)
	if err != nil {
		return agent.ControlResult{}, fmt.Errorf("codex controller: binary not found: %w", err)
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
		return agent.ControlResult{}, fmt.Errorf("codex controller: empty prompt")
	}
	if len([]rune(prompt)) > 12000 {
		r := []rune(prompt)
		prompt = string(r[:12000]) + "…"
	}

	args := []string{
		"exec",
		"--json",
		"--sandbox", "read-only",
		"--ephemeral",
		"--ignore-rules",
	}
	if m := strings.TrimSpace(req.Model); m != "" {
		args = append(args, "--model", m)
	}
	args = append(args, prompt)

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
				return stdout.Bytes(), fmt.Errorf("codex controller: %s", msg)
			}
			return stdout.Bytes(), nil
		}
	}

	out, err := run(callCtx, path, args, req.Cwd)
	if err != nil {
		return agent.ControlResult{}, err
	}
	text, usage, parseErr := parseCodexControlOutput(out)
	if parseErr != nil {
		return agent.ControlResult{}, parseErr
	}
	if strings.TrimSpace(text) == "" {
		return agent.ControlResult{}, fmt.Errorf("codex controller: blank output")
	}
	if usage.Model == "" {
		usage.Model = req.Model
	}
	return agent.ControlResult{Text: text, Usage: usage}, nil
}

func parseCodexControlOutput(raw []byte) (string, agent.ControlUsage, error) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return "", agent.ControlUsage{}, fmt.Errorf("codex controller: empty output")
	}
	var usage agent.ControlUsage
	var lastText string
	// Codex --json is typically NDJSON events.
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
		// Common codex shapes: message/item text.
		if t, _ := m["text"].(string); strings.TrimSpace(t) != "" {
			lastText = t
		}
		if t, _ := m["result"].(string); strings.TrimSpace(t) != "" {
			lastText = t
		}
		if item, ok := m["item"].(map[string]any); ok {
			if t, _ := item["text"].(string); strings.TrimSpace(t) != "" {
				lastText = t
			}
		}
		if msg, ok := m["msg"].(map[string]any); ok {
			if t, _ := msg["text"].(string); strings.TrimSpace(t) != "" {
				lastText = t
			}
		}
	}
	if strings.TrimSpace(lastText) == "" {
		if res, ok := adapter.ParseResult(json.RawMessage(raw)); ok && strings.TrimSpace(res.Text) != "" {
			return res.Text, agent.ControlUsage{
				Model: res.Usage.Model, TokensIn: res.Usage.TokensIn,
				TokensOut: res.Usage.TokensOut, CostUSD: res.Usage.CostUSD,
			}, nil
		}
		if !json.Valid(raw) {
			return string(raw), usage, nil
		}
		return "", usage, fmt.Errorf("codex controller: could not parse output")
	}
	return lastText, usage, nil
}
