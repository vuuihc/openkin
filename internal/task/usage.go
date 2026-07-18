package task

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/vuuihc/kin/internal/store"
)

// usagePayload is the additive canonical shape emitted by adapters. The
// aliases keep the normalizer compatible with Kin/provider and older result
// payloads while provider-specific parsing stays at the adapter boundary.
type usagePayload struct {
	Source                string   `json:"source"`
	Agent                 string   `json:"agent"`
	Model                 string   `json:"model"`
	InputTokens           *int     `json:"input_tokens"`
	PromptTokens          *int     `json:"prompt_tokens"`
	TokensIn              *int     `json:"tokens_in"`
	OutputTokens          *int     `json:"output_tokens"`
	CompletionTokens      *int     `json:"completion_tokens"`
	TokensOut             *int     `json:"tokens_out"`
	ReasoningOutputTokens *int     `json:"reasoning_output_tokens"`
	CacheReadTokens       *int     `json:"cache_read_tokens"`
	CachedTokens          *int     `json:"cached_tokens"`
	CacheWriteTokens      *int     `json:"cache_write_tokens"`
	CacheReadReported     *bool    `json:"cache_read_reported"`
	CacheStatus           string   `json:"cache_status"`
	InputSemantics        string   `json:"input_semantics"`
	CostUSD               *float64 `json:"cost_usd"`
	CostSource            string   `json:"cost_source"`
}

// NormalizeUsage converts a canonical adapter usage payload into the stable
// store shape. Task id, event sequence, and occurrence time are filled by the
// transactional event append path.
func NormalizeUsage(defaultAgent, defaultModel string, raw json.RawMessage) (store.UsageRecord, error) {
	var payload usagePayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return store.UsageRecord{}, fmt.Errorf("decode usage: %w", err)
	}

	record := store.UsageRecord{
		Agent:                 firstUsageString(payload.Agent, defaultAgent),
		InputTokens:           firstUsageInt(payload.InputTokens, payload.PromptTokens, payload.TokensIn),
		OutputTokens:          firstUsageInt(payload.OutputTokens, payload.CompletionTokens, payload.TokensOut),
		ReasoningOutputTokens: payload.ReasoningOutputTokens,
		CacheWriteTokens:      payload.CacheWriteTokens,
		CostUSD:               payload.CostUSD,
		CostSource:            payload.CostSource,
		CacheStatus:           payload.CacheStatus,
		InputSemantics:        payload.InputSemantics,
	}
	if source := strings.TrimSpace(payload.Source); source != "" {
		record.Provider = &source
	}
	if model := firstUsageString(payload.Model, defaultModel); model != "" {
		record.Model = &model
	}

	cacheReported := payload.CacheReadReported != nil && *payload.CacheReadReported
	if cacheReported {
		record.CacheReadTokens = firstUsageInt(payload.CacheReadTokens, payload.CachedTokens)
		if record.CacheReadTokens == nil {
			zero := 0
			record.CacheReadTokens = &zero
		}
	} else if payload.CacheReadTokens != nil {
		// Adapter-native payloads written before cache_read_reported was added can
		// still establish presence by including the normalized field itself.
		record.CacheReadTokens = payload.CacheReadTokens
		cacheReported = true
	}

	if record.CacheStatus == "" {
		if cacheReported || record.CacheWriteTokens != nil {
			record.CacheStatus = store.CacheStatusReported
		} else {
			record.CacheStatus = store.CacheStatusUnknown
		}
	}
	if record.InputSemantics == "" {
		switch strings.TrimSpace(payload.Source) {
		case "codex", "kin":
			record.InputSemantics = store.InputSemanticsTotalIncludesCache
		case "claude-code":
			record.InputSemantics = store.InputSemanticsUncachedOnly
		default:
			record.InputSemantics = store.InputSemanticsUnknown
		}
	}
	if record.CostSource == "" {
		if record.CostUSD != nil {
			record.CostSource = store.CostSourceProvider
		} else {
			record.CostSource = store.CostSourceUnknown
		}
	}

	if record.Agent == "" {
		return store.UsageRecord{}, fmt.Errorf("usage agent is required")
	}
	if record.InputTokens == nil && record.OutputTokens == nil && record.CacheReadTokens == nil && record.CacheWriteTokens == nil && record.CostUSD == nil {
		return store.UsageRecord{}, fmt.Errorf("usage payload contains no accounting values")
	}
	for name, value := range map[string]*int{
		"input_tokens":            record.InputTokens,
		"output_tokens":           record.OutputTokens,
		"reasoning_output_tokens": record.ReasoningOutputTokens,
		"cache_read_tokens":       record.CacheReadTokens,
		"cache_write_tokens":      record.CacheWriteTokens,
	} {
		if value != nil && *value < 0 {
			return store.UsageRecord{}, fmt.Errorf("usage %s must be >= 0", name)
		}
	}
	if record.CostUSD != nil && *record.CostUSD < 0 {
		return store.UsageRecord{}, fmt.Errorf("usage cost_usd must be >= 0")
	}
	if !usageValueIn(record.CacheStatus, store.CacheStatusReported, store.CacheStatusUnknown, store.CacheStatusUnsupported) {
		return store.UsageRecord{}, fmt.Errorf("invalid usage cache_status %q", record.CacheStatus)
	}
	if !usageValueIn(record.InputSemantics, store.InputSemanticsTotalIncludesCache, store.InputSemanticsUncachedOnly, store.InputSemanticsUnknown) {
		return store.UsageRecord{}, fmt.Errorf("invalid usage input_semantics %q", record.InputSemantics)
	}
	return record, nil
}

// UsageLogicalInput returns a comparable logical input total and whether the
// record is eligible for a cache-hit-rate denominator.
func UsageLogicalInput(record store.UsageRecord) (logical int64, eligible bool) {
	input := usageInt64(record.InputTokens)
	switch record.InputSemantics {
	case store.InputSemanticsTotalIncludesCache:
		logical = input
	case store.InputSemanticsUncachedOnly:
		logical = input + usageInt64(record.CacheReadTokens) + usageInt64(record.CacheWriteTokens)
	default:
		logical = input
	}
	eligible = record.CacheStatus == store.CacheStatusReported &&
		record.CacheReadTokens != nil &&
		record.InputSemantics != store.InputSemanticsUnknown &&
		logical > 0
	return logical, eligible
}

func firstUsageString(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}

func firstUsageInt(values ...*int) *int {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

func usageInt64(value *int) int64 {
	if value == nil {
		return 0
	}
	return int64(*value)
}

func usageValueIn(value string, values ...string) bool {
	for _, candidate := range values {
		if value == candidate {
			return true
		}
	}
	return false
}
