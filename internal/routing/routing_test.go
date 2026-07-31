package routing

import (
	"context"
	"fmt"
	"testing"
)

// ---------------------------------------------------------------------------
// DispatchSelection validation
// ---------------------------------------------------------------------------

func TestDispatchSelectionValidate(t *testing.T) {
	tests := []struct {
		name    string
		sel     DispatchSelection
		wantErr bool
	}{
		{
			name:    "empty is valid (old clients)",
			sel:     DispatchSelection{},
			wantErr: false,
		},
		{
			name: "auto requires team",
			sel: DispatchSelection{
				Mode: DispatchAuto,
			},
			wantErr: true,
		},
		{
			name: "auto with team is valid",
			sel: DispatchSelection{
				Mode: DispatchAuto,
				Team: "claude-first",
			},
			wantErr: false,
		},
		{
			name: "auto with agent is rejected",
			sel: DispatchSelection{
				Mode:  DispatchAuto,
				Team:  "claude-first",
				Agent: "claude-code",
			},
			wantErr: true,
		},
		{
			name: "manual requires agent, provider, model",
			sel: DispatchSelection{
				Mode: DispatchManual,
			},
			wantErr: true,
		},
		{
			name: "manual with all fields is valid",
			sel: DispatchSelection{
				Mode:     DispatchManual,
				Agent:    "claude-code",
				Provider: "anthropic-byok",
				Model:    "claude-sonnet-4",
			},
			wantErr: false,
		},
		{
			name: "manual with team is rejected",
			sel: DispatchSelection{
				Mode:     DispatchManual,
				Agent:    "claude-code",
				Provider: "anthropic-byok",
				Model:    "claude-sonnet-4",
				Team:     "claude-first",
			},
			wantErr: true,
		},
		{
			name:    "unknown mode",
			sel:     DispatchSelection{Mode: "unknown"},
			wantErr: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.sel.Validate()
			if (err != nil) != tt.wantErr {
				t.Errorf("Validate() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// ProviderProfile validation
// ---------------------------------------------------------------------------

func TestValidateProviderProfile(t *testing.T) {
	tests := []struct {
		name    string
		profile ProviderProfile
		wantErr bool
	}{
		{
			name:    "empty id",
			profile: ProviderProfile{},
			wantErr: true,
		},
		{
			name: "valid profile",
			profile: ProviderProfile{
				ID:             "claude-sub",
				Name:           "Claude Subscription",
				Kind:           ProviderKindSubscription,
				SupportsAgents: []string{"claude-code"},
				Enabled:        true,
				Models: []ModelSpec{
					{ID: "claude-sonnet-4", Tier: "balanced", CostLabel: "paid"},
				},
			},
			wantErr: false,
		},
		{
			name: "unknown kind",
			profile: ProviderProfile{
				ID:             "test",
				Name:           "Test",
				Kind:           "unknown-kind",
				SupportsAgents: []string{"kin"},
				Models:         []ModelSpec{{ID: "test-model", Tier: "balanced"}},
			},
			wantErr: true,
		},
		{
			name: "empty supports_agents",
			profile: ProviderProfile{
				ID:     "test",
				Name:   "Test",
				Kind:   ProviderKindOpenAICompatible,
				Models: []ModelSpec{{ID: "test-model", Tier: "balanced"}},
			},
			wantErr: true,
		},
		{
			name: "duplicate model id",
			profile: ProviderProfile{
				ID:             "test",
				Name:           "Test",
				Kind:           ProviderKindOpenAICompatible,
				SupportsAgents: []string{"kin"},
				Models: []ModelSpec{
					{ID: "model-1", Tier: "balanced"},
					{ID: "model-1", Tier: "smart"},
				},
			},
			wantErr: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateProviderProfile(tt.profile)
			if (err != nil) != tt.wantErr {
				t.Errorf("ValidateProviderProfile() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// TeamProfile validation
// ---------------------------------------------------------------------------

func TestValidateTeamProfile(t *testing.T) {
	agentExists := func(id string) bool {
		return id == "claude-code" || id == "kin" || id == "codex"
	}
	providerExists := func(id string) bool {
		return id == "claude-sub" || id == "anthropic-byok"
	}

	tests := []struct {
		name    string
		team    TeamProfile
		wantErr bool
	}{
		{
			name:    "empty id",
			team:    TeamProfile{},
			wantErr: true,
		},
		{
			name: "valid team",
			team: TeamProfile{
				ID:    "claude-first",
				Name:  "Claude First",
				Alias: "A",
				Phases: map[RoutePhase]PhasePolicy{
					PhaseExecute: {
						Agent:            "claude-code",
						Tier:             "balanced",
						ProviderPriority: []string{"claude-sub", "anthropic-byok"},
						Fallback:         []string{"next_provider_same_tier"},
					},
				},
			},
			wantErr: false,
		},
		{
			name: "unknown agent",
			team: TeamProfile{
				ID:   "test",
				Name: "Test",
				Phases: map[RoutePhase]PhasePolicy{
					PhaseExecute: {
						Agent:            "unknown",
						ProviderPriority: []string{"claude-sub"},
					},
				},
			},
			wantErr: true,
		},
		{
			name: "unknown provider",
			team: TeamProfile{
				ID:   "test",
				Name: "Test",
				Phases: map[RoutePhase]PhasePolicy{
					PhaseExecute: {
						Agent:            "claude-code",
						ProviderPriority: []string{"unknown-provider"},
					},
				},
			},
			wantErr: true,
		},
		{
			name: "unknown fallback value",
			team: TeamProfile{
				ID:   "test",
				Name: "Test",
				Phases: map[RoutePhase]PhasePolicy{
					PhaseExecute: {
						Agent:            "claude-code",
						ProviderPriority: []string{"claude-sub"},
						Fallback:         []string{"unknown_fallback"},
					},
				},
			},
			wantErr: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateTeamProfile(tt.team, agentExists, providerExists, nil)
			if (err != nil) != tt.wantErr {
				t.Errorf("ValidateTeamProfile() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Provider-agent compatibility
// ---------------------------------------------------------------------------

func TestProviderSupportsAgent(t *testing.T) {
	prov := ProviderProfile{
		ID:             "test",
		Kind:           ProviderKindAnthropicCompatible,
		SupportsAgents: []string{"claude-code"},
		Enabled:        true,
	}

	if !ProviderSupportsAgent(prov, "claude-code") {
		t.Error("expected claude-code to be supported by anthropic-compatible provider")
	}
	if ProviderSupportsAgent(prov, "kin") {
		t.Error("expected kin to NOT be supported by anthropic-compatible provider")
	}

	// Disabled provider.
	prov.Enabled = false
	if ProviderSupportsAgent(prov, "claude-code") {
		t.Error("expected disabled provider to not support any agent")
	}
}

func TestBuiltinAdapterCapabilities(t *testing.T) {
	caps := BuiltinAdapterCapabilities()
	if len(caps) == 0 {
		t.Fatal("expected at least one adapter capability")
	}
	found := make(map[string]bool)
	for _, c := range caps {
		if found[c.AgentID] {
			t.Errorf("duplicate agent %q in capabilities", c.AgentID)
		}
		found[c.AgentID] = true
		if len(c.SupportedKinds) == 0 {
			t.Errorf("agent %q has no supported kinds", c.AgentID)
		}
	}
}

// ---------------------------------------------------------------------------
// Reference checks
// ---------------------------------------------------------------------------

func TestCheckProviderReferences(t *testing.T) {
	teams := []TeamProfile{
		{
			ID: "team-a",
			Phases: map[RoutePhase]PhasePolicy{
				PhaseExecute: {
					Agent:            "claude-code",
					ProviderPriority: []string{"provider-1", "provider-2"},
				},
			},
		},
		{
			ID: "team-b",
			Phases: map[RoutePhase]PhasePolicy{
				PhaseExecute: {
					Agent:            "kin",
					ProviderPriority: []string{"provider-2"},
				},
			},
		},
	}

	ref := CheckProviderReferences("provider-1", teams)
	if len(ref.TeamIDs) != 1 || ref.TeamIDs[0] != "team-a" {
		t.Errorf("expected 1 reference (team-a), got %v", ref.TeamIDs)
	}

	ref = CheckProviderReferences("provider-3", teams)
	if len(ref.TeamIDs) != 0 {
		t.Errorf("expected 0 references, got %v", ref.TeamIDs)
	}
}

func TestCheckAliasConflict(t *testing.T) {
	teams := []TeamProfile{
		{ID: "team-a", Alias: "A"},
		{ID: "team-b", Alias: "B"},
	}

	if conflict := CheckAliasConflict("A", "team-a", teams); conflict != "" {
		t.Errorf("expected no conflict when excluding self, got %q", conflict)
	}
	if conflict := CheckAliasConflict("A", "team-b", teams); conflict != "team-a" {
		t.Errorf("expected conflict with team-a, got %q", conflict)
	}
	if conflict := CheckAliasConflict("C", "", teams); conflict != "" {
		t.Errorf("expected no conflict for unknown alias, got %q", conflict)
	}
}

// ---------------------------------------------------------------------------
// Seed policy
// ---------------------------------------------------------------------------

func TestSeedPolicy(t *testing.T) {
	team, err := SeedPolicy("claude-code", nil, []string{"claude-sub"})
	if err != nil {
		t.Fatalf("SeedPolicy() error = %v", err)
	}
	if team.ID != "default" {
		t.Errorf("expected id 'default', got %q", team.ID)
	}
	if !team.Enabled {
		t.Error("expected seed policy to be enabled")
	}
	pp, ok := team.Phases[PhaseExecute]
	if !ok {
		t.Fatal("expected execute phase")
	}
	if pp.Agent != "claude-code" {
		t.Errorf("expected agent claude-code, got %q", pp.Agent)
	}
	if len(pp.ProviderPriority) != 1 || pp.ProviderPriority[0] != "claude-sub" {
		t.Errorf("expected provider priority [claude-sub], got %v", pp.ProviderPriority)
	}
}

// ---------------------------------------------------------------------------
// Routing defaults validation
// ---------------------------------------------------------------------------

func TestValidateRoutingDefaults(t *testing.T) {
	teamExists := func(id string) bool {
		return id == "default-team"
	}

	tests := []struct {
		name     string
		defaults RoutingDefaults
		wantErr  bool
	}{
		{
			name:     "disabled is valid",
			defaults: RoutingDefaults{Enabled: false},
			wantErr:  false,
		},
		{
			name: "enabled but missing default team",
			defaults: RoutingDefaults{
				Enabled:     true,
				DefaultTeam: "",
			},
			wantErr: true,
		},
		{
			name: "enabled with valid team",
			defaults: RoutingDefaults{
				Enabled:     true,
				DefaultTeam: "default-team",
				Objective:   "balanced",
			},
			wantErr: false,
		},
		{
			name: "unknown objective",
			defaults: RoutingDefaults{
				Enabled:     true,
				DefaultTeam: "default-team",
				Objective:   "unknown",
			},
			wantErr: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateRoutingDefaults(tt.defaults, teamExists)
			if (err != nil) != tt.wantErr {
				t.Errorf("ValidateRoutingDefaults() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

func TestBuildAutoPreview(t *testing.T) {
	team := TeamProfile{
		ID:      "claude-first",
		Name:    "Claude First",
		Enabled: true,
		Phases: map[RoutePhase]PhasePolicy{
			PhaseExecute: {
				Agent:            "claude-code",
				Tier:             "balanced",
				ProviderPriority: []string{"claude-sub"},
				Fallback:         []string{"next_provider_same_tier"},
			},
		},
	}

	providers := []ProviderProfile{
		{
			ID:             "claude-sub",
			Name:           "Claude Sub",
			Kind:           ProviderKindSubscription,
			SupportsAgents: []string{"claude-code"},
			Enabled:        true,
			Models: []ModelSpec{
				{ID: "claude-sonnet-4", Tier: "balanced", CostLabel: "paid"},
			},
		},
	}

	preview := BuildAutoPreview(team, ObjectiveBalanced, providers)
	if preview.Blocked {
		t.Errorf("expected preview to not be blocked, got %q", preview.BlockedReason)
	}
	if len(preview.Phases) != 1 {
		t.Fatalf("expected 1 phase, got %d", len(preview.Phases))
	}
	if preview.Phases[0].Status != "resolved" {
		t.Errorf("expected phase status 'resolved', got %q", preview.Phases[0].Status)
	}
	if preview.Phases[0].Provider != "claude-sub" {
		t.Errorf("expected provider claude-sub, got %q", preview.Phases[0].Provider)
	}
}

func TestBuildAutoPreviewBlocked(t *testing.T) {
	team := TeamProfile{
		ID:   "empty-team",
		Name: "Empty Team",
		Phases: map[RoutePhase]PhasePolicy{
			PhaseExecute: {
				Agent:            "unknown-agent",
				ProviderPriority: []string{"unknown-provider"},
			},
		},
	}

	preview := BuildAutoPreview(team, ObjectiveBalanced, nil)
	if !preview.Blocked {
		t.Error("expected preview to be blocked")
	}
}

func TestBuildManualPreview(t *testing.T) {
	providers := []ProviderProfile{
		{
			ID:             "anthropic-byok",
			Name:           "Anthropic BYOK",
			Kind:           ProviderKindAnthropicCompatible,
			SupportsAgents: []string{"claude-code"},
			Enabled:        true,
			Models: []ModelSpec{
				{ID: "claude-sonnet-4", Tier: "balanced", CostLabel: "paid"},
			},
		},
	}

	preview := BuildManualPreview("claude-code", "anthropic-byok", "claude-sonnet-4", providers)
	if preview.Blocked {
		t.Errorf("expected preview to not be blocked, got %q", preview.BlockedReason)
	}

	// Unsupported agent.
	preview2 := BuildManualPreview("kin", "anthropic-byok", "claude-sonnet-4", providers)
	if !preview2.Blocked {
		t.Error("expected preview to be blocked for unsupported agent")
	}
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

func TestClassifyFailure(t *testing.T) {
	tests := []struct {
		name  string
		err   error
		class FailureClass
	}{
		{
			name:  "rate limit",
			err:   fmt.Errorf("rate limit exceeded"),
			class: FailureQuotaExhausted,
		},
		{
			name:  "quota",
			err:   fmt.Errorf("insufficient_quota"),
			class: FailureQuotaExhausted,
		},
		{
			name:  "auth",
			err:   fmt.Errorf("401 unauthorized"),
			class: FailureAuthConfig,
		},
		{
			name:  "model not found",
			err:   fmt.Errorf("model not found"),
			class: FailureModelUnavailable,
		},
		{
			name:  "transient",
			err:   fmt.Errorf("connection timeout"),
			class: FailureTransient,
		},
		{
			name:  "nil error",
			err:   nil,
			class: FailureTaskError,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := ClassifyFailure(tt.err, "test-provider", "test-model")
			if f.Class != tt.class {
				t.Errorf("ClassifyFailure() class = %v, want %v", f.Class, tt.class)
			}
		})
	}
}

func TestIsFallbackSafe(t *testing.T) {
	safe := []FailureClass{FailureQuotaExhausted, FailureTransient, FailureModelUnavailable}
	unsafe := []FailureClass{FailureAuthConfig, FailureTaskError}

	for _, c := range safe {
		if !IsFallbackSafe(c) {
			t.Errorf("expected %v to be fallback-safe", c)
		}
	}
	for _, c := range unsafe {
		if IsFallbackSafe(c) {
			t.Errorf("expected %v to NOT be fallback-safe", c)
		}
	}
}

// ---------------------------------------------------------------------------
// Options builder
// ---------------------------------------------------------------------------

func TestBuildOptions(t *testing.T) {
	agents := []AgentInfo{
		{ID: "claude-code", Name: "Claude Code"},
		{ID: "kin", Name: "Kin"},
	}
	profiles := []ProviderProfile{
		{
			ID:             "claude-sub",
			Name:           "Claude Sub",
			Kind:           ProviderKindSubscription,
			SupportsAgents: []string{"claude-code"},
			Enabled:        true,
			Models:         []ModelSpec{{ID: "sonnet-4", Tier: "balanced"}},
		},
	}
	teams := []TeamProfile{
		{ID: "default", Name: "Default", Enabled: true},
	}

	opts := BuildOptions(agents, profiles, teams, DefaultRoutingDefaults())
	if len(opts.Agents) != 2 {
		t.Errorf("expected 2 agents, got %d", len(opts.Agents))
	}
	if len(opts.Providers) != 1 {
		t.Errorf("expected 1 provider, got %d", len(opts.Providers))
	}
	if len(opts.Teams) != 1 {
		t.Errorf("expected 1 team, got %d", len(opts.Teams))
	}
}

// ---------------------------------------------------------------------------
// Disable impact
// ---------------------------------------------------------------------------

func TestPreviewDisableProvider(t *testing.T) {
	providers := []ProviderProfile{
		{ID: "provider-1", Enabled: true},
		{ID: "provider-2", Enabled: true},
	}
	teams := []TeamProfile{
		{
			ID:      "team-a",
			Enabled: true,
			Phases: map[RoutePhase]PhasePolicy{
				PhaseExecute: {
					Agent:            "claude-code",
					ProviderPriority: []string{"provider-1", "provider-2"},
				},
			},
		},
	}

	impact := PreviewDisableProvider("provider-1", providers, teams)
	if len(impact.Teams) != 1 {
		t.Errorf("expected 1 impacted team, got %d", len(impact.Teams))
	}
	if impact.Blocking {
		// provider-2 is still available, so not blocking.
		t.Errorf("expected non-blocking impact, got blocking")
	}

	// Test blocking removal.
	impact2 := PreviewDisableProvider("provider-1", providers, []TeamProfile{
		{
			ID:      "team-b",
			Enabled: true,
			Phases: map[RoutePhase]PhasePolicy{
				PhaseExecute: {
					Agent:            "claude-code",
					ProviderPriority: []string{"provider-1"},
				},
			},
		},
	})
	if !impact2.Blocking {
		t.Error("expected blocking impact when no alternative provider")
	}
}

// ---------------------------------------------------------------------------
// Resolver Next — fallback
// ---------------------------------------------------------------------------

type stubStore struct {
	providers []ProviderProfile
	teams     []TeamProfile
	defaults  RoutingDefaults
}

func (s *stubStore) ListProviderProfiles(ctx context.Context) ([]ProviderProfile, error) {
	return s.providers, nil
}
func (s *stubStore) ListTeamProfiles(ctx context.Context) ([]TeamProfile, error) {
	return s.teams, nil
}
func (s *stubStore) GetRoutingDefaults(ctx context.Context) (RoutingDefaults, error) {
	return s.defaults, nil
}

func TestResolverNextFallback(t *testing.T) {
	store := &stubStore{
		providers: []ProviderProfile{
			{
				ID: "claude-sub", Name: "Claude Sub", Kind: ProviderKindSubscription,
				SupportsAgents: []string{"claude-code"}, Enabled: true,
				Models: []ModelSpec{{ID: "claude-sonnet-4", Tier: "balanced", CostLabel: "paid"}},
			},
			{
				ID: "anthropic-byok", Name: "Anthropic BYOK", Kind: ProviderKindAnthropicCompatible,
				SupportsAgents: []string{"claude-code"}, Enabled: true,
				Models: []ModelSpec{{ID: "claude-sonnet-4", Tier: "balanced", CostLabel: "paid"}},
			},
		},
		teams: []TeamProfile{
			{
				ID: "claude-first", Name: "Claude First", Enabled: true,
				Phases: map[RoutePhase]PhasePolicy{
					PhaseExecute: {
						Agent: "claude-code", Tier: "balanced",
						ProviderPriority: []string{"claude-sub", "anthropic-byok"},
						Fallback:         []string{"next_provider_same_tier"},
					},
				},
			},
		},
		defaults: DefaultRoutingDefaults(),
	}

	resolver := NewDefaultResolver(store)

	// Resolve first — should get claude-sub.
	req := ResolveRequest{Team: "claude-first", Phase: PhaseExecute, Agent: "claude-code"}
	first, err := resolver.Resolve(context.Background(), req)
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	if first.Provider != "claude-sub" {
		t.Errorf("expected first provider claude-sub, got %q", first.Provider)
	}

	// Next should fallback to anthropic-byok.
	fallback, ok := resolver.Next(context.Background(), first, Failure{
		Class:    FailureQuotaExhausted,
		Provider: "claude-sub",
		Model:    "claude-sonnet-4",
		Message:  "window exhausted",
		Attempt:  1,
	})
	if !ok {
		t.Fatal("expected fallback to be available")
	}
	if fallback.Provider != "anthropic-byok" {
		t.Errorf("expected fallback provider anthropic-byok, got %q", fallback.Provider)
	}
	if fallback.Agent != "claude-code" {
		t.Errorf("expected fallback agent to remain claude-code, got %q", fallback.Agent)
	}
}

func TestResolverNextNoFallback(t *testing.T) {
	store := &stubStore{
		providers: []ProviderProfile{
			{
				ID: "claude-sub", Name: "Claude Sub", Kind: ProviderKindSubscription,
				SupportsAgents: []string{"claude-code"}, Enabled: true,
				Models: []ModelSpec{{ID: "claude-sonnet-4", Tier: "balanced", CostLabel: "paid"}},
			},
		},
		teams: []TeamProfile{
			{
				ID: "claude-first", Name: "Claude First", Enabled: true,
				Phases: map[RoutePhase]PhasePolicy{
					PhaseExecute: {
						Agent: "claude-code", Tier: "balanced",
						ProviderPriority: []string{"claude-sub"},
					},
				},
			},
		},
		defaults: DefaultRoutingDefaults(),
	}

	resolver := NewDefaultResolver(store)

	req := ResolveRequest{Team: "claude-first", Phase: PhaseExecute, Agent: "claude-code"}
	first, err := resolver.Resolve(context.Background(), req)
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}

	// Next should fail — only one provider.
	_, ok := resolver.Next(context.Background(), first, Failure{
		Class:    FailureQuotaExhausted,
		Provider: "claude-sub",
		Model:    "claude-sonnet-4",
		Message:  "window exhausted",
		Attempt:  1,
	})
	if ok {
		t.Error("expected no fallback when only one provider")
	}
}

func TestResolverNextAuthConfigFailureSkipsProvider(t *testing.T) {
	store := &stubStore{
		providers: []ProviderProfile{
			{
				ID: "claude-sub", Name: "Claude Sub", Kind: ProviderKindSubscription,
				SupportsAgents: []string{"claude-code"}, Enabled: true,
				Models: []ModelSpec{{ID: "claude-sonnet-4", Tier: "balanced", CostLabel: "paid"}},
			},
			{
				ID: "anthropic-byok", Name: "Anthropic BYOK", Kind: ProviderKindAnthropicCompatible,
				SupportsAgents: []string{"claude-code"}, Enabled: true,
				Models: []ModelSpec{{ID: "claude-sonnet-4", Tier: "balanced", CostLabel: "paid"}},
			},
			{
				ID: "another-byok", Name: "Another BYOK", Kind: ProviderKindAnthropicCompatible,
				SupportsAgents: []string{"claude-code"}, Enabled: true,
				Models: []ModelSpec{{ID: "claude-sonnet-4", Tier: "balanced", CostLabel: "paid"}},
			},
		},
		teams: []TeamProfile{
			{
				ID: "claude-first", Name: "Claude First", Enabled: true,
				Phases: map[RoutePhase]PhasePolicy{
					PhaseExecute: {
						Agent: "claude-code", Tier: "balanced",
						ProviderPriority: []string{"claude-sub", "anthropic-byok", "another-byok"},
						Fallback:         []string{"next_provider_same_tier"},
					},
				},
			},
		},
		defaults: DefaultRoutingDefaults(),
	}

	resolver := NewDefaultResolver(store)

	req := ResolveRequest{Team: "claude-first", Phase: PhaseExecute, Agent: "claude-code"}
	first, err := resolver.Resolve(context.Background(), req)
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}

	// Auth failure on claude-sub should skip all claude-sub candidates.
	fallback, ok := resolver.Next(context.Background(), first, Failure{
		Class:    FailureAuthConfig,
		Provider: "claude-sub",
		Model:    "claude-sonnet-4",
		Message:  "invalid API key",
		Attempt:  1,
	})
	if !ok {
		t.Fatal("expected fallback to be available")
	}
	if fallback.Provider == "claude-sub" {
		t.Errorf("auth config failure should skip the entire provider, got %q", fallback.Provider)
	}
}

func TestResolverNextWindowExhausted(t *testing.T) {
	store := &stubStore{
		providers: []ProviderProfile{
			{
				ID: "claude-sub", Name: "Claude Sub", Kind: ProviderKindSubscription,
				SupportsAgents: []string{"claude-code"}, Enabled: true,
				Models: []ModelSpec{{ID: "claude-sonnet-4", Tier: "balanced", CostLabel: "paid"}},
			},
			{
				ID: "anthropic-byok", Name: "Anthropic BYOK", Kind: ProviderKindAnthropicCompatible,
				SupportsAgents: []string{"claude-code"}, Enabled: true,
				Models: []ModelSpec{{ID: "claude-sonnet-4", Tier: "balanced", CostLabel: "paid"}},
			},
		},
		teams: []TeamProfile{
			{
				ID: "claude-first", Name: "Claude First", Enabled: true,
				Phases: map[RoutePhase]PhasePolicy{
					PhaseExecute: {
						Agent: "claude-code", Tier: "balanced",
						ProviderPriority: []string{"claude-sub", "anthropic-byok"},
						Fallback:         []string{"next_provider_same_tier"},
					},
				},
			},
		},
		defaults: DefaultRoutingDefaults(),
	}

	// Window checker marks claude-sub as exhausted.
	checker := &stubWindowChecker{exhausted: map[string]bool{"claude-sub": true}}
	resolver := NewDefaultResolver(store, WithUsageWindowChecker(checker))

	// First Resolve should skip claude-sub and pick anthropic-byok.
	req := ResolveRequest{Team: "claude-first", Phase: PhaseExecute, Agent: "claude-code"}
	first, err := resolver.Resolve(context.Background(), req)
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	if first.Provider != "anthropic-byok" {
		t.Errorf("expected first provider anthropic-byok (skipping exhausted claude-sub), got %q", first.Provider)
	}
}

type stubWindowChecker struct {
	exhausted map[string]bool
}

func (s *stubWindowChecker) IsExhausted(ctx context.Context, providerID, agentID, kind string) bool {
	return s.exhausted[providerID]
}

func TestResolverNextPreservesTeamPhaseObjective(t *testing.T) {
	store := &stubStore{
		providers: []ProviderProfile{
			{
				ID: "provider-a", Name: "Provider A", Kind: ProviderKindAnthropicCompatible,
				SupportsAgents: []string{"claude-code"}, Enabled: true,
				Models: []ModelSpec{{ID: "model-a1", Tier: "balanced", CostLabel: "paid"}},
			},
			{
				ID: "provider-b", Name: "Provider B", Kind: ProviderKindAnthropicCompatible,
				SupportsAgents: []string{"claude-code"}, Enabled: true,
				Models: []ModelSpec{{ID: "model-b1", Tier: "balanced", CostLabel: "paid"}},
			},
			{
				ID: "provider-c", Name: "Provider C", Kind: ProviderKindAnthropicCompatible,
				SupportsAgents: []string{"claude-code"}, Enabled: true,
				Models: []ModelSpec{{ID: "model-c1", Tier: "balanced", CostLabel: "paid"}},
			},
		},
		teams: []TeamProfile{
			{
				ID: "team-alpha", Name: "Team Alpha", Enabled: true,
				DefaultObjective: "cost-min",
				Phases: map[RoutePhase]PhasePolicy{
					PhaseExecute: {
						Agent: "claude-code", Tier: "balanced",
						ProviderPriority: []string{"provider-a", "provider-b", "provider-c"},
						Fallback:         []string{"next_provider_same_tier"},
					},
				},
			},
		},
		defaults: DefaultRoutingDefaults(),
	}

	resolver := NewDefaultResolver(store)

	// First Resolve.
	req := ResolveRequest{Team: "team-alpha", Phase: PhaseExecute, Objective: "cost-min", Agent: "claude-code"}
	first, err := resolver.Resolve(context.Background(), req)
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
	if first.Team != "team-alpha" || first.Phase != PhaseExecute || first.Objective != "cost-min" {
		t.Errorf("first Decision missing metadata: team=%q phase=%q objective=%q", first.Team, first.Phase, first.Objective)
	}

	// First fallback.
	second, ok := resolver.Next(context.Background(), first, Failure{
		Class: FailureQuotaExhausted, Provider: "provider-a", Model: "model-a1", Message: "exhausted", Attempt: 1,
	})
	if !ok {
		t.Fatal("expected first fallback")
	}
	if second.Team != "team-alpha" {
		t.Errorf("second fallback team=%q, want team-alpha", second.Team)
	}
	if second.Phase != PhaseExecute {
		t.Errorf("second fallback phase=%q, want execute", second.Phase)
	}
	if second.Objective != "cost-min" {
		t.Errorf("second fallback objective=%q, want cost-min", second.Objective)
	}

	// Second fallback — must still carry original team/phase/objective.
	third, ok := resolver.Next(context.Background(), second, Failure{
		Class: FailureQuotaExhausted, Provider: "provider-b", Model: "model-b1", Message: "exhausted", Attempt: 2,
	})
	if !ok {
		t.Fatal("expected second fallback")
	}
	if third.Team != "team-alpha" {
		t.Errorf("third fallback team=%q, want team-alpha", third.Team)
	}
	if third.Phase != PhaseExecute {
		t.Errorf("third fallback phase=%q, want execute", third.Phase)
	}
	if third.Objective != "cost-min" {
		t.Errorf("third fallback objective=%q, want cost-min", third.Objective)
	}
	if third.Provider != "provider-c" {
		t.Errorf("third fallback provider=%q, want provider-c", third.Provider)
	}
}

// TestResolverNextFollowsFallbackOrder verifies that Next() follows the
// configured fallback order (same_provider_same_tier → next_provider_same_tier
// → same_provider_lower_tier → next_provider_lower_tier) instead of just
// picking the first available candidate.
func TestResolverNextFollowsFallbackOrder(t *testing.T) {
	providers := []ProviderProfile{
		{
			ID: "prov-a", Name: "A", Kind: ProviderKindAnthropicCompatible,
			SupportsAgents: []string{"claude-code"}, Enabled: true,
			Models: []ModelSpec{
				{ID: "a-smart-1", Tier: "smart", CostLabel: "paid"},
				{ID: "a-smart-2", Tier: "smart", CostLabel: "free"},
			},
		},
		{
			ID: "prov-b", Name: "B", Kind: ProviderKindAnthropicCompatible,
			SupportsAgents: []string{"claude-code"}, Enabled: true,
			Models: []ModelSpec{
				{ID: "b-smart", Tier: "smart", CostLabel: "paid"},
			},
		},
	}
	teams := []TeamProfile{
		{
			ID: "t1", Name: "T1", Enabled: true,
			Phases: map[RoutePhase]PhasePolicy{
				PhaseExecute: {
					Agent:            "claude-code",
					Tier:             "smart",
					ProviderPriority: []string{"prov-a", "prov-b"},
					Fallback:         []string{"same_provider_same_tier", "next_provider_same_tier"},
				},
			},
		},
	}
	store := &stubStore{providers: providers, teams: teams}
	resolver := NewDefaultResolver(store)

	// Failure on a-smart-1: same_provider_same_tier should pick a-smart-2.
	failure := Failure{
		Class: FailureQuotaExhausted, Provider: "prov-a", Model: "a-smart-1",
		Message: "quota", Attempt: 1,
	}
	first, ok := resolver.Next(context.Background(), Decision{
		Agent: "claude-code", Provider: "prov-a", Model: "a-smart-1",
		Team: "t1", Phase: PhaseExecute, Objective: "cost-min",
	}, failure)
	if !ok {
		t.Fatal("expected fallback to same_provider_same_tier")
	}
	if first.Provider != "prov-a" || first.Model != "a-smart-2" {
		t.Errorf("same_provider_same_tier: got %s/%s, want prov-a/a-smart-2", first.Provider, first.Model)
	}

	// Second failure on a-smart-2: next_provider_same_tier should pick b-smart.
	failure2 := Failure{
		Class: FailureQuotaExhausted, Provider: "prov-a", Model: "a-smart-2",
		Message: "quota", Attempt: 2,
	}
	first.FailedProviders = append(first.FailedProviders, "prov-a")
	second, ok := resolver.Next(context.Background(), first, failure2)
	if !ok {
		t.Fatal("expected fallback to next_provider_same_tier")
	}
	if second.Provider != "prov-b" || second.Model != "b-smart" {
		t.Errorf("next_provider_same_tier: got %s/%s, want prov-b/b-smart", second.Provider, second.Model)
	}
}

// TestValidateTeamProfileWithProviders verifies that ValidateTeamProfile
// checks provider-agent compatibility and tier model availability when
// providers are supplied.
func TestValidateTeamProfileWithProviders(t *testing.T) {
	providers := []ProviderProfile{
		{
			ID: "p1", Name: "P1", Kind: ProviderKindAnthropicCompatible,
			SupportsAgents: []string{"claude-code"}, Enabled: true,
			Models: []ModelSpec{{ID: "m1", Tier: "smart"}},
		},
		{
			ID: "p2", Name: "P2", Kind: ProviderKindAnthropicCompatible,
			SupportsAgents: []string{"claude-code"}, Enabled: false,
			Models: []ModelSpec{{ID: "m2", Tier: "smart"}},
		},
		{
			ID: "p3", Name: "P3", Kind: ProviderKindGrokCompatible,
			SupportsAgents: []string{"grok"}, Enabled: true,
			Models: []ModelSpec{{ID: "m3", Tier: "fast"}},
		},
		{
			ID: "p4", Name: "P4", Kind: ProviderKindOpenAICompatible,
			SupportsAgents: []string{"grok"}, Enabled: true,
			Models: []ModelSpec{{ID: "m4", Tier: "smart"}},
		},
	}
	agentExists := func(id string) bool {
		return id == "claude-code" || id == "grok" || id == "codex" || id == "kin"
	}
	providerExists := func(id string) bool { return id == "p1" || id == "p2" || id == "p3" || id == "p4" }

	tests := []struct {
		name    string
		team    TeamProfile
		wantErr bool
	}{
		{
			name: "valid with compatible provider",
			team: TeamProfile{
				ID: "t", Name: "T", Enabled: true,
				Phases: map[RoutePhase]PhasePolicy{
					PhaseExecute: {
						Agent: "claude-code", ProviderPriority: []string{"p1"},
						Fallback: []string{"next_provider_same_tier"},
					},
				},
			},
			wantErr: false,
		},
		{
			name: "disabled provider rejected",
			team: TeamProfile{
				ID: "t", Name: "T", Enabled: true,
				Phases: map[RoutePhase]PhasePolicy{
					PhaseExecute: {
						Agent: "claude-code", ProviderPriority: []string{"p2"},
					},
				},
			},
			wantErr: true,
		},
		{
			name: "provider does not support agent",
			team: TeamProfile{
				ID: "t", Name: "T", Enabled: true,
				Phases: map[RoutePhase]PhasePolicy{
					PhaseExecute: {
						Agent: "claude-code", ProviderPriority: []string{"p3"},
					},
				},
			},
			wantErr: true,
		},
		{
			name: "adapter kind incompatible",
			team: TeamProfile{
				ID: "t", Name: "T", Enabled: true,
				Phases: map[RoutePhase]PhasePolicy{
					PhaseExecute: {
						Agent: "grok", ProviderPriority: []string{"p4"},
					},
				},
			},
			wantErr: true,
		},
		{
			name: "tier has no matching model",
			team: TeamProfile{
				ID: "t", Name: "T", Enabled: true,
				Phases: map[RoutePhase]PhasePolicy{
					PhaseExecute: {
						Agent: "claude-code", Tier: "balanced", ProviderPriority: []string{"p1"},
					},
				},
			},
			wantErr: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateTeamProfile(tt.team, agentExists, providerExists, providers)
			if (err != nil) != tt.wantErr {
				t.Errorf("ValidateTeamProfile() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}
