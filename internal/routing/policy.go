// Package routing implements the auto model routing policy: team-aware profile
// resolution, provider-agent compatibility, dispatch selection, and route decision
// auditing (spec §4, §7 of the auto-model-routing plan).
package routing

import (
	"context"
	"fmt"
)

// ---------------------------------------------------------------------------
// Phase
// ---------------------------------------------------------------------------

// RoutePhase identifies a task phase within an orchestrated workflow.
type RoutePhase string

const (
	PhasePlan    RoutePhase = "plan"
	PhaseExecute RoutePhase = "execute"
	PhaseReview  RoutePhase = "review"
	PhaseChat    RoutePhase = "chat"
)

// ValidRoutePhase returns true for known phase values.
func ValidRoutePhase(p RoutePhase) bool {
	switch p {
	case PhasePlan, PhaseExecute, PhaseReview, PhaseChat:
		return true
	}
	return false
}

// ---------------------------------------------------------------------------
// Dispatch mode & objective
// ---------------------------------------------------------------------------

// DispatchMode selects between automatic team-aware routing and exact manual
// dispatch.
type DispatchMode string

const (
	DispatchAuto   DispatchMode = "auto"
	DispatchManual DispatchMode = "manual"
)

// ValidDispatchMode returns true for known dispatch modes.
func ValidDispatchMode(m DispatchMode) bool {
	switch m {
	case DispatchAuto, DispatchManual:
		return true
	}
	return false
}

// DispatchObjective expresses a cost/quality preference for auto routing.
type DispatchObjective string

const (
	ObjectiveBalanced       DispatchObjective = "balanced"
	ObjectiveCostMin        DispatchObjective = "cost-min"
	ObjectiveIntelligentMax DispatchObjective = "intelligent-max"
)

// ValidDispatchObjective returns true for known objectives.
func ValidDispatchObjective(o DispatchObjective) bool {
	switch o {
	case ObjectiveBalanced, ObjectiveCostMin, ObjectiveIntelligentMax:
		return true
	}
	return false
}

// ---------------------------------------------------------------------------
// Provider profile
// ---------------------------------------------------------------------------

// ProviderKind enumerates the backend types a provider profile can represent.
type ProviderKind string

const (
	ProviderKindSubscription        ProviderKind = "subscription"
	ProviderKindAnthropicCompatible ProviderKind = "anthropic-compatible"
	ProviderKindOpenAICompatible    ProviderKind = "openai-compatible"
	ProviderKindGrokCompatible      ProviderKind = "grok-compatible"
	ProviderKindCustom              ProviderKind = "custom"
)

// ModelSpec describes one model within a provider profile, tagged with tier
// and cost label for routing decisions.
type ModelSpec struct {
	ID        string `json:"id"`
	Tier      string `json:"tier"`       // smart | balanced | fast | free
	CostLabel string `json:"cost_label"` // paid | company | free | unknown
}

// ProviderProfile is a backend account/configuration plus a user-configured
// allowlist of agents that can use it.
type ProviderProfile struct {
	ID             string       `json:"id"`
	Name           string       `json:"name"`
	Kind           ProviderKind `json:"kind"`
	SupportsAgents []string     `json:"supports_agents"`
	Enabled        bool         `json:"enabled"`
	Models         []ModelSpec  `json:"models"`
}

// ProviderProfileList is a named collection of provider profiles for
// serialization.
type ProviderProfileList struct {
	Profiles []ProviderProfile `json:"profiles"`
}

// ---------------------------------------------------------------------------
// Team / profile
// ---------------------------------------------------------------------------

// PhasePolicy defines the routing policy for one phase within a team profile.
type PhasePolicy struct {
	Agent            string   `json:"agent"`
	Tier             string   `json:"tier"`              // smart | balanced | fast
	ProviderPriority []string `json:"provider_priority"` // ordered provider ids
	Fallback         []string `json:"fallback"`          // fallback strategy values
}

// TeamProfile is a reusable task dispatch preset.
type TeamProfile struct {
	ID               string                     `json:"id"`
	Name             string                     `json:"name"`
	Alias            string                     `json:"alias,omitempty"`
	DefaultObjective string                     `json:"default_objective,omitempty"`
	Enabled          bool                       `json:"enabled"`
	Phases           map[RoutePhase]PhasePolicy `json:"phases"`
}

// TeamProfileList is a named collection of team profiles for serialization.
type TeamProfileList struct {
	Profiles []TeamProfile `json:"profiles"`
}

// ---------------------------------------------------------------------------
// Routing defaults
// ---------------------------------------------------------------------------

// RoutingDefaults are the global settings applied when task creation omits
// explicit dispatch selection.
type RoutingDefaults struct {
	Enabled     bool   `json:"enabled"`
	DefaultTeam string `json:"default_team"`
	Objective   string `json:"objective"` // "balanced" | "cost-min" | "intelligent-max"
	// MaxAttemptsPerStep limits consecutive fallback attempts per phase.
	MaxAttemptsPerStep int `json:"max_attempts_per_step"`
	// TerminalLimitPolicy reuses the existing limit_policy concept.
	TerminalLimitPolicy string `json:"terminal_limit_policy"` // wait | ask | switch
	// ManualFallback allows manual dispatch to auto-fallback when set to true.
	ManualFallback bool `json:"manual_fallback"` // default false
}

// DefaultRoutingDefaults returns a sensible default configuration.
func DefaultRoutingDefaults() RoutingDefaults {
	return RoutingDefaults{
		Enabled:             false,
		DefaultTeam:         "",
		Objective:           string(ObjectiveBalanced),
		MaxAttemptsPerStep:  3,
		TerminalLimitPolicy: "ask",
		ManualFallback:      false,
	}
}

// ---------------------------------------------------------------------------
// Dispatch selection
// ---------------------------------------------------------------------------

// DispatchSelection is the user's intent encoded at task creation time.
type DispatchSelection struct {
	Mode      DispatchMode      `json:"mode"`
	Team      string            `json:"team,omitempty"`
	Objective DispatchObjective `json:"objective,omitempty"`
	Agent     string            `json:"agent,omitempty"`
	Provider  string            `json:"provider,omitempty"`
	Model     string            `json:"model,omitempty"`
}

// IsZero reports whether the selection is empty (no routing intent).
func (d DispatchSelection) IsZero() bool {
	return d.Mode == "" && d.Team == "" && d.Objective == "" &&
		d.Agent == "" && d.Provider == "" && d.Model == ""
}

// Validate checks that the dispatch selection is internally consistent.
func (d DispatchSelection) Validate() error {
	switch d.Mode {
	case DispatchAuto:
		if d.Team == "" {
			return fmt.Errorf("auto mode requires a team/profile")
		}
		if d.Objective != "" && !ValidDispatchObjective(d.Objective) {
			return fmt.Errorf("unknown objective %q", d.Objective)
		}
		if d.Agent != "" || d.Provider != "" || d.Model != "" {
			return fmt.Errorf("auto mode must not specify agent/provider/model directly")
		}
	case DispatchManual:
		if d.Agent == "" {
			return fmt.Errorf("manual mode requires an agent")
		}
		if d.Provider == "" {
			return fmt.Errorf("manual mode requires a provider")
		}
		if d.Model == "" {
			return fmt.Errorf("manual mode requires a model")
		}
		if d.Team != "" || d.Objective != "" {
			return fmt.Errorf("manual mode must not specify team/objective")
		}
	case "":
		// Empty dispatch is allowed (old clients).
	default:
		return fmt.Errorf("unknown dispatch mode %q", d.Mode)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Route decision event
// ---------------------------------------------------------------------------

// SkippedCandidate records a provider/model that was considered but skipped.
type SkippedCandidate struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
	Reason   string `json:"reason"`
}

// FallbackSource records the previous provider/model when a fallback occurred.
type FallbackSource struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
	Class    string `json:"class,omitempty"`
	Message  string `json:"message,omitempty"`
}

// RouteDecision is a task-visible audit record of one routing decision.
type RouteDecision struct {
	Type         string             `json:"type"` // "route_decision"
	Team         string             `json:"team,omitempty"`
	Objective    string             `json:"objective,omitempty"`
	Phase        RoutePhase         `json:"phase"`
	Agent        string             `json:"agent"`
	Provider     string             `json:"provider"`
	Model        string             `json:"model"`
	Tier         string             `json:"tier,omitempty"`
	Reason       string             `json:"reason"`
	FallbackFrom *FallbackSource    `json:"fallback_from,omitempty"`
	Skipped      []SkippedCandidate `json:"candidates_skipped,omitempty"`
}

// RouteDecisionType is the event type constant for route decisions.
const RouteDecisionType = "route_decision"

// RouteFallbackType is the event type constant for fallback events.
const RouteFallbackType = "route_fallback"

// ---------------------------------------------------------------------------
// Resolver types
// ---------------------------------------------------------------------------

// ResolveRequest is the input to a routing resolution.
type ResolveRequest struct {
	TaskID    string
	Team      string
	Objective string
	Phase     RoutePhase
	Agent     string
	Model     string
	Tier      string
	Prompt    string
}

// Decision is the output of a routing resolution.
type Decision struct {
	Agent    string
	Provider string
	Model    string
	Tier     string
	Reason   string
	Skipped  []SkippedCandidate
	// Team is the resolved team/profile id, carried for fallback.
	Team string
	// Phase is the phase this decision was resolved for, carried for fallback.
	Phase RoutePhase
	// Objective is the objective used for this decision, carried for fallback.
	Objective string
	// FailedProviders tracks providers that have been attempted and failed
	// during this fallback chain, so subsequent Next() calls skip them.
	FailedProviders []string
	// ExhaustedModels tracks individual (provider, model) pairs that have
	// already been tried in this fallback chain, so same-provider fallback
	// steps don't re-select models that already failed.
	ExhaustedModels []ExhaustedModel
}

// ExhaustedModel records a (provider, model) pair that has been attempted
// and should not be re-selected during fallback.
type ExhaustedModel struct {
	ProviderID string `json:"provider_id"`
	ModelID    string `json:"model_id"`
}

// FailureClass classifies a provider failure for fallback decisions.
type FailureClass string

const (
	FailureQuotaExhausted   FailureClass = "quota_exhausted"
	FailureAuthConfig       FailureClass = "auth_config"
	FailureTransient        FailureClass = "transient"
	FailureModelUnavailable FailureClass = "model_unavailable"
	FailureTaskError        FailureClass = "task_error"
)

// Failure describes a provider/model failure that triggered a fallback attempt.
type Failure struct {
	Class    FailureClass `json:"class"`
	Provider string       `json:"provider"`
	Model    string       `json:"model"`
	Message  string       `json:"message"`
	Attempt  int          `json:"attempt"`
}

// Resolver is the interface for selecting and falling back on provider/model
// candidates for a given phase agent.
type Resolver interface {
	// Resolve performs the first selection for a phase.
	Resolve(ctx context.Context, req ResolveRequest) (Decision, error)
	// Next performs a same-phase, same-agent fallback after a failure.
	Next(ctx context.Context, previous Decision, failure Failure) (Decision, bool)
}
