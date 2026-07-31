package routing

import (
	"context"
	"fmt"
	"sort"
)

// ---------------------------------------------------------------------------
// Resolver implementation
// ---------------------------------------------------------------------------

// Store is the data access interface the resolver needs.
type Store interface {
	// ListProviderProfiles returns all configured provider profiles.
	ListProviderProfiles(ctx context.Context) ([]ProviderProfile, error)
	// ListTeamProfiles returns all configured team profiles.
	ListTeamProfiles(ctx context.Context) ([]TeamProfile, error)
	// GetRoutingDefaults returns the global routing defaults.
	GetRoutingDefaults(ctx context.Context) (RoutingDefaults, error)
}

// UsageWindowChecker checks subscription usage windows for a provider/agent.
type UsageWindowChecker interface {
	// IsExhausted reports whether the given provider's subscription window for
	// the agent is exhausted. This is a best-effort check; false means the
	// window is either not exhausted or the check failed.
	IsExhausted(ctx context.Context, providerID, agentID, kind string) bool
}

// DefaultResolver implements the Resolver interface using the configured
// provider profiles, team profiles, and routing defaults.
type DefaultResolver struct {
	store         Store
	windowChecker UsageWindowChecker
}

// NewDefaultResolver creates a new DefaultResolver.
func NewDefaultResolver(store Store, opts ...ResolverOption) *DefaultResolver {
	r := &DefaultResolver{store: store}
	for _, opt := range opts {
		opt(r)
	}
	return r
}

// ResolverOption configures a DefaultResolver.
type ResolverOption func(*DefaultResolver)

// WithUsageWindowChecker sets the usage window checker for the resolver.
func WithUsageWindowChecker(checker UsageWindowChecker) ResolverOption {
	return func(r *DefaultResolver) {
		r.windowChecker = checker
	}
}

// Resolve performs the first selection for a phase.
func (r *DefaultResolver) Resolve(ctx context.Context, req ResolveRequest) (Decision, error) {
	providers, err := r.store.ListProviderProfiles(ctx)
	if err != nil {
		return Decision{}, fmt.Errorf("list providers: %w", err)
	}
	teams, err := r.store.ListTeamProfiles(ctx)
	if err != nil {
		return Decision{}, fmt.Errorf("list teams: %w", err)
	}

	// Find the team, preferring exact ID match over alias.
	var team *TeamProfile
	for i := range teams {
		if teams[i].ID == req.Team {
			team = &teams[i]
			break
		}
	}
	if team == nil {
		for i := range teams {
			if teams[i].Alias == req.Team {
				team = &teams[i]
				break
			}
		}
	}
	if team == nil {
		return Decision{}, fmt.Errorf("team %q not found", req.Team)
	}

	pp, ok := team.Phases[req.Phase]
	if !ok {
		return Decision{}, fmt.Errorf("team %q has no phase %q", req.Team, req.Phase)
	}

	objective := req.Objective
	if objective == "" {
		objective = team.DefaultObjective
		if objective == "" {
			objective = string(ObjectiveBalanced)
		}
	}

	// Expand candidates in priority order.
	candidates := expandCandidates(pp, providers, objective)
	if len(candidates) == 0 {
		return Decision{}, fmt.Errorf("no compatible provider/model for team %q phase %q agent %q",
			req.Team, req.Phase, pp.Agent)
	}

	// Filter out exhausted windows.
	available := r.filterExhausted(ctx, candidates, pp.Agent)
	if len(available) == 0 {
		available = candidates
	}

	selected := available[0]
	skipped := makeSkippedList(candidates, selected, available)

	return Decision{
		Agent:     pp.Agent,
		Provider:  selected.ProviderID,
		Model:     selected.ModelID,
		Tier:      selected.Tier,
		Reason:    fmt.Sprintf("selected from %d candidate(s) for team %q phase %q", len(candidates), req.Team, req.Phase),
		Skipped:   skipped,
		Team:      req.Team,
		Phase:     req.Phase,
		Objective: objective,
	}, nil
}

// Next performs a same-phase, same-agent fallback after a failure.
// It expands candidates, removes the failed provider/model, checks usage
// windows, and returns the next best candidate. It uses the team, phase,
// and objective carried in the previous Decision so fallback always uses
// the original phase policy, regardless of agent name collisions.
func (r *DefaultResolver) Next(ctx context.Context, previous Decision, failure Failure) (Decision, bool) {
	// Use the team and phase from the previous decision.
	team := previous.Team
	phase := previous.Phase
	objective := previous.Objective

	// Accumulate failed providers across the fallback chain.
	failedProviders := append([]string(nil), previous.FailedProviders...)
	failedProviders = append(failedProviders, failure.Provider)

	// Accumulate exhausted models: carry forward previous exhausted models
	// plus the current failure's model, so same-provider fallback steps
	// don't re-select models that already failed.
	exhaustedModels := append([]ExhaustedModel(nil), previous.ExhaustedModels...)
	exhaustedModels = append(exhaustedModels, ExhaustedModel{ProviderID: failure.Provider, ModelID: failure.Model})

	// Load the current configuration.
	providers, err := r.store.ListProviderProfiles(ctx)
	if err != nil {
		return Decision{}, false
	}
	teams, err := r.store.ListTeamProfiles(ctx)
	if err != nil {
		return Decision{}, false
	}

	// Find the team by id, preferring exact ID match over alias.
	var teamProfile *TeamProfile
	for i := range teams {
		if teams[i].ID == team {
			teamProfile = &teams[i]
			break
		}
	}
	if teamProfile == nil {
		for i := range teams {
			if teams[i].Alias == team {
				teamProfile = &teams[i]
				break
			}
		}
	}
	if teamProfile == nil {
		return Decision{}, false
	}

	pp, ok := teamProfile.Phases[phase]
	if !ok {
		return Decision{}, false
	}

	if objective == "" {
		objective = teamProfile.DefaultObjective
		if objective == "" {
			objective = string(ObjectiveBalanced)
		}
	}
	candidates := expandCandidates(pp, providers, objective)

	// Follow the configured fallback order from the phase policy.
	// If no fallback order is configured, use the default priority order.
	fallbackOrder := pp.Fallback
	if len(fallbackOrder) == 0 {
		fallbackOrder = []string{"next_provider_same_tier", "same_provider_lower_tier", "next_provider_lower_tier"}
	}

	// Determine the failed tier for tier-aware fallback.
	failedTier := ""
	failureProvider := findProviderProfile(providers, failure.Provider)
	if failureProvider != nil {
		for _, m := range failureProvider.Models {
			if m.ID == failure.Model {
				failedTier = m.Tier
				break
			}
		}
	}

	// Remove the exact failed candidate and any previously exhausted models.
	var baseCandidates []candidate
	for _, c := range candidates {
		if c.ProviderID == failure.Provider && c.ModelID == failure.Model {
			continue
		}
		// Also skip auth/config failures for the same provider entirely.
		if c.ProviderID == failure.Provider && failure.Class == FailureAuthConfig {
			continue
		}
		// Skip models that were already exhausted in previous fallback steps.
		if isExhaustedModel(exhaustedModels, c.ProviderID, c.ModelID) {
			continue
		}
		baseCandidates = append(baseCandidates, c)
	}

	// Try each fallback step in order.
	for _, step := range fallbackOrder {
		var pool []candidate
		switch step {
		case "same_provider_same_tier":
			for _, c := range baseCandidates {
				if c.ProviderID == failure.Provider && c.Tier == failedTier {
					pool = append(pool, c)
				}
			}
		case "next_provider_same_tier":
			for _, c := range baseCandidates {
				if c.Tier == failedTier && !containsProvider(failedProviders, c.ProviderID) {
					pool = append(pool, c)
				}
			}
		case "same_provider_lower_tier":
			for _, c := range baseCandidates {
				if c.ProviderID == failure.Provider && tierOrder(c.Tier) > tierOrder(failedTier) {
					pool = append(pool, c)
				}
			}
		case "next_provider_lower_tier":
			for _, c := range baseCandidates {
				if tierOrder(c.Tier) > tierOrder(failedTier) && !containsProvider(failedProviders, c.ProviderID) {
					pool = append(pool, c)
				}
			}
		}
		// Sort pool by priority (provider order), then tier.
		sort.Slice(pool, func(i, j int) bool {
			if pool[i].Priority != pool[j].Priority {
				return pool[i].Priority < pool[j].Priority
			}
			return tierOrder(pool[i].Tier) < tierOrder(pool[j].Tier)
		})
		// Filter exhausted windows.
		available := r.filterExhausted(ctx, pool, previous.Agent)
		if len(available) > 0 {
			selected := available[0]
			skipped := makeSkippedList(baseCandidates, selected, available)

			reason := fmt.Sprintf("fallback from %s/%s (step: %s): %s", failure.Provider, failure.Model, step, failure.Message)
			if failure.Class != "" {
				reason = fmt.Sprintf("%s (class: %s)", reason, failure.Class)
			}

			return Decision{
				Agent:           previous.Agent,
				Provider:        selected.ProviderID,
				Model:           selected.ModelID,
				Tier:            selected.Tier,
				Reason:          reason,
				Skipped:         skipped,
				Team:            previous.Team,
				Phase:           previous.Phase,
				Objective:       objective,
				FailedProviders: failedProviders,
				ExhaustedModels: exhaustedModels,
			}, true
		}
	}

	return Decision{}, false
}

// LookupProvider finds a provider profile by ID.
func (r *DefaultResolver) LookupProvider(ctx context.Context, providerID string) (ProviderProfile, error) {
	profiles, err := r.store.ListProviderProfiles(ctx)
	if err != nil {
		return ProviderProfile{}, err
	}
	for _, p := range profiles {
		if p.ID == providerID {
			return p, nil
		}
	}
	return ProviderProfile{}, fmt.Errorf("provider profile %q not found", providerID)
}

// filterExhausted removes candidates whose subscription windows are exhausted.
func (r *DefaultResolver) filterExhausted(ctx context.Context, candidates []candidate, agentID string) []candidate {
	if r.windowChecker == nil {
		return candidates
	}
	var out []candidate
	for _, c := range candidates {
		if r.windowChecker.IsExhausted(ctx, c.ProviderID, agentID, c.Kind) {
			continue
		}
		out = append(out, c)
	}
	return out
}

// ---------------------------------------------------------------------------
// Candidate expansion
// ---------------------------------------------------------------------------

// candidate represents one possible provider/model selection.
type candidate struct {
	ProviderID string
	ModelID    string
	Tier       string
	CostLabel  string
	Priority   int    // lower = higher priority in provider_priority list
	Kind       string // routing provider kind
}

// expandCandidates generates ordered candidates for a phase policy.
func expandCandidates(pp PhasePolicy, providers []ProviderProfile, objective string) []candidate {
	var candidates []candidate

	providerPriority := make(map[string]int, len(pp.ProviderPriority))
	for i, pid := range pp.ProviderPriority {
		providerPriority[pid] = i
	}

	for _, prov := range providers {
		if !prov.Enabled {
			continue
		}
		priority, ok := providerPriority[prov.ID]
		if !ok {
			continue
		}
		if !ProviderSupportsAgent(prov, pp.Agent) {
			continue
		}

		for _, m := range prov.Models {
			// Filter by tier if specified.
			if pp.Tier != "" && m.Tier != "" && m.Tier != pp.Tier {
				if !allowsLowerTierFallback(pp.Fallback) {
					continue
				}
			}
			candidates = append(candidates, candidate{
				ProviderID: prov.ID,
				ModelID:    m.ID,
				Tier:       m.Tier,
				CostLabel:  m.CostLabel,
				Priority:   priority,
				Kind:       string(prov.Kind),
			})
		}
	}

	// Sort by: priority (provider_priority order), then objective preference.
	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].Priority != candidates[j].Priority {
			return candidates[i].Priority < candidates[j].Priority
		}
		// Same provider: apply objective-based ordering.
		switch DispatchObjective(objective) {
		case ObjectiveCostMin:
			if candidates[i].CostLabel != candidates[j].CostLabel {
				return costOrder(candidates[i].CostLabel) < costOrder(candidates[j].CostLabel)
			}
			return tierOrder(candidates[i].Tier) > tierOrder(candidates[j].Tier)
		case ObjectiveIntelligentMax:
			if candidates[i].Tier != candidates[j].Tier {
				return tierOrder(candidates[i].Tier) < tierOrder(candidates[j].Tier)
			}
		default: // balanced
			if candidates[i].Tier != candidates[j].Tier {
				it := tierOrder(candidates[i].Tier)
				jt := tierOrder(candidates[j].Tier)
				return it < jt
			}
		}
		return candidates[i].ModelID < candidates[j].ModelID
	})

	return candidates
}

func allowsLowerTierFallback(fallbacks []string) bool {
	for _, f := range fallbacks {
		if f == "same_provider_lower_tier" || f == "next_provider_lower_tier" {
			return true
		}
	}
	return false
}

func makeSkippedList(all []candidate, selected candidate, available []candidate) []SkippedCandidate {
	skipped := make([]SkippedCandidate, 0, len(all)-1)
	seen := make(map[string]bool, len(all))
	for _, c := range all {
		if c.ProviderID == selected.ProviderID && c.ModelID == selected.ModelID {
			continue
		}
		key := c.ProviderID + "/" + c.ModelID
		if seen[key] {
			continue
		}
		seen[key] = true
		reason := "lower priority"
		// Check if it was in the available list.
		found := false
		for _, a := range available {
			if a.ProviderID == c.ProviderID && a.ModelID == c.ModelID {
				found = true
				break
			}
		}
		if !found {
			reason = "window exhausted or unavailable"
		}
		skipped = append(skipped, SkippedCandidate{
			Provider: c.ProviderID,
			Model:    c.ModelID,
			Reason:   reason,
		})
	}
	return skipped
}

// containsProvider reports whether providerID is in the list.
func containsProvider(list []string, providerID string) bool {
	for _, id := range list {
		if id == providerID {
			return true
		}
	}
	return false
}

// isExhaustedModel returns true if the (provider, model) pair has already been
// attempted and should not be re-selected during fallback.
func isExhaustedModel(exhausted []ExhaustedModel, providerID, modelID string) bool {
	for _, e := range exhausted {
		if e.ProviderID == providerID && e.ModelID == modelID {
			return true
		}
	}
	return false
}

// findProviderProfile finds a provider profile by ID in a slice of profiles.
func findProviderProfile(profiles []ProviderProfile, id string) *ProviderProfile {
	for i := range profiles {
		if profiles[i].ID == id {
			return &profiles[i]
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

// ClassifyFailure categorizes a provider error for fallback decisions.
func ClassifyFailure(err error, providerID string, modelID string) Failure {
	msg := ""
	if err != nil {
		msg = err.Error()
	}
	f := Failure{
		Provider: providerID,
		Model:    modelID,
		Message:  msg,
	}

	if err == nil {
		f.Class = FailureTaskError
		return f
	}

	errStr := err.Error()

	// Rate limit / quota / window exhausted.
	if containsAny(errStr, []string{
		"rate limit", "rate_limit", "too many requests", "429",
		"quota", "exhausted", "window exhausted", "usage limit",
		"insufficient_quota",
	}) {
		f.Class = FailureQuotaExhausted
		return f
	}

	// Auth / config errors.
	if containsAny(errStr, []string{
		"auth", "unauthorized", "401", "403", "api key",
		"invalid key", "permission", "forbidden",
	}) {
		f.Class = FailureAuthConfig
		return f
	}

	// Model unavailable.
	if containsAny(errStr, []string{
		"model not found", "model unavailable", "not found",
		"not supported", "does not exist",
	}) {
		f.Class = FailureModelUnavailable
		return f
	}

	// Default: transient (network, timeout, server error).
	f.Class = FailureTransient
	return f
}

// IsFallbackSafe reports whether the failure class is safe to retry with
// a different provider/model.
func IsFallbackSafe(class FailureClass) bool {
	switch class {
	case FailureQuotaExhausted, FailureTransient, FailureModelUnavailable:
		return true
	case FailureAuthConfig, FailureTaskError:
		return false
	}
	return false
}

func containsAny(s string, substrs []string) bool {
	for _, sub := range substrs {
		if contains(s, sub) {
			return true
		}
	}
	return false
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && containsString(s, substr)
}

func containsString(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
