package task

import "strings"

// ModelTier is a coarse capability/cost bucket used to resolve macro model
// preferences ("聪明的模型" / "便宜的模型") into a concrete model id per agent.
type ModelTier string

const (
	TierSmart    ModelTier = "smart"    // most capable / most expensive
	TierBalanced ModelTier = "balanced" // default working tier
	TierFast     ModelTier = "fast"     // cheapest / lowest latency
)

// NormalizeTier maps free-text tier words (zh/en) to a ModelTier, or "".
func NormalizeTier(s string) ModelTier {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "smart", "smartest", "strong", "capable", "high", "expensive",
		"聪明", "最强", "强", "贵", "高级", "高端":
		return TierSmart
	case "balanced", "mid", "medium", "default", "标准", "均衡", "中":
		return TierBalanced
	case "fast", "cheap", "cheapest", "small", "low", "快", "便宜", "省", "低":
		return TierFast
	}
	return ""
}

// ModelSpec is one known model for one agent, tagged with a tier and the
// free-text aliases a user might type for it.
type ModelSpec struct {
	ID      string
	Tier    ModelTier
	Aliases []string
}

// ModelCatalog maps agent id → its known models (tier-ordered, smart first).
// It normalizes fuzzy user text to a canonical id and resolves tier preferences.
// It is advisory only: a model a user names that is absent here still passes
// through verbatim, so new/unknown model ids are never blocked.
type ModelCatalog map[string][]ModelSpec

// BuiltinCatalog is the seeded, provider-agnostic default. Tiers are kept
// consistent with store.DefaultPriceTable ordering (max > codex > mini, etc.).
func BuiltinCatalog() ModelCatalog {
	return ModelCatalog{
		"claude-code": {
			{ID: "claude-opus-4-8", Tier: TierSmart, Aliases: []string{"opus", "opus-4-8", "opus4.8", "opus 4.8", "claude-opus", "opus-4.8"}},
			{ID: "claude-sonnet-4-6", Tier: TierBalanced, Aliases: []string{"sonnet", "sonnet-4-6", "sonnet4.6", "sonnet 4.6", "claude-sonnet"}},
			{ID: "claude-haiku-4-5", Tier: TierFast, Aliases: []string{"haiku", "haiku-4-5", "haiku4.5", "claude-haiku"}},
		},
		"codex": {
			{ID: "gpt-5.1-codex-max", Tier: TierSmart, Aliases: []string{"codex-max", "5.1-codex-max", "5.1 max", "gpt-5.1-max", "max"}},
			{ID: "gpt-5.1-codex", Tier: TierBalanced, Aliases: []string{"5.1-codex", "gpt5.1", "gpt-5.1"}},
			{ID: "gpt-5-codex", Tier: TierBalanced, Aliases: []string{"gpt5", "gpt-5", "5-codex"}},
			{ID: "o4-mini", Tier: TierFast, Aliases: []string{"mini", "o4mini", "o4 mini"}},
		},
		"grok": {
			{ID: "grok-4", Tier: TierSmart, Aliases: []string{"grok4", "grok 4"}},
			{ID: "grok-3", Tier: TierBalanced, Aliases: []string{"grok3", "grok 3"}},
			{ID: "grok-code-fast-1", Tier: TierFast, Aliases: []string{"grok-fast", "grok code fast", "code-fast"}},
		},
	}
}

// normText lowercases and strips whitespace/punctuation for tolerant matching.
func normText(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		default:
			// drop spaces, dots, dashes, colons — "gpt 5.6 terra" ~ "gpt56terra"
		}
	}
	return b.String()
}

// Normalize resolves free-text like "GPT 5.6 Terra" to a canonical model id for
// the given agent. ok is false when nothing in the catalog matches; callers
// should then keep the user's verbatim text (unknown ids are allowed).
func (c ModelCatalog) Normalize(agent, freeText string) (string, bool) {
	q := normText(freeText)
	if q == "" {
		return "", false
	}
	specs := c[agent]
	// Exact id / alias match first.
	for _, s := range specs {
		if normText(s.ID) == q {
			return s.ID, true
		}
		for _, a := range s.Aliases {
			if normText(a) == q {
				return s.ID, true
			}
		}
	}
	// Containment match only when the query embeds a FULL canonical id (e.g.
	// "use gpt-5.1-codex-max now"). Aliases are exact-only above: a short alias
	// like "gpt5" must not shadow an unknown future id like "gpt-5.6-terra".
	// Longest id wins so "gpt-5.1-codex" beats "gpt-5-codex".
	const minEmbed = 6
	best := ""
	bestLen := 0
	for _, s := range specs {
		n := normText(s.ID)
		if len(n) < minEmbed {
			continue
		}
		if strings.Contains(q, n) && len(n) > bestLen {
			best, bestLen = s.ID, len(n)
		}
	}
	if best != "" {
		return best, true
	}
	return "", false
}

// TierOf returns the tier of a model id/alias for the given agent, or "".
func (c ModelCatalog) TierOf(agent, freeText string) ModelTier {
	id, ok := c.Normalize(agent, freeText)
	if !ok {
		id = strings.TrimSpace(freeText)
	}
	if id == "" {
		return ""
	}
	q := normText(id)
	for _, s := range c[agent] {
		if normText(s.ID) == q {
			return s.Tier
		}
		for _, a := range s.Aliases {
			if normText(a) == q {
				return s.Tier
			}
		}
	}
	return ""
}

// PickByTier returns the catalog model for agent at the requested tier.
// Falls back to the nearest available tier (smart→balanced→fast and back) so a
// preference always resolves to something the agent can run.
func (c ModelCatalog) PickByTier(agent string, tier ModelTier) (string, bool) {
	specs := c[agent]
	if len(specs) == 0 {
		return "", false
	}
	if id := firstOfTier(specs, tier); id != "" {
		return id, true
	}
	// Ordered fallbacks per requested tier.
	var order []ModelTier
	switch tier {
	case TierSmart:
		order = []ModelTier{TierBalanced, TierFast}
	case TierFast:
		order = []ModelTier{TierBalanced, TierSmart}
	default:
		order = []ModelTier{TierSmart, TierFast}
	}
	for _, t := range order {
		if id := firstOfTier(specs, t); id != "" {
			return id, true
		}
	}
	return specs[0].ID, true
}

func firstOfTier(specs []ModelSpec, tier ModelTier) string {
	for _, s := range specs {
		if s.Tier == tier {
			return s.ID
		}
	}
	return ""
}

// ListCatalogModels returns known models for an agent (smart → fast order).
// Empty when the agent is unknown to the catalog.
func ListCatalogModels(agent string) []ModelSpec {
	specs := BuiltinCatalog()[agent]
	out := make([]ModelSpec, len(specs))
	copy(out, specs)
	return out
}
