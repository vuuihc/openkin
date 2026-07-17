// Package kinagent is the built-in "kin" agent: Kin + cognition Provider.
// Runs a native tool-using agent loop (bash / read / write / list / glob)
// inside the task cwd. Unlike CLI adapters, it does not shell out to Claude/Codex.
package kinagent

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"

	"github.com/vuuihc/kin/internal/adapter"
	"github.com/vuuihc/kin/internal/provider"
)

// AgentID is the engine / API agent key.
const AgentID = "kin"

// Resolver loads a provider client for each run (settings can change without restart).
type Resolver func(ctx context.Context) (provider.Client, provider.Config, error)

// Adapter implements adapter.Adapter for agent "kin".
type Adapter struct {
	Resolve Resolver
	// SystemPrompt optional override.
	SystemPrompt string
}

// New returns a Kin agent adapter.
func New(resolve Resolver) *Adapter {
	return &Adapter{Resolve: resolve}
}

// Start runs the Kin agent loop for the task prompt.
func (a *Adapter) Start(ctx context.Context, spec adapter.TaskSpec) (adapter.RunHandle, error) {
	if a.Resolve == nil {
		return nil, fmt.Errorf("kin agent: provider resolver not configured")
	}
	client, cfg, err := a.Resolve(ctx)
	if err != nil {
		return nil, fmt.Errorf("kin agent: provider: %w", err)
	}
	if client == nil {
		return nil, fmt.Errorf("kin agent: configure provider in Settings (base_url + model)")
	}

	sys := a.SystemPrompt
	if sys == "" {
		sys = defaultSystemPrompt
	}
	model := spec.Model
	if model == "" {
		model = cfg.Model
	}

	ch := make(chan adapter.Event, 32)
	h := &handle{ch: ch, cancel: make(chan struct{})}

	go func() {
		defer close(ch)

		sidPayload, _ := json.Marshal(map[string]any{
			"session_id": "kin:" + spec.ID,
			"subtype":    "init",
			"source":     "kin",
			"model":      model,
			"provider":   client.Kind(),
			"mode":       "agent_loop",
			"cwd":        spec.Cwd,
		})
		select {
		case <-h.cancel:
			return
		case ch <- adapter.Event{Type: "task_started", Payload: sidPayload}:
		}

		runCtx, cancel := context.WithCancel(ctx)
		defer cancel()
		go func() {
			select {
			case <-h.cancel:
				cancel()
			case <-runCtx.Done():
			}
		}()

		// Inject session id into result via wrapper channel is awkward; set in loop emitResult.
		// Patch: run loop then fix session on result events is skippable — UI uses speaker.
		runAgentLoop(runCtx, client, model, sys, spec.Prompt, spec.Cwd, ch, h.cancel)
	}()

	return h, nil
}

const defaultSystemPrompt = `You are Kin — a local coding agent with tools. You run an agent loop (think → tools → observe → repeat) until the task is done.

Workspace:
- All tools are sandboxed to the task working directory (cwd).
- Prefer relative paths.

Tools:
- bash: run shell commands (tests, git status, builds). Non-interactive only.
- read_file / write_file / list_dir / glob: inspect and edit files.

Behavior:
- For programming work: explore with tools, make changes, run checks, then summarize for the user.
- For pure Q&A with no repo work: answer directly without tools.
- Be concise. Do not claim you edited files unless write_file/bash actually succeeded.
- If stuck after several attempts, explain what failed and stop.

You converse with the user; sub-agents (@claude / @codex) are optional and handled by the Kin orchestrator when the user mentions them.`

type handle struct {
	ch     chan adapter.Event
	cancel chan struct{}
	once   sync.Once
}

func (h *handle) Events() <-chan adapter.Event { return h.ch }

func (h *handle) Cancel() error {
	h.once.Do(func() { close(h.cancel) })
	return nil
}
