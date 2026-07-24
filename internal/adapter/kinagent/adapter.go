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

// TranscriptStore loads/saves the durable Kin multi-turn messages array (ADR 0002 P1.5).
// When unset, each Start rebuilds from a single user prompt (cold pack / handoff path).
type TranscriptStore interface {
	LoadKinMessages(ctx context.Context, taskID string) ([]provider.Message, error)
	SaveKinMessages(ctx context.Context, taskID string, msgs []provider.Message) error
}

// Adapter implements adapter.Adapter for agent "kin".
type Adapter struct {
	Resolve Resolver
	// SystemPrompt optional override.
	SystemPrompt string
	// Transcript optional durable multi-turn store.
	Transcript TranscriptStore
	// Search optional event archive search for session_search tool.
	Search SessionSearcher
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

		// Prefer durable multi-turn transcript when present (same-agent follow-up).
		// Otherwise cold-start from the (possibly handoff-packed) user prompt.
		var prior []provider.Message
		if a.Transcript != nil && spec.ID != "" {
			if loaded, err := a.Transcript.LoadKinMessages(ctx, spec.ID); err == nil && len(loaded) > 0 {
				prior = loaded
			}
		}

		sessionID := "kin:" + spec.ID
		if sessionID == "kin:" {
			sessionID = "kin-loop"
		}
		sidPayload, _ := json.Marshal(map[string]any{
			"session_id": sessionID,
			"subtype":    "init",
			"source":     "kin",
			"model":      model,
			"provider":   client.Kind(),
			"mode":       "agent_loop",
			"cwd":        spec.Cwd,
			"resume":     len(prior) > 0,
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

		finalMsgs := runAgentLoop(runCtx, client, model, sys, spec.Prompt, spec.Cwd, spec.ID, a.Search, prior, ch, h.cancel)
		if a.Transcript != nil && spec.ID != "" && len(finalMsgs) > 0 {
			// Persist full model-path transcript for next same-agent follow-up (Policy K).
			_ = a.Transcript.SaveKinMessages(context.Background(), spec.ID, finalMsgs)
		}
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
- session_search: keyword search over this task's archived events when digests omitted detail.

Behavior:
- For programming work: explore with tools, make changes, run checks, then summarize for the user.
- For pure Q&A with no repo work: answer directly without tools.
- Be concise. Do not claim you edited files unless write_file/bash actually succeeded.
- If stuck after several attempts, explain what failed and stop.
- Reply in the same language as the user's latest message. Keep the final user-facing summary in that language unless they explicitly requested a different reply language. Tool output, source code, and docs may stay as-is.

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
