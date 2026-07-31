package routing

import "fmt"

// ---------------------------------------------------------------------------
// Reference checks
// ---------------------------------------------------------------------------

// Reference reports which entities reference a given provider id.
type Reference struct {
	TeamIDs []string   `json:"team_ids,omitempty"`
	Phases  []PhaseRef `json:"phases,omitempty"`
}

// PhaseRef identifies one phase policy within a team.
type PhaseRef struct {
	TeamID string     `json:"team_id"`
	Phase  RoutePhase `json:"phase"`
}

// CheckProviderReferences finds all team profiles that reference a provider.
func CheckProviderReferences(providerID string, teams []TeamProfile) Reference {
	var ref Reference
	for _, t := range teams {
		for phase, pp := range t.Phases {
			for _, pid := range pp.ProviderPriority {
				if pid == providerID {
					ref.TeamIDs = append(ref.TeamIDs, t.ID)
					ref.Phases = append(ref.Phases, PhaseRef{TeamID: t.ID, Phase: phase})
					break
				}
			}
		}
	}
	return ref
}

// CheckAgentReferences finds all team profiles that reference an agent.
func CheckAgentReferences(agentID string, teams []TeamProfile) Reference {
	var ref Reference
	for _, t := range teams {
		for phase, pp := range t.Phases {
			if pp.Agent == agentID {
				ref.TeamIDs = append(ref.TeamIDs, t.ID)
				ref.Phases = append(ref.Phases, PhaseRef{TeamID: t.ID, Phase: phase})
			}
		}
	}
	return ref
}

// CheckAliasConflict checks whether an alias is already used by another team.
// Returns the conflicting team id, or "" if no conflict.
func CheckAliasConflict(alias string, excludeTeamID string, teams []TeamProfile) string {
	for _, t := range teams {
		if t.ID == excludeTeamID {
			continue
		}
		if t.Alias == alias {
			return t.ID
		}
		if t.ID == alias {
			return t.ID
		}
	}
	return ""
}

// ---------------------------------------------------------------------------
// Disable guard
// ---------------------------------------------------------------------------

// DisableImpact describes what would be affected if a provider is disabled.
type DisableImpact struct {
	ProviderID string        `json:"provider_id"`
	Teams      []TeamProfile `json:"teams"`
	// Blocking indicates whether at least one enabled team would lose all
	// providers for a phase.
	Blocking bool `json:"blocking"`
	// Message is a human-readable summary.
	Message string `json:"message"`
}

// PreviewDisableProvider computes the impact of disabling a provider.
func PreviewDisableProvider(providerID string, providers []ProviderProfile, teams []TeamProfile) DisableImpact {
	impact := DisableImpact{ProviderID: providerID}
	for _, t := range teams {
		if !t.Enabled {
			continue
		}
		for phase, pp := range t.Phases {
			for _, pid := range pp.ProviderPriority {
				if pid == providerID {
					impact.Teams = append(impact.Teams, t)
					impact.Message = fmt.Sprintf("Disabling provider %q affects team %q phase %s.", providerID, t.ID, phase)
					// Check if this phase would have no providers after removal.
					remaining := 0
					for _, pid2 := range pp.ProviderPriority {
						if pid2 != providerID {
							for _, p := range providers {
								if p.ID == pid2 && p.Enabled {
									remaining++
									break
								}
							}
						}
					}
					if remaining == 0 {
						impact.Blocking = true
					}
					break
				}
			}
		}
	}
	if len(impact.Teams) > 0 {
		impact.Message = fmt.Sprintf("Disabling provider %q affects %d team(s). "+
			"Blocking: %v. Review impacted teams before disabling.", providerID, len(impact.Teams), impact.Blocking)
	}
	return impact
}

// ---------------------------------------------------------------------------
// Seed policy
// ---------------------------------------------------------------------------

// SeedPolicy generates a conservative team profile for an old install that has
// no routing configuration yet. It uses the active provider's kind and the
// default agent to create a single-team policy.
func SeedPolicy(defaultAgent string, providerKinds []ProviderKind, providerIDs []string) (TeamProfile, error) {
	if defaultAgent == "" {
		return TeamProfile{}, fmt.Errorf("default agent is required for seed policy")
	}
	if len(providerIDs) == 0 {
		return TeamProfile{}, fmt.Errorf("at least one provider is required for seed policy")
	}

	team := TeamProfile{
		ID:               "default",
		Name:             "Default",
		Alias:            "default",
		DefaultObjective: string(ObjectiveBalanced),
		Enabled:          true,
		Phases: map[RoutePhase]PhasePolicy{
			PhaseExecute: {
				Agent:            defaultAgent,
				Tier:             "balanced",
				ProviderPriority: providerIDs,
				Fallback:         []string{"next_provider_same_tier", "same_provider_lower_tier"},
			},
		},
	}
	return team, nil
}
