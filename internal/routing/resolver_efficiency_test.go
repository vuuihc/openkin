package routing

import (
	"context"
	"strings"
	"testing"
)

func TestResolverRoutinePrefersCheaperCandidateAtSameFloor(t *testing.T) {
	resolver := NewDefaultResolver(&stubStore{
		providers: []ProviderProfile{
			{
				ID: "paid", Name: "Paid", Kind: ProviderKindAnthropicCompatible,
				SupportsAgents: []string{"claude-code"}, Enabled: true,
				Models: []ModelSpec{{ID: "paid-smart", Tier: "smart", CostLabel: "paid"}},
			},
			{
				ID: "free", Name: "Free", Kind: ProviderKindAnthropicCompatible,
				SupportsAgents: []string{"claude-code"}, Enabled: true,
				Models: []ModelSpec{{ID: "free-fast", Tier: "fast", CostLabel: "free"}},
			},
		},
		teams: []TeamProfile{{
			ID: "routine", Name: "Routine", Enabled: true,
			Phases: map[RoutePhase]PhasePolicy{
				PhaseExecute: {
					Agent:            "claude-code",
					ProviderPriority: []string{"paid", "free"},
				},
			},
		}},
		defaults: DefaultRoutingDefaults(),
	})

	decision, err := resolver.Resolve(context.Background(), ResolveRequest{
		Team: "routine", Phase: PhaseExecute, Prompt: "fix the typo", Routine: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if decision.Provider != "free" || decision.Model != "free-fast" {
		t.Fatalf("routine selected %s/%s, want free/free-fast", decision.Provider, decision.Model)
	}
	if decision.QualityFloor != QualityLight {
		t.Fatalf("quality floor = %q, want %q", decision.QualityFloor, QualityLight)
	}
}

func TestResolverHeavyFloorRejectsFastCandidate(t *testing.T) {
	resolver := NewDefaultResolver(&stubStore{
		providers: []ProviderProfile{
			{
				ID: "fast", Name: "Fast", Kind: ProviderKindAnthropicCompatible,
				SupportsAgents: []string{"claude-code"}, Enabled: true,
				Models: []ModelSpec{{ID: "fast-model", Tier: "fast", CostLabel: "free"}},
			},
			{
				ID: "smart", Name: "Smart", Kind: ProviderKindAnthropicCompatible,
				SupportsAgents: []string{"claude-code"}, Enabled: true,
				Models: []ModelSpec{{ID: "smart-model", Tier: "smart", CostLabel: "paid"}},
			},
		},
		teams: []TeamProfile{{
			ID: "heavy", Name: "Heavy", Enabled: true,
			Phases: map[RoutePhase]PhasePolicy{
				PhaseExecute: {
					Agent:            "claude-code",
					ProviderPriority: []string{"fast", "smart"},
				},
			},
		}},
		defaults: DefaultRoutingDefaults(),
	})

	prompt := "Please refactor the architecture and debug the security migration across the repository with browser and tool support."
	decision, err := resolver.Resolve(context.Background(), ResolveRequest{
		Team: "heavy", Phase: PhaseExecute, Prompt: prompt,
	})
	if err != nil {
		t.Fatal(err)
	}
	if decision.Provider != "smart" {
		t.Fatalf("heavy selected provider %q, want smart", decision.Provider)
	}
	foundRejected := false
	for _, skipped := range decision.Skipped {
		if skipped.Provider == "fast" && strings.Contains(skipped.Reason, "quality floor") {
			foundRejected = true
			break
		}
	}
	if !foundRejected {
		t.Fatalf("fast candidate was not rejected by quality floor: %+v", decision.Skipped)
	}
}
