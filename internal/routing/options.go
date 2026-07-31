package routing

import "sort"

// ---------------------------------------------------------------------------
// Options builder
// ---------------------------------------------------------------------------

// Options is the response payload for GET /api/routing/options.
type Options struct {
	Agents    []AgentOption    `json:"agents"`
	Providers []ProviderOption `json:"providers"`
	Teams     []TeamOption     `json:"teams"`
	Defaults  RoutingDefaults  `json:"defaults"`
}

// AgentOption describes one selectable agent for routing.
type AgentOption struct {
	ID              string         `json:"id"`
	Name            string         `json:"name"`
	SupportedKinds  []ProviderKind `json:"supported_kinds"`
	CompatibleCount int            `json:"compatible_count"` // enabled provider profiles
}

// ProviderOption describes one selectable provider profile.
type ProviderOption struct {
	ID             string      `json:"id"`
	Name           string      `json:"name"`
	Kind           string      `json:"kind"`
	Enabled        bool        `json:"enabled"`
	SupportsAgents []string    `json:"supports_agents"`
	ModelCount     int         `json:"model_count"`
	Models         []ModelSpec `json:"models"`
}

// TeamOption describes one selectable team/profile.
type TeamOption struct {
	ID               string `json:"id"`
	Name             string `json:"name"`
	Alias            string `json:"alias,omitempty"`
	Enabled          bool   `json:"enabled"`
	DefaultObjective string `json:"default_objective,omitempty"`
}

// BuildOptions assembles the options response from the current configuration.
func BuildOptions(
	agents []AgentInfo,
	profiles []ProviderProfile,
	teams []TeamProfile,
	defaults RoutingDefaults,
) Options {
	opts := Options{Defaults: defaults}

	// Build agent options.
	agentOpts := make([]AgentOption, 0, len(agents))
	for _, a := range agents {
		kinds := ProviderKindForAgent(a.ID)
		compatible := 0
		for _, p := range profiles {
			if p.Enabled && ProviderSupportsAgent(p, a.ID) {
				compatible++
			}
		}
		agentOpts = append(agentOpts, AgentOption{
			ID:              a.ID,
			Name:            a.Name,
			SupportedKinds:  kinds,
			CompatibleCount: compatible,
		})
	}
	sort.Slice(agentOpts, func(i, j int) bool {
		return agentOpts[i].ID < agentOpts[j].ID
	})
	opts.Agents = agentOpts

	// Build provider options.
	provOpts := make([]ProviderOption, 0, len(profiles))
	for _, p := range profiles {
		provOpts = append(provOpts, ProviderOption{
			ID:             p.ID,
			Name:           p.Name,
			Kind:           string(p.Kind),
			Enabled:        p.Enabled,
			SupportsAgents: p.SupportsAgents,
			ModelCount:     len(p.Models),
			Models:         p.Models,
		})
	}
	sort.Slice(provOpts, func(i, j int) bool {
		return provOpts[i].ID < provOpts[j].ID
	})
	opts.Providers = provOpts

	// Build team options.
	teamOpts := make([]TeamOption, 0, len(teams))
	for _, t := range teams {
		teamOpts = append(teamOpts, TeamOption{
			ID:               t.ID,
			Name:             t.Name,
			Alias:            t.Alias,
			Enabled:          t.Enabled,
			DefaultObjective: t.DefaultObjective,
		})
	}
	sort.Slice(teamOpts, func(i, j int) bool {
		return teamOpts[i].ID < teamOpts[j].ID
	})
	opts.Teams = teamOpts

	return opts
}

// AgentInfo is a minimal representation of an agent for options building.
type AgentInfo struct {
	ID   string
	Name string
	Kind string
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

// PreviewPhase describes one resolved phase in a preview.
type PreviewPhase struct {
	Phase           RoutePhase         `json:"phase"`
	Agent           string             `json:"agent"`
	Provider        string             `json:"provider"`
	Model           string             `json:"model"`
	Tier            string             `json:"tier"`
	Status          string             `json:"status"` // resolved | unresolved | blocked
	FallbackSummary string             `json:"fallback_summary,omitempty"`
	Skipped         []SkippedCandidate `json:"skipped,omitempty"`
}

// Preview is the response payload for GET /api/routing/preview.
type Preview struct {
	Mode          DispatchMode   `json:"mode"`
	Team          string         `json:"team,omitempty"`
	Objective     string         `json:"objective,omitempty"`
	Agent         string         `json:"agent,omitempty"`
	Provider      string         `json:"provider,omitempty"`
	Model         string         `json:"model,omitempty"`
	Phases        []PreviewPhase `json:"phases"`
	Blocked       bool           `json:"blocked"`
	BlockedReason string         `json:"blocked_reason,omitempty"`
}

// BuildAutoPreview resolves a preview for auto mode.
// It uses the same candidate expansion as the resolver so preview always
// matches what the resolver would select.
func BuildAutoPreview(team TeamProfile, objective DispatchObjective, providers []ProviderProfile) Preview {
	preview := Preview{
		Mode:      DispatchAuto,
		Team:      team.ID,
		Objective: string(objective),
	}

	if !team.Enabled {
		preview.Blocked = true
		preview.BlockedReason = "Team profile is disabled"
		return preview
	}

	objectiveStr := string(objective)
	if objectiveStr == "" {
		objectiveStr = team.DefaultObjective
		if objectiveStr == "" {
			objectiveStr = string(ObjectiveBalanced)
		}
	}

	// Sort phases for deterministic output.
	phaseOrder := []RoutePhase{PhasePlan, PhaseExecute, PhaseReview, PhaseChat}
	preview.Phases = make([]PreviewPhase, 0, len(team.Phases))

	for _, phase := range phaseOrder {
		pp, ok := team.Phases[phase]
		if !ok {
			continue
		}

		p := PreviewPhase{
			Phase:  phase,
			Agent:  pp.Agent,
			Status: "unresolved",
		}

		// Use the same candidate expansion as the resolver.
		candidates := expandCandidates(pp, providers, objectiveStr)
		if len(candidates) == 0 {
			p.Status = "blocked"
			preview.Blocked = true
			preview.BlockedReason = "Cannot resolve provider/model for phase " + string(phase)
		} else {
			selected := candidates[0]
			p.Provider = selected.ProviderID
			p.Model = selected.ModelID
			p.Tier = selected.Tier
			p.Status = "resolved"
			for _, c := range candidates[1:] {
				p.Skipped = append(p.Skipped, SkippedCandidate{
					Provider: c.ProviderID,
					Model:    c.ModelID,
					Reason:   "lower priority",
				})
			}
		}

		// Build fallback summary.
		if len(pp.Fallback) > 0 {
			p.FallbackSummary = buildFallbackSummary(pp.Fallback)
		}

		preview.Phases = append(preview.Phases, p)
	}

	return preview
}

// BuildManualPreview resolves a preview for manual mode.
// It validates that the provider supports the agent and that the model
// exists under the provider. Unknown models are blocked unless the
// provider profile explicitly allows them.
func BuildManualPreview(agentID, providerID, modelID string, providers []ProviderProfile) Preview {
	preview := Preview{
		Mode:     DispatchManual,
		Agent:    agentID,
		Provider: providerID,
		Model:    modelID,
	}

	prov := findProvider(providerID, providers)
	if prov == nil {
		preview.Blocked = true
		preview.BlockedReason = "Provider not found"
		return preview
	}
	if !prov.Enabled {
		preview.Blocked = true
		preview.BlockedReason = "Provider is disabled"
		return preview
	}
	if !ProviderSupportsAgent(*prov, agentID) {
		preview.Blocked = true
		preview.BlockedReason = "Provider does not support agent " + agentID
		return preview
	}

	// Verify model exists in the provider's model list.
	modelFound := false
	var modelTier string
	for _, m := range prov.Models {
		if m.ID == modelID {
			modelFound = true
			modelTier = m.Tier
			break
		}
	}
	if !modelFound {
		preview.Blocked = true
		preview.BlockedReason = "Model " + modelID + " is not listed under provider " + providerID
		return preview
	}

	preview.Phases = append(preview.Phases, PreviewPhase{
		Phase:    PhaseChat,
		Agent:    agentID,
		Provider: providerID,
		Model:    modelID,
		Tier:     modelTier,
		Status:   "resolved",
	})

	return preview
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func findProvider(id string, providers []ProviderProfile) *ProviderProfile {
	for i := range providers {
		if providers[i].ID == id {
			return &providers[i]
		}
	}
	return nil
}

func buildFallbackSummary(fallbacks []string) string {
	switch {
	case len(fallbacks) == 0:
		return "none"
	case len(fallbacks) == 1:
		return fallbacks[0]
	default:
		summary := ""
		for i, f := range fallbacks {
			if i > 0 {
				summary += " → "
			}
			summary += f
		}
		return summary
	}
}
