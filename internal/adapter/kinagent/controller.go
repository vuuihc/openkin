package kinagent

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/vuuihc/kin/internal/agent"
	"github.com/vuuihc/kin/internal/provider"
)

// Controller is a read-only control-plane completion for Kin.
// It calls the configured provider with no tools.
type Controller struct {
	Resolve Resolver
	// SystemPrompt optional override for control-plane calls.
	SystemPrompt string
	// Timeout default when request has none.
	Timeout time.Duration
}

const defaultControlSystem = `You are Kin's control-plane assistant for multi-agent orchestration.
You may only produce text. Do not claim you ran tools or modified files.
Follow the user instructions exactly and keep output concise.`

// Complete implements agent.Controller.
func (c *Controller) Complete(ctx context.Context, req agent.ControlRequest) (agent.ControlResult, error) {
	if c == nil || c.Resolve == nil {
		return agent.ControlResult{}, fmt.Errorf("kin controller: not configured")
	}
	timeout := req.Timeout
	if timeout <= 0 {
		timeout = c.Timeout
	}
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	callCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	client, cfg, err := c.Resolve(callCtx)
	if err != nil {
		return agent.ControlResult{}, err
	}
	if client == nil || !cfg.Configured() {
		return agent.ControlResult{}, fmt.Errorf("kin controller: provider not configured")
	}

	sys := c.SystemPrompt
	if sys == "" {
		sys = defaultControlSystem
	}
	model := strings.TrimSpace(req.Model)
	if model == "" {
		model = cfg.Model
	}
	prompt := strings.TrimSpace(req.Prompt)
	if prompt == "" {
		return agent.ControlResult{}, fmt.Errorf("kin controller: empty prompt")
	}

	// Soft prompt size guard.
	if len([]rune(prompt)) > 12000 {
		r := []rune(prompt)
		prompt = string(r[:12000]) + "…"
	}

	msgs := []provider.Message{
		{Role: "system", Content: sys},
		{Role: "user", Content: prompt},
	}
	// No tools: control plane is read-only text completion.
	resp, err := client.Chat(callCtx, provider.ChatRequest{
		Model:    model,
		Messages: msgs,
	})
	if err != nil {
		return agent.ControlResult{}, err
	}
	text := strings.TrimSpace(resp.Content)
	usage := agent.ControlUsage{
		Model:        model,
		TokensIn:     resp.Usage.PromptTokens,
		TokensOut:    resp.Usage.CompletionTokens,
		CachedTokens: resp.Usage.CachedTokens,
	}
	return agent.ControlResult{Text: text, Usage: usage}, nil
}
