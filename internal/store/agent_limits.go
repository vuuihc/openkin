package store

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"
)

// KeyAgentLimits is the settings key for per-agent daily usage limits.
const KeyAgentLimits = "agent_limits"

// AgentLimit defines the optional daily spend and/or token caps for one agent.
// Nil fields mean unlimited for that metric.
type AgentLimit struct {
	SpendUSDDaily *float64 `json:"spend_usd_daily,omitempty"`
	TokensDaily   *int64   `json:"tokens_daily,omitempty"`
}

// validateAgentLimit returns an error if any configured values are negative.
func (al AgentLimit) validate(agent string) error {
	if al.SpendUSDDaily != nil && *al.SpendUSDDaily < 0 {
		return fmt.Errorf("agent_limits[%q]: spend_usd_daily must be >= 0", agent)
	}
	if al.TokensDaily != nil && *al.TokensDaily < 0 {
		return fmt.Errorf("agent_limits[%q]: tokens_daily must be >= 0", agent)
	}
	return nil
}

// ParseAgentLimits parses and validates raw JSON agent-limits text.
// Used by the API layer to validate PUT /api/settings before persisting.
func ParseAgentLimits(raw string) (map[string]AgentLimit, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" || raw == "{}" {
		return map[string]AgentLimit{}, nil
	}
	var limits map[string]AgentLimit
	if err := json.Unmarshal([]byte(raw), &limits); err != nil {
		return nil, fmt.Errorf("invalid agent_limits JSON: %w", err)
	}
	for agent, limit := range limits {
		if err := limit.validate(agent); err != nil {
			return nil, err
		}
	}
	return limits, nil
}

// GetAgentLimits reads the agent_limits settings key. Returns an empty map
// (not an error) when the key is absent or empty.
func (s *Store) GetAgentLimits(ctx context.Context) (map[string]AgentLimit, error) {
	raw, err := s.GetSetting(ctx, KeyAgentLimits)
	if err != nil || strings.TrimSpace(raw) == "" {
		// Absent key is valid — no limits configured.
		return map[string]AgentLimit{}, nil
	}
	var limits map[string]AgentLimit
	if err := json.Unmarshal([]byte(raw), &limits); err != nil {
		return nil, fmt.Errorf("parse agent_limits: %w", err)
	}
	for agent, limit := range limits {
		if err := limit.validate(agent); err != nil {
			return nil, err
		}
	}
	if limits == nil {
		limits = map[string]AgentLimit{}
	}
	return limits, nil
}

// SetAgentLimits validates and persists the agent_limits settings key.
func (s *Store) SetAgentLimits(ctx context.Context, limits map[string]AgentLimit) error {
	for agent, limit := range limits {
		if err := limit.validate(agent); err != nil {
			return err
		}
	}
	b, err := json.Marshal(limits)
	if err != nil {
		return fmt.Errorf("marshal agent_limits: %w", err)
	}
	return s.SetSetting(ctx, KeyAgentLimits, string(b))
}

// AgentLimitStatus is the per-agent progress row returned by AgentLimitStatuses.
type AgentLimitStatus struct {
	Agent        string   `json:"agent"`
	LimitSpendUSD *float64 `json:"limit_spend_usd,omitempty"`
	UsedSpendUSD float64  `json:"used_spend_usd"`
	LimitTokens  *int64   `json:"limit_tokens,omitempty"`
	UsedTokens   int64    `json:"used_tokens"`
	Status       string   `json:"status"` // ok | warn | over
	PeriodStart  string   `json:"period_start"` // RFC3339, start of today (local)
}

// AgentLimitStatuses aggregates today's usage_records (natural day, server-local
// timezone) by agent and joins against configured limits. It includes every
// agent that either has a configured limit or has usage today.
// Rows are sorted by agent for deterministic output.
func (s *Store) AgentLimitStatuses(ctx context.Context) ([]AgentLimitStatus, error) {
	now := time.Now()
	startOfDay := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.Local)
	startMS := startOfDay.UnixMilli()

	// Aggregate today's usage grouped by agent.
	rows, err := s.db.QueryContext(ctx, `
		SELECT agent,
		       COALESCE(SUM(CASE WHEN cost_usd IS NOT NULL THEN cost_usd ELSE 0 END), 0),
		       COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0)
		FROM usage_records
		WHERE occurred_at >= ?
		GROUP BY agent`, startMS)
	if err != nil {
		return nil, fmt.Errorf("aggregate daily usage: %w", err)
	}
	defer rows.Close()

	type usageTotals struct {
		spendUSD float64
		tokens   int64
	}
	todayUsage := map[string]usageTotals{}
	for rows.Next() {
		var agent string
		var spend float64
		var tokens int64
		if err := rows.Scan(&agent, &spend, &tokens); err != nil {
			return nil, fmt.Errorf("scan daily usage: %w", err)
		}
		todayUsage[agent] = usageTotals{spendUSD: spend, tokens: tokens}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Load configured limits.
	limits, err := s.GetAgentLimits(ctx)
	if err != nil {
		return nil, err
	}

	// Union of agents that have a limit or have usage today.
	agentSet := map[string]struct{}{}
	for agent := range limits {
		agentSet[agent] = struct{}{}
	}
	for agent := range todayUsage {
		agentSet[agent] = struct{}{}
	}

	periodStart := startOfDay.UTC().Format(time.RFC3339)

	result := make([]AgentLimitStatus, 0, len(agentSet))
	for agent := range agentSet {
		usage := todayUsage[agent]
		limit := limits[agent]

		st := AgentLimitStatus{
			Agent:        agent,
			UsedSpendUSD: usage.spendUSD,
			UsedTokens:   usage.tokens,
			PeriodStart:  periodStart,
		}
		if limit.SpendUSDDaily != nil {
			v := *limit.SpendUSDDaily
			st.LimitSpendUSD = &v
		}
		if limit.TokensDaily != nil {
			v := *limit.TokensDaily
			st.LimitTokens = &v
		}

		st.Status = computeAgentStatus(limit, usage.spendUSD, usage.tokens)
		result = append(result, st)
	}

	sort.Slice(result, func(i, j int) bool { return result[i].Agent < result[j].Agent })
	return result, nil
}

// computeAgentStatus returns "ok", "warn", or "over" based on how close the agent
// is to its configured limits. Unconfigured metrics do not contribute to severity.
func computeAgentStatus(limit AgentLimit, usedSpend float64, usedTokens int64) string {
	status := "ok"
	if limit.SpendUSDDaily != nil && *limit.SpendUSDDaily > 0 {
		ratio := usedSpend / *limit.SpendUSDDaily
		if ratio >= 1.0 {
			return "over"
		}
		if ratio >= 0.8 && status == "ok" {
			status = "warn"
		}
	}
	if limit.TokensDaily != nil && *limit.TokensDaily > 0 {
		ratio := float64(usedTokens) / float64(*limit.TokensDaily)
		if ratio >= 1.0 {
			return "over"
		}
		if ratio >= 0.8 && status == "ok" {
			status = "warn"
		}
	}
	return status
}
