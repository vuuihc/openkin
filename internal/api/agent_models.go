package api

import (
	"bufio"
	"context"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/vuuihc/openkin/internal/routing"
)

const (
	droidModelDiscoveryTimeout = 6 * time.Second
	droidModelDiscoveryTTL     = 10 * time.Minute
	droidModelFailureTTL       = time.Minute
)

var droidModelDiscoveryCache = struct {
	sync.Mutex
	byBinary map[string]droidModelCacheEntry
	inFlight map[string]chan struct{}
}{
	byBinary: make(map[string]droidModelCacheEntry),
	inFlight: make(map[string]chan struct{}),
}

type droidModelCacheEntry struct {
	models  []AgentModelOption
	expires time.Time
}

func (s *Server) applyAgentModelLists(ctx context.Context, list []AgentInfo) {
	var profiles []routing.ProviderProfile
	if s.Store != nil && needsConfiguredDroidModels(list) {
		if loaded, err := loadProviderProfiles(ctx, s.Store); err == nil {
			profiles = loaded
		}
	}
	for i := range list {
		applyConfiguredDroidModelList(&list[i], profiles)
		applyDiscoveredDroidModelList(ctx, &list[i])
		applyAgentModelList(&list[i])
	}
}

func needsConfiguredDroidModels(list []AgentInfo) bool {
	for _, info := range list {
		if info.ID == "droid" && len(info.Models) == 0 && info.ModelListSource == "" && info.ModelListStatus == "" {
			return true
		}
	}
	return false
}

func applyConfiguredDroidModelList(info *AgentInfo, profiles []routing.ProviderProfile) {
	if info.ID != "droid" || len(info.Models) > 0 || info.ModelListSource != "" || info.ModelListStatus != "" {
		return
	}
	seen := make(map[string]bool)
	for _, p := range profiles {
		if !p.Enabled || p.Kind != routing.ProviderKindSubscription || !routing.ProviderSupportsAgent(p, "droid") {
			continue
		}
		for _, m := range p.Models {
			id := strings.TrimSpace(m.ID)
			if id == "" || seen[id] {
				continue
			}
			seen[id] = true
			info.Models = append(info.Models, AgentModelOption{
				ID:   id,
				Tier: m.Tier,
			})
		}
	}
	if len(info.Models) > 0 {
		info.ModelListSource = "configured"
		info.ModelListStatus = "available"
	}
}

func applyDiscoveredDroidModelList(ctx context.Context, info *AgentInfo) {
	if info.ID != "droid" || len(info.Models) > 0 || info.ModelListSource != "" || info.ModelListStatus != "" {
		return
	}
	binary := strings.TrimSpace(info.Binary)
	if binary == "" {
		return
	}
	models := discoverDroidModelOptions(ctx, binary)
	if len(models) == 0 {
		return
	}
	info.Models = models
	info.ModelListSource = "discovered"
	info.ModelListStatus = "available"
}

func discoverDroidModelOptions(ctx context.Context, binary string) []AgentModelOption {
	binary = strings.TrimSpace(binary)
	if binary == "" {
		return nil
	}
	now := time.Now()
	droidModelDiscoveryCache.Lock()
	if cached, ok := droidModelDiscoveryCache.byBinary[binary]; ok && now.Before(cached.expires) {
		models := cloneAgentModelOptions(cached.models)
		droidModelDiscoveryCache.Unlock()
		return models
	}
	if ch, ok := droidModelDiscoveryCache.inFlight[binary]; ok {
		droidModelDiscoveryCache.Unlock()
		select {
		case <-ch:
			droidModelDiscoveryCache.Lock()
			defer droidModelDiscoveryCache.Unlock()
			if cached, ok := droidModelDiscoveryCache.byBinary[binary]; ok && time.Now().Before(cached.expires) {
				return cloneAgentModelOptions(cached.models)
			}
			return nil
		case <-ctx.Done():
			return nil
		}
	}
	ch := make(chan struct{})
	droidModelDiscoveryCache.inFlight[binary] = ch
	droidModelDiscoveryCache.Unlock()

	cmdCtx, cancel := context.WithTimeout(context.Background(), droidModelDiscoveryTimeout)
	defer cancel()
	out, err := exec.CommandContext(cmdCtx, binary, "exec", "--help").Output()
	models := parseDroidAvailableModels(string(out))
	if err != nil || len(models) == 0 {
		models = nil
	}
	expires := now.Add(droidModelDiscoveryTTL)
	if len(models) == 0 {
		expires = now.Add(droidModelFailureTTL)
	}
	droidModelDiscoveryCache.Lock()
	droidModelDiscoveryCache.byBinary[binary] = droidModelCacheEntry{models: cloneAgentModelOptions(models), expires: expires}
	delete(droidModelDiscoveryCache.inFlight, binary)
	close(ch)
	droidModelDiscoveryCache.Unlock()
	return models
}

func parseDroidAvailableModels(help string) []AgentModelOption {
	s := bufio.NewScanner(strings.NewReader(help))
	inAvailable := false
	seen := make(map[string]bool)
	var out []AgentModelOption
	for s.Scan() {
		line := strings.TrimRight(s.Text(), "")
		trimmed := strings.TrimSpace(line)
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
		label := strings.TrimSpace(strings.TrimPrefix(trimmed, id))
		out = append(out, AgentModelOption{
			ID:    id,
			Label: label,
			Tier:  droidModelTier(id),
		})
		seen[id] = true
	}
	return out
}

func droidRecommendedModelOptions() []AgentModelOption {
	return []AgentModelOption{
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

func droidModelTier(id string) string {
	lower := strings.ToLower(id)
	switch {
	case lower == "auto":
		return "balanced"
	case strings.Contains(lower, "fast") || strings.Contains(lower, "flash") || strings.Contains(lower, "mini") || strings.Contains(lower, "haiku"):
		return "fast"
	case strings.Contains(lower, "opus") || strings.Contains(lower, "pro") || strings.Contains(lower, "ultra") || strings.Contains(lower, "sol") || strings.Contains(lower, "terra"):
		return "smart"
	default:
		return "balanced"
	}
}

func cloneAgentModelOptions(in []AgentModelOption) []AgentModelOption {
	if len(in) == 0 {
		return nil
	}
	out := make([]AgentModelOption, len(in))
	copy(out, in)
	return out
}
