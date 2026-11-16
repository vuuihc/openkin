package adapter

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
)

// StartedPayload is the canonical task_started event body.
type StartedPayload struct {
	SessionRef string `json:"session_ref,omitempty"`
	Model      string `json:"model,omitempty"`
}

// UsagePayload is the compact usage view retained for ParseResult callers.
type UsagePayload struct {
	Model        string   `json:"model,omitempty"`
	TokensIn     int      `json:"tokens_in,omitempty"`
	TokensOut    int      `json:"tokens_out,omitempty"`
	CachedTokens int      `json:"cached_tokens,omitempty"`
	CostUSD      *float64 `json:"cost_usd,omitempty"`
}

// UsageSemantics is the normalized accounting view for usage and legacy
// result events. Pointer fields preserve the distinction between zero and an
// omitted value.
type UsageSemantics struct {
	Source                string
	Agent                 string
	Model                 string
	ProviderID            string
	InputTokens           *int
	OutputTokens          *int
	ReasoningOutputTokens *int
	CacheReadTokens       *int
	CachedTokens          *int
	CacheWriteTokens      *int
	CacheReadReported     *bool
	CacheStatus           string
	InputSemantics        string
	CostUSD               *float64
	CostSource            string
}

// HasAccountingValues reports whether the payload contains any billable usage
// measurement. Zero-valued pointers still count as explicitly reported values.
func (u UsageSemantics) HasAccountingValues() bool {
	return u.InputTokens != nil ||
		u.OutputTokens != nil ||
		u.ReasoningOutputTokens != nil ||
		u.CacheReadTokens != nil ||
		(u.CacheReadReported != nil && *u.CacheReadReported && u.CachedTokens != nil) ||
		u.CacheWriteTokens != nil ||
		u.CostUSD != nil
}

// ResultPayload is the canonical result event body.
type ResultPayload struct {
	Text       string       `json:"text,omitempty"`
	IsError    bool         `json:"is_error"`
	SessionRef string       `json:"session_ref,omitempty"`
	Usage      UsagePayload `json:"usage,omitempty"`
}

// MessagePayload is the semantic view of a message event.
type MessagePayload struct {
	Role    string
	Text    string
	Partial bool
}

// Visibility is the normalized audience metadata attached to an event.
type Visibility struct {
	User bool
	Task bool
}

// ErrorPayload is the semantic error view shared by error events and failed
// result events.
type ErrorPayload struct {
	Message  string
	Kind     string
	Canceled bool
}

// SemanticEvent is a typed interpretation of Event.Payload. Raw Event payloads
// remain the archival and wire representation; this view is decoded on read.
type SemanticEvent struct {
	Type       string
	SessionRef string
	Model      string
	Message    *MessagePayload
	Result     *ResultPayload
	Usage      *UsageSemantics
	Visibility *Visibility
	Error      *ErrorPayload
}

type eventWire struct {
	SessionRef string          `json:"session_ref"`
	SessionID  string          `json:"session_id"`
	SessionID2 string          `json:"sessionId"`
	Model      string          `json:"model"`
	Role       string          `json:"role"`
	Content    json.RawMessage `json:"content"`
	Text       string          `json:"text"`
	Partial    bool            `json:"partial"`
	IsError    *bool           `json:"is_error"`
	Result     json.RawMessage `json:"result"`
	Message    json.RawMessage `json:"message"`
	Error      json.RawMessage `json:"error"`
	Kind       string          `json:"kind"`
	Visibility *struct {
		User *bool `json:"user"`
		Task *bool `json:"task"`
	} `json:"visibility"`
	Usage json.RawMessage `json:"usage"`

	Source                string   `json:"source"`
	Agent                 string   `json:"agent"`
	ProviderID            string   `json:"provider_id"`
	InputTokens           *int     `json:"input_tokens"`
	PromptTokens          *int     `json:"prompt_tokens"`
	TokensIn              *int     `json:"tokens_in"`
	OutputTokens          *int     `json:"output_tokens"`
	CompletionTokens      *int     `json:"completion_tokens"`
	TokensOut             *int     `json:"tokens_out"`
	ReasoningOutputTokens *int     `json:"reasoning_output_tokens"`
	CacheReadTokens       *int     `json:"cache_read_tokens"`
	CacheReadInputTokens  *int     `json:"cache_read_input_tokens"`
	CachedInputTokens     *int     `json:"cached_input_tokens"`
	CachedTokens          *int     `json:"cached_tokens"`
	CacheWriteTokens      *int     `json:"cache_write_tokens"`
	CacheCreationTokens   *int     `json:"cache_creation_input_tokens"`
	CacheReadReported     *bool    `json:"cache_read_reported"`
	CacheStatus           string   `json:"cache_status"`
	InputSemantics        string   `json:"input_semantics"`
	CostUSD               *float64 `json:"cost_usd"`
	TotalCostUSD          *float64 `json:"total_cost_usd"`
	CostSource            string   `json:"cost_source"`
}

// DecodeEvent normalizes canonical and historical adapter payload shapes
// without changing the raw event that is persisted.
func DecodeEvent(ev Event) (SemanticEvent, error) {
	wire, err := decodeEventWire(ev.Payload)
	if err != nil {
		return SemanticEvent{}, err
	}
	out := SemanticEvent{
		Type:       ev.Type,
		SessionRef: firstSemanticString(wire.SessionRef, wire.SessionID, wire.SessionID2),
		Model:      strings.TrimSpace(wire.Model),
		Visibility: decodeVisibility(wire),
	}

	switch ev.Type {
	case "message":
		out.Message = &MessagePayload{
			Role:    strings.TrimSpace(wire.Role),
			Text:    decodeMessageText(wire),
			Partial: wire.Partial,
		}
	case "task_started":
		// SessionRef and Model on the semantic envelope are sufficient.
	case "usage":
		usage, err := normalizeUsage(wire)
		if err != nil {
			return SemanticEvent{}, err
		}
		out.Usage = &usage
	case "result":
		if wire.IsError == nil {
			return SemanticEvent{}, fmt.Errorf("decode adapter result: is_error is required")
		}
		result, usage, err := normalizeResult(wire)
		if err != nil {
			return SemanticEvent{}, err
		}
		out.Result = &result
		out.SessionRef = firstSemanticString(out.SessionRef, result.SessionRef)
		out.Usage = &usage
		if result.IsError {
			out.Error = normalizeError(wire, result.Text)
		}
	case "error":
		out.Error = normalizeError(wire, "")
	}
	return out, nil
}

// DecodeUsage normalizes usage aliases from a usage or legacy result payload.
func DecodeUsage(raw json.RawMessage) (UsageSemantics, error) {
	wire, err := decodeEventWire(raw)
	if err != nil {
		return UsageSemantics{}, err
	}
	return normalizeUsage(wire)
}

// ParseStarted extracts a StartedPayload from canonical or legacy fields.
// Legacy: session_id, sessionId.
func ParseStarted(raw json.RawMessage) (StartedPayload, bool) {
	semantic, err := DecodeEvent(Event{Type: "task_started", Payload: raw})
	if err != nil {
		return StartedPayload{}, false
	}
	return StartedPayload{SessionRef: semantic.SessionRef, Model: semantic.Model}, true
}

// ParseResult extracts a ResultPayload from canonical or legacy fields.
// Legacy: session_id, result, total_cost_usd, top-level tokens_in/tokens_out/cost_usd.
func ParseResult(raw json.RawMessage) (ResultPayload, bool) {
	semantic, err := DecodeEvent(Event{Type: "result", Payload: raw})
	if err != nil || semantic.Result == nil {
		return ResultPayload{}, false
	}
	return *semantic.Result, true
}

// SessionRefFromEvent returns a session id from started or result payloads.
func SessionRefFromEvent(raw json.RawMessage) string {
	wire, err := decodeEventWire(raw)
	if err != nil {
		return ""
	}
	return firstSemanticString(wire.SessionRef, wire.SessionID, wire.SessionID2)
}

func decodeEventWire(raw json.RawMessage) (eventWire, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return eventWire{}, fmt.Errorf("decode adapter event: empty payload")
	}
	var wire eventWire
	if err := json.Unmarshal(raw, &wire); err != nil {
		return eventWire{}, fmt.Errorf("decode adapter event: %w", err)
	}
	return wire, nil
}

func normalizeResult(wire eventWire) (ResultPayload, UsageSemantics, error) {
	text := strings.TrimSpace(wire.Text)
	if text == "" {
		text = decodeTextValue(wire.Result)
	}
	isError := wire.IsError != nil && *wire.IsError
	if text == "" && isError {
		text = decodeTextValue(wire.Message)
	}
	usage, err := normalizeUsage(wire)
	if err != nil {
		return ResultPayload{}, UsageSemantics{}, err
	}
	return ResultPayload{
		Text:       text,
		IsError:    isError,
		SessionRef: firstSemanticString(wire.SessionRef, wire.SessionID, wire.SessionID2),
		Usage: UsagePayload{
			Model:        usage.Model,
			TokensIn:     valueOrZero(usage.InputTokens),
			TokensOut:    valueOrZero(usage.OutputTokens),
			CachedTokens: valueOrZero(firstIntPtr(usage.CacheReadTokens, usage.CachedTokens)),
			CostUSD:      usage.CostUSD,
		},
	}, usage, nil
}

func normalizeUsage(wire eventWire) (UsageSemantics, error) {
	var nested eventWire
	if len(wire.Usage) > 0 && string(wire.Usage) != "null" {
		if err := json.Unmarshal(wire.Usage, &nested); err != nil {
			return UsageSemantics{}, fmt.Errorf("decode nested usage: %w", err)
		}
	}
	return UsageSemantics{
		Source:                firstSemanticString(nested.Source, wire.Source),
		Agent:                 firstSemanticString(nested.Agent, wire.Agent),
		Model:                 firstSemanticString(nested.Model, wire.Model),
		ProviderID:            firstSemanticString(nested.ProviderID, wire.ProviderID),
		InputTokens:           firstIntPtr(nested.InputTokens, nested.PromptTokens, nested.TokensIn, wire.InputTokens, wire.PromptTokens, wire.TokensIn),
		OutputTokens:          firstIntPtr(nested.OutputTokens, nested.CompletionTokens, nested.TokensOut, wire.OutputTokens, wire.CompletionTokens, wire.TokensOut),
		ReasoningOutputTokens: firstIntPtr(nested.ReasoningOutputTokens, wire.ReasoningOutputTokens),
		CacheReadTokens:       firstIntPtr(nested.CacheReadTokens, nested.CacheReadInputTokens, nested.CachedInputTokens, wire.CacheReadTokens, wire.CacheReadInputTokens, wire.CachedInputTokens),
		CachedTokens:          firstIntPtr(nested.CachedTokens, wire.CachedTokens),
		CacheWriteTokens:      firstIntPtr(nested.CacheWriteTokens, nested.CacheCreationTokens, wire.CacheWriteTokens, wire.CacheCreationTokens),
		CacheReadReported:     firstBoolPtr(nested.CacheReadReported, wire.CacheReadReported),
		CacheStatus:           firstSemanticString(nested.CacheStatus, wire.CacheStatus),
		InputSemantics:        firstSemanticString(nested.InputSemantics, wire.InputSemantics),
		CostUSD:               firstFloatPtr(nested.CostUSD, nested.TotalCostUSD, wire.CostUSD, wire.TotalCostUSD),
		CostSource:            firstSemanticString(nested.CostSource, wire.CostSource),
	}, nil
}

func normalizeError(wire eventWire, fallback string) *ErrorPayload {
	message := firstSemanticString(
		decodeTextValue(wire.Message),
		decodeTextValue(wire.Error),
		decodeTextValue(wire.Result),
		fallback,
	)
	return &ErrorPayload{
		Message:  message,
		Kind:     strings.TrimSpace(wire.Kind),
		Canceled: IsCancellationMessage(message),
	}
}

func decodeVisibility(wire eventWire) *Visibility {
	if wire.Visibility == nil || (wire.Visibility.User == nil && wire.Visibility.Task == nil) {
		return nil
	}
	out := &Visibility{}
	if wire.Visibility.User != nil {
		out.User = *wire.Visibility.User
	}
	if wire.Visibility.Task != nil {
		out.Task = *wire.Visibility.Task
	}
	return out
}

func decodeMessageText(wire eventWire) string {
	if text := decodeTextValue(wire.Content); text != "" {
		return text
	}
	return strings.TrimSpace(wire.Text)
}

func decodeTextValue(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return strings.TrimSpace(text)
	}
	var object struct {
		Text    string          `json:"text"`
		Content json.RawMessage `json:"content"`
		Result  json.RawMessage `json:"result"`
		Message json.RawMessage `json:"message"`
	}
	if json.Unmarshal(raw, &object) == nil {
		return firstSemanticString(
			object.Text,
			decodeTextValue(object.Content),
			decodeTextValue(object.Result),
			decodeTextValue(object.Message),
		)
	}
	var blocks []struct {
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &blocks) == nil {
		var out strings.Builder
		for _, block := range blocks {
			out.WriteString(block.Text)
		}
		return strings.TrimSpace(out.String())
	}
	return ""
}

// IsCancellationMessage identifies benign adapter abort/cancel errors.
func IsCancellationMessage(message string) bool {
	s := strings.ToLower(strings.TrimSpace(message))
	switch {
	case s == "canceled", s == "cancelled", s == "context canceled", s == "context cancelled":
		return true
	case strings.Contains(s, "stream error") && strings.Contains(s, "cancel"):
		return true
	case strings.Contains(s, "cancel") && strings.Contains(s, "received from peer"):
		return true
	default:
		return false
	}
}

func firstSemanticString(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}

func firstIntPtr(values ...*int) *int {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

func firstBoolPtr(values ...*bool) *bool {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

func firstFloatPtr(values ...*float64) *float64 {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

func valueOrZero(value *int) int {
	if value == nil {
		return 0
	}
	return *value
}
