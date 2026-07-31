package routing

import (
	"fmt"
	"strings"
)

// ---------------------------------------------------------------------------
// ProviderProfile validation
// ---------------------------------------------------------------------------

// ValidateProviderProfile checks the structural validity of a provider profile.
func ValidateProviderProfile(p ProviderProfile) error {
	if strings.TrimSpace(p.ID) == "" {
		return fmt.Errorf("provider profile id is required")
	}
	if strings.TrimSpace(p.Name) == "" {
		return fmt.Errorf("provider profile name is required for %q", p.ID)
	}
	switch p.Kind {
	case ProviderKindSubscription, ProviderKindAnthropicCompatible,
		ProviderKindOpenAICompatible, ProviderKindGrokCompatible, ProviderKindCustom:
		// valid
	default:
		return fmt.Errorf("provider %q: unknown kind %q", p.ID, p.Kind)
	}
	if len(p.SupportsAgents) == 0 {
		return fmt.Errorf("provider %q: supports_agents is required", p.ID)
	}
	for _, a := range p.SupportsAgents {
		if strings.TrimSpace(a) == "" {
			return fmt.Errorf("provider %q: empty agent in supports_agents", p.ID)
		}
	}
	if len(p.Models) == 0 {
		return fmt.Errorf("provider %q: at least one model is required", p.ID)
	}
	seen := make(map[string]bool, len(p.Models))
	for _, m := range p.Models {
		if strings.TrimSpace(m.ID) == "" {
			return fmt.Errorf("provider %q: model id is required", p.ID)
		}
		if seen[m.ID] {
			return fmt.Errorf("provider %q: duplicate model id %q", p.ID, m.ID)
		}
		seen[m.ID] = true
		switch m.Tier {
		case "smart", "balanced", "fast", "free", "":
		default:
			return fmt.Errorf("provider %q: unknown model tier %q for %q", p.ID, m.Tier, m.ID)
		}
		switch m.CostLabel {
		case "paid", "company", "free", "unknown", "":
		default:
			return fmt.Errorf("provider %q: unknown cost_label %q for %q", p.ID, m.CostLabel, m.ID)
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// TeamProfile validation
// ---------------------------------------------------------------------------

// ValidateTeamProfile checks the structural validity of a team profile.
// It uses agentExists and providerExists to validate references.
// When providers are supplied, it also checks provider-agent compatibility
// and tier model availability.
func ValidateTeamProfile(t TeamProfile, agentExists func(string) bool, providerExists func(string) bool, providers []ProviderProfile) error {
	if strings.TrimSpace(t.ID) == "" {
		return fmt.Errorf("team profile id is required")
	}
	if strings.TrimSpace(t.Name) == "" {
		return fmt.Errorf("team profile name is required for %q", t.ID)
	}
	if t.Enabled && len(t.Phases) == 0 {
		return fmt.Errorf("team %q: at least one phase is required when enabled", t.ID)
	}
	for phase, pp := range t.Phases {
		if !ValidRoutePhase(phase) {
			return fmt.Errorf("team %q: unknown phase %q", t.ID, phase)
		}
		if strings.TrimSpace(pp.Agent) == "" {
			return fmt.Errorf("team %q phase %q: agent is required", t.ID, phase)
		}
		if agentExists != nil && !agentExists(pp.Agent) {
			return fmt.Errorf("team %q phase %q: unknown agent %q", t.ID, phase, pp.Agent)
		}
		switch pp.Tier {
		case "smart", "balanced", "fast", "":
		default:
			return fmt.Errorf("team %q phase %q: unknown tier %q", t.ID, phase, pp.Tier)
		}
		for _, pid := range pp.ProviderPriority {
			if strings.TrimSpace(pid) == "" {
				return fmt.Errorf("team %q phase %q: empty provider id in priority list", t.ID, phase)
			}
			if providerExists != nil && !providerExists(pid) {
				return fmt.Errorf("team %q phase %q: unknown provider %q", t.ID, phase, pid)
			}
		}
		for _, f := range pp.Fallback {
			switch f {
			case "same_provider_same_tier", "next_provider_same_tier",
				"same_provider_lower_tier", "next_provider_lower_tier":
			default:
				return fmt.Errorf("team %q phase %q: unknown fallback value %q", t.ID, phase, f)
			}
		}
		// At least one provider in priority when enabled.
		if len(pp.ProviderPriority) == 0 {
			return fmt.Errorf("team %q phase %q: provider_priority is required", t.ID, phase)
		}
	}
	// Validate provider-agent compatibility and tier model availability.
	if len(providers) > 0 {
		for phase, pp := range t.Phases {
			for _, pid := range pp.ProviderPriority {
				prov := findProviderInSlice(providers, pid)
				if prov == nil {
					continue // validated above
				}
				if !prov.Enabled {
					return fmt.Errorf("team %q phase %q: provider %q is disabled", t.ID, phase, pid)
				}
				if !ProviderSupportsAgent(*prov, pp.Agent) {
					return fmt.Errorf("team %q phase %q: provider %q does not support agent %q", t.ID, phase, pid, pp.Agent)
				}
				if !AgentSupportsProviderKind(pp.Agent, prov.Kind) {
					return fmt.Errorf("team %q phase %q: adapter for agent %q does not support provider kind %q", t.ID, phase, pp.Agent, prov.Kind)
				}
				// Check that the target tier has at least one model.
				if pp.Tier != "" {
					hasTier := false
					for _, m := range prov.Models {
						if m.Tier == pp.Tier {
							hasTier = true
							break
						}
					}
					if !hasTier {
						return fmt.Errorf("team %q phase %q: provider %q has no models at tier %q", t.ID, phase, pid, pp.Tier)
					}
				}
			}
		}
	}
	// Validate alias uniqueness is enforced by the caller at the list level.
	return nil
}

// ---------------------------------------------------------------------------
// DispatchSelection validation
// ---------------------------------------------------------------------------

// ValidateDispatch validates a dispatch selection against known profiles.
func ValidateDispatch(sel DispatchSelection, teamExists func(string) bool, providerExists func(string) bool, agentExists func(string) bool) error {
	if err := sel.Validate(); err != nil {
		return err
	}
	switch sel.Mode {
	case DispatchAuto:
		if teamExists != nil && !teamExists(sel.Team) {
			return fmt.Errorf("unknown team/profile %q", sel.Team)
		}
	case DispatchManual:
		if agentExists != nil && !agentExists(sel.Agent) {
			return fmt.Errorf("unknown agent %q", sel.Agent)
		}
		if providerExists != nil && !providerExists(sel.Provider) {
			return fmt.Errorf("unknown provider %q", sel.Provider)
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// RoutingDefaults validation
// ---------------------------------------------------------------------------

// ValidateRoutingDefaults checks the routing defaults.
func ValidateRoutingDefaults(d RoutingDefaults, teamExists func(string) bool) error {
	if d.Enabled {
		if d.DefaultTeam == "" {
			return fmt.Errorf("default team is required when routing is enabled")
		}
		if teamExists != nil && !teamExists(d.DefaultTeam) {
			return fmt.Errorf("unknown default team %q", d.DefaultTeam)
		}
	}
	if d.Objective != "" && !ValidDispatchObjective(DispatchObjective(d.Objective)) {
		return fmt.Errorf("unknown default objective %q", d.Objective)
	}
	if d.MaxAttemptsPerStep < 0 {
		return fmt.Errorf("max_attempts_per_step must be >= 0")
	}
	switch d.TerminalLimitPolicy {
	case "wait", "ask", "switch", "":
	default:
		return fmt.Errorf("unknown terminal_limit_policy %q", d.TerminalLimitPolicy)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Provider-agent compatibility
// ---------------------------------------------------------------------------

// AdapterCapability describes which provider kinds each agent adapter supports.
type AdapterCapability struct {
	AgentID        string         `json:"agent_id"`
	SupportedKinds []ProviderKind `json:"supported_kinds"`
}

// BuiltinAdapterCapabilities returns the known adapter capabilities.
// This is the first-implementation mapping; it should be extended as adapters
// declare support for more provider kinds.
func BuiltinAdapterCapabilities() []AdapterCapability {
	return []AdapterCapability{
		{
			AgentID:        "kin",
			SupportedKinds: []ProviderKind{ProviderKindOpenAICompatible, ProviderKindAnthropicCompatible, ProviderKindCustom},
		},
		{
			AgentID:        "claude-code",
			SupportedKinds: []ProviderKind{ProviderKindSubscription, ProviderKindAnthropicCompatible},
		},
		{
			AgentID:        "codex",
			SupportedKinds: []ProviderKind{ProviderKindSubscription},
		},
		{
			AgentID:        "grok",
			SupportedKinds: []ProviderKind{ProviderKindSubscription, ProviderKindGrokCompatible},
		},
	}
}

// ProviderKindForAgent returns the provider kinds supported by an agent.
func ProviderKindForAgent(agentID string) []ProviderKind {
	for _, cap := range BuiltinAdapterCapabilities() {
		if cap.AgentID == agentID {
			out := make([]ProviderKind, len(cap.SupportedKinds))
			copy(out, cap.SupportedKinds)
			return out
		}
	}
	return nil
}

// AgentSupportsProviderKind reports whether the agent adapter supports the
// given provider kind.
func AgentSupportsProviderKind(agentID string, kind ProviderKind) bool {
	for _, k := range ProviderKindForAgent(agentID) {
		if k == kind {
			return true
		}
	}
	return false
}

// ProviderSupportsAgent reports whether a provider profile lists the agent
// in its supports_agents and the adapter supports the provider's kind.
func ProviderSupportsAgent(provider ProviderProfile, agentID string) bool {
	if !provider.Enabled {
		return false
	}
	found := false
	for _, a := range provider.SupportsAgents {
		if a == agentID {
			found = true
			break
		}
	}
	if !found {
		return false
	}
	return AgentSupportsProviderKind(agentID, provider.Kind)
}

// ---------------------------------------------------------------------------
// Model tier ordering
// ---------------------------------------------------------------------------

// tierOrder returns a numeric ordering of tier strings for sorting.
// Lower number = higher priority (preferred when cost is not a concern).
func tierOrder(tier string) int {
	switch tier {
	case "smart":
		return 0
	case "balanced":
		return 1
	case "fast":
		return 2
	case "free":
		return 3
	default:
		return 99
	}
}

// costOrder returns a numeric ordering of cost labels for sorting.
// Lower number = cheaper / more preferred for cost-min objective.
func costOrder(label string) int {
	switch label {
	case "free":
		return 0
	case "company":
		return 1
	case "paid":
		return 2
	default:
		return 99
	}
}

// findProviderInSlice finds a provider by ID in a slice.
func findProviderInSlice(providers []ProviderProfile, id string) *ProviderProfile {
	for i := range providers {
		if providers[i].ID == id {
			return &providers[i]
		}
	}
	return nil
}
