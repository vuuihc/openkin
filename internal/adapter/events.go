package adapter

import (
	"encoding/json"
	"strings"
)

// StartedPayload is the canonical task_started event body.
type StartedPayload struct {
	SessionRef string `json:"session_ref,omitempty"`
	Model      string `json:"model,omitempty"`
}

// UsagePayload is canonical token/cost accounting.
type UsagePayload struct {
	Model        string   `json:"model,omitempty"`
	TokensIn     int      `json:"tokens_in,omitempty"`
	TokensOut    int      `json:"tokens_out,omitempty"`
	CachedTokens int      `json:"cached_tokens,omitempty"`
	CostUSD      *float64 `json:"cost_usd,omitempty"`
}

// ResultPayload is the canonical result event body.
type ResultPayload struct {
	Text       string       `json:"text,omitempty"`
	IsError    bool         `json:"is_error"`
	SessionRef string       `json:"session_ref,omitempty"`
	Usage      UsagePayload `json:"usage,omitempty"`
}

// ParseStarted extracts a StartedPayload from canonical or legacy fields.
// Legacy: session_id, sessionId.
func ParseStarted(raw json.RawMessage) (StartedPayload, bool) {
	if len(raw) == 0 {
		return StartedPayload{}, false
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return StartedPayload{}, false
	}
	out := StartedPayload{
		SessionRef: firstString(m, "session_ref", "session_id", "sessionId"),
		Model:      firstString(m, "model"),
	}
	return out, true
}

// ParseResult extracts a ResultPayload from canonical or legacy fields.
// Legacy: session_id, result, total_cost_usd, top-level tokens_in/tokens_out/cost_usd.
func ParseResult(raw json.RawMessage) (ResultPayload, bool) {
	if len(raw) == 0 {
		return ResultPayload{}, false
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return ResultPayload{}, false
	}

	out := ResultPayload{
		SessionRef: firstString(m, "session_ref", "session_id", "sessionId"),
		IsError:    firstBool(m, "is_error"),
	}

	// Text: canonical text, else result string, else nested result.
	if t := firstString(m, "text"); t != "" {
		out.Text = t
	} else if t := firstString(m, "result"); t != "" {
		out.Text = t
	} else if nested, ok := m["result"].(map[string]any); ok {
		out.Text = firstString(nested, "text", "content", "result")
	}

	// Usage: nested usage preferred, then top-level legacy fields.
	usage := UsagePayload{}
	if u, ok := m["usage"].(map[string]any); ok {
		usage.Model = firstString(u, "model")
		usage.TokensIn = firstInt(u, "tokens_in", "input_tokens", "prompt_tokens")
		usage.TokensOut = firstInt(u, "tokens_out", "output_tokens", "completion_tokens")
		usage.CachedTokens = firstInt(u, "cached_tokens", "cache_read_input_tokens")
		usage.CostUSD = firstFloatPtr(u, "cost_usd", "total_cost_usd")
	}
	if usage.TokensIn == 0 {
		usage.TokensIn = firstInt(m, "tokens_in", "input_tokens")
	}
	if usage.TokensOut == 0 {
		usage.TokensOut = firstInt(m, "tokens_out", "output_tokens")
	}
	if usage.CachedTokens == 0 {
		usage.CachedTokens = firstInt(m, "cached_tokens")
	}
	if usage.CostUSD == nil {
		usage.CostUSD = firstFloatPtr(m, "cost_usd", "total_cost_usd")
	}
	if usage.Model == "" {
		usage.Model = firstString(m, "model")
	}
	out.Usage = usage
	return out, true
}

// SessionRefFromEvent returns a session id from started or result payloads.
func SessionRefFromEvent(raw json.RawMessage) string {
	if s, ok := ParseStarted(raw); ok && s.SessionRef != "" {
		return s.SessionRef
	}
	if r, ok := ParseResult(raw); ok {
		return r.SessionRef
	}
	return ""
}

func firstString(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k]; ok {
			switch t := v.(type) {
			case string:
				if s := strings.TrimSpace(t); s != "" {
					return s
				}
			}
		}
	}
	return ""
}

func firstBool(m map[string]any, keys ...string) bool {
	for _, k := range keys {
		if v, ok := m[k].(bool); ok {
			return v
		}
	}
	return false
}

func firstInt(m map[string]any, keys ...string) int {
	for _, k := range keys {
		switch v := m[k].(type) {
		case float64:
			return int(v)
		case int:
			return v
		case json.Number:
			n, _ := v.Int64()
			return int(n)
		}
	}
	return 0
}

func firstFloatPtr(m map[string]any, keys ...string) *float64 {
	for _, k := range keys {
		switch v := m[k].(type) {
		case float64:
			f := v
			return &f
		case json.Number:
			f, err := v.Float64()
			if err == nil {
				return &f
			}
		}
	}
	return nil
}
