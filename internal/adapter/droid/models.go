package droid

import (
	"bufio"
	"context"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/vuuihc/openkin/internal/agent"
)

const (
	modelDiscoveryTimeout = 6 * time.Second
	modelDiscoveryTTL     = 10 * time.Minute
	modelFailureTTL       = time.Minute
)

var modelDiscoveryCache = struct {
	sync.Mutex
	byBinary map[string]modelCacheEntry
	inFlight map[string]chan struct{}
}{
	byBinary: make(map[string]modelCacheEntry),
	inFlight: make(map[string]chan struct{}),
}

type modelCacheEntry struct {
	models  []agent.ModelOption
	expires time.Time
}

func modelList(
	binary string,
	lookPath func(string) (string, error),
	configured func(context.Context) ([]agent.ModelOption, error),
) func(context.Context) agent.ModelList {
	return func(ctx context.Context) agent.ModelList {
		if configured != nil {
			models, err := configured(ctx)
			if err != nil {
				return agent.ModelList{
					Source: "configured",
					Status: "unavailable",
				}
			}
			if len(models) > 0 {
				return agent.ModelList{
					Models: cloneModelOptions(models),
					Source: "configured",
					Status: "available",
				}
			}
		}
		if path, err := lookPath(binary); err == nil {
			if models := discoverModelOptions(ctx, path); len(models) > 0 {
				return agent.ModelList{
					Models: models,
					Source: "discovered",
					Status: "available",
				}
			}
		}
		return agent.ModelList{
			Models: recommendedModelOptions(),
			Source: "recommended",
			Status: "available",
		}
	}
}

func discoverModelOptions(ctx context.Context, binary string) []agent.ModelOption {
	binary = strings.TrimSpace(binary)
	if binary == "" {
		return nil
	}
	now := time.Now()
	modelDiscoveryCache.Lock()
	if cached, ok := modelDiscoveryCache.byBinary[binary]; ok && now.Before(cached.expires) {
		models := cloneModelOptions(cached.models)
		modelDiscoveryCache.Unlock()
		return models
	}
	if ch, ok := modelDiscoveryCache.inFlight[binary]; ok {
		modelDiscoveryCache.Unlock()
		select {
		case <-ch:
			modelDiscoveryCache.Lock()
			defer modelDiscoveryCache.Unlock()
			if cached, ok := modelDiscoveryCache.byBinary[binary]; ok && time.Now().Before(cached.expires) {
				return cloneModelOptions(cached.models)
			}
			return nil
		case <-ctx.Done():
			return nil
		}
	}
	ch := make(chan struct{})
	modelDiscoveryCache.inFlight[binary] = ch
	modelDiscoveryCache.Unlock()

	cmdCtx, cancel := context.WithTimeout(ctx, modelDiscoveryTimeout)
	defer cancel()
	out, err := exec.CommandContext(cmdCtx, binary, "exec", "--help").Output()
	models := parseAvailableModels(string(out))
	if err != nil || len(models) == 0 {
		models = nil
	}
	expires := now.Add(modelDiscoveryTTL)
	if len(models) == 0 {
		expires = now.Add(modelFailureTTL)
	}
	modelDiscoveryCache.Lock()
	modelDiscoveryCache.byBinary[binary] = modelCacheEntry{
		models:  cloneModelOptions(models),
		expires: expires,
	}
	delete(modelDiscoveryCache.inFlight, binary)
	close(ch)
	modelDiscoveryCache.Unlock()
	return models
}

func parseAvailableModels(help string) []agent.ModelOption {
	scanner := bufio.NewScanner(strings.NewReader(help))
	inAvailable := false
	seen := make(map[string]bool)
	var models []agent.ModelOption
	for scanner.Scan() {
		trimmed := strings.TrimSpace(strings.TrimRight(scanner.Text(), "\r"))
		if trimmed == "Available Models:" {
			inAvailable = true
			continue
		}
		if !inAvailable {
			continue
		}
		if strings.HasSuffix(trimmed, ":") || strings.HasPrefix(trimmed, "-") {
			break
		}
		fields := strings.Fields(trimmed)
		if len(fields) == 0 {
			continue
		}
		id := fields[0]
		if strings.HasPrefix(id, "custom:") || seen[id] {
			continue
		}
		seen[id] = true
		models = append(models, agent.ModelOption{
			ID:    id,
			Label: strings.TrimSpace(strings.TrimPrefix(trimmed, id)),
			Tier:  modelTier(id),
		})
	}
	return models
}

func recommendedModelOptions() []agent.ModelOption {
	return []agent.ModelOption{
		{ID: "auto", Label: "Auto Model", Tier: "balanced"},
		{ID: "claude-fable-5", Label: "Fable 5", Tier: "smart"},
		{ID: "claude-opus-5", Label: "Opus 5", Tier: "smart"},
		{ID: "claude-opus-5-fast", Label: "Opus 5 Fast Mode", Tier: "fast"},
		{ID: "claude-opus-4-8", Label: "Opus 4.8", Tier: "smart"},
		{ID: "claude-opus-4-8-fast", Label: "Opus 4.8 Fast Mode", Tier: "fast"},
		{ID: "claude-opus-4-7", Label: "Opus 4.7", Tier: "smart"},
		{ID: "claude-opus-4-6", Label: "Opus 4.6", Tier: "smart"},
		{ID: "claude-opus-4-5-20251101", Label: "Opus 4.5", Tier: "smart"},
		{ID: "claude-sonnet-5", Label: "Sonnet 5", Tier: "smart"},
		{ID: "claude-sonnet-4-6", Label: "Sonnet 4.6", Tier: "balanced"},
		{ID: "claude-sonnet-4-5-20250929", Label: "Sonnet 4.5", Tier: "balanced"},
		{ID: "claude-haiku-4-5-20251001", Label: "Haiku 4.5", Tier: "fast"},
		{ID: "gpt-5.6-sol", Label: "GPT-5.6 Sol", Tier: "smart"},
		{ID: "gpt-5.6-sol-fast", Label: "GPT-5.6 Sol Fast Mode", Tier: "fast"},
		{ID: "gpt-5.6-terra", Label: "GPT-5.6 Terra", Tier: "smart"},
		{ID: "gpt-5.6-luna", Label: "GPT-5.6 Luna", Tier: "balanced"},
		{ID: "gpt-5.5", Label: "GPT-5.5", Tier: "balanced"},
		{ID: "gpt-5.5-fast", Label: "GPT-5.5 Fast Mode", Tier: "fast"},
		{ID: "gpt-5.5-pro", Label: "GPT-5.5 Pro", Tier: "smart"},
		{ID: "gpt-5.4", Label: "GPT-5.4", Tier: "balanced"},
		{ID: "gpt-5.4-fast", Label: "GPT-5.4 Fast Mode", Tier: "fast"},
		{ID: "gpt-5.4-mini", Label: "GPT-5.4 Mini", Tier: "fast"},
		{ID: "gpt-5.4-mini-fast", Label: "GPT-5.4 Mini Fast Mode", Tier: "fast"},
		{ID: "gpt-5.3-codex", Label: "GPT-5.3-Codex", Tier: "balanced"},
		{ID: "gpt-5.3-codex-fast", Label: "GPT-5.3-Codex Fast Mode", Tier: "fast"},
		{ID: "gpt-5.2", Label: "GPT-5.2", Tier: "balanced"},
		{ID: "gemini-3.1-pro-preview", Label: "Gemini 3.1 Pro", Tier: "smart"},
		{ID: "gemini-3.7-flash", Label: "Gemini 3.7 Flash", Tier: "fast"},
		{ID: "gemini-3.6-flash", Label: "Gemini 3.6 Flash", Tier: "fast"},
		{ID: "gemini-3.5-flash", Label: "Gemini 3.5 Flash", Tier: "fast"},
		{ID: "gemini-3-flash-preview", Label: "Gemini 3 Flash", Tier: "fast"},
		{ID: "inkling", Label: "Inkling", Tier: "balanced"},
		{ID: "glm-5.3-flash", Label: "GLM-5.3-Flash", Tier: "fast"},
		{ID: "glm-5.3", Label: "GLM-5.3", Tier: "balanced"},
		{ID: "glm-5.2", Label: "GLM-5.2", Tier: "balanced"},
		{ID: "glm-5.2-fast", Label: "GLM-5.2 Fast", Tier: "fast"},
		{ID: "kimi-k3", Label: "Kimi K3", Tier: "balanced"},
		{ID: "kimi-k2.7-code", Label: "Kimi K2.7 Code", Tier: "balanced"},
		{ID: "kimi-k2.6", Label: "Kimi K2.6", Tier: "balanced"},
		{ID: "nemotron-3-ultra", Label: "Nemotron 3 Ultra", Tier: "smart"},
		{ID: "deepseek-v4-flash-0731", Label: "DeepSeek V4 Flash 0731", Tier: "fast"},
		{ID: "deepseek-v4-pro", Label: "DeepSeek V4 Pro", Tier: "smart"},
		{ID: "minimax-m3", Label: "MiniMax M3", Tier: "balanced"},
		{ID: "grok-4.6", Label: "Grok 4.6", Tier: "smart"},
		{ID: "grok-4.5", Label: "Grok 4.5", Tier: "smart"},
	}
}

func modelTier(id string) string {
	lower := strings.ToLower(id)
	switch {
	case lower == "auto":
		return "balanced"
	case strings.Contains(lower, "fast"), strings.Contains(lower, "flash"),
		strings.Contains(lower, "mini"), strings.Contains(lower, "haiku"):
		return "fast"
	case strings.Contains(lower, "opus"), strings.Contains(lower, "pro"),
		strings.Contains(lower, "ultra"), strings.Contains(lower, "sol"),
		strings.Contains(lower, "terra"):
		return "smart"
	default:
		return "balanced"
	}
}

func cloneModelOptions(in []agent.ModelOption) []agent.ModelOption {
	if len(in) == 0 {
		return nil
	}
	out := make([]agent.ModelOption, len(in))
	copy(out, in)
	return out
}
