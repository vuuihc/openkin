package store

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// KeyAgentSmoke is the settings key for per-agent headless smoke results.
const KeyAgentSmoke = "agent_smoke"

// AgentSmokeResult is one agent’s last smoke probe outcome (local only).
type AgentSmokeResult struct {
	OK        bool   `json:"ok"`
	Binary    string `json:"binary,omitempty"`
	CheckedAt int64  `json:"checked_at"` // unix seconds
	Detail    string `json:"detail,omitempty"`
}

// GetAgentSmokeMap reads all stored smoke results. Missing key → empty map.
func (s *Store) GetAgentSmokeMap(ctx context.Context) (map[string]AgentSmokeResult, error) {
	raw, err := s.GetSetting(ctx, KeyAgentSmoke)
	if errors.Is(err, ErrNotFound) || strings.TrimSpace(raw) == "" {
		return map[string]AgentSmokeResult{}, nil
	}
	if err != nil {
		return nil, err
	}
	var m map[string]AgentSmokeResult
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		return nil, err
	}
	if m == nil {
		m = map[string]AgentSmokeResult{}
	}
	return m, nil
}

// GetAgentSmoke returns one agent result. ok=false means no row stored.
func (s *Store) GetAgentSmoke(ctx context.Context, agentID string) (AgentSmokeResult, bool, error) {
	agentID = strings.TrimSpace(agentID)
	if agentID == "" {
		return AgentSmokeResult{}, false, nil
	}
	m, err := s.GetAgentSmokeMap(ctx)
	if err != nil {
		return AgentSmokeResult{}, false, err
	}
	r, ok := m[agentID]
	return r, ok, nil
}

// SetAgentSmoke upserts one agent smoke result.
func (s *Store) SetAgentSmoke(ctx context.Context, agentID string, result AgentSmokeResult) error {
	agentID = strings.TrimSpace(agentID)
	if agentID == "" {
		return errors.New("agent id required")
	}
	if result.CheckedAt == 0 {
		result.CheckedAt = time.Now().Unix()
	}
	m, err := s.GetAgentSmokeMap(ctx)
	if err != nil {
		return err
	}
	m[agentID] = result
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	return s.SetSetting(ctx, KeyAgentSmoke, string(b))
}
