// Package provider is Kin's cognition layer: pluggable LLM backends.
// Distinct from agent adapters (CLI executors). "kin" agent uses a Provider.
package provider

import (
	"context"
	"fmt"
	"os"
	"strings"
)

// Role for chat messages.
const (
	RoleSystem    = "system"
	RoleUser      = "user"
	RoleAssistant = "assistant"
)

// Message is one chat turn (optionally with tool calls / tool results).
type Message struct {
	Role       string     `json:"role"`
	Content    string     `json:"content,omitempty"`
	Name       string     `json:"name,omitempty"` // tool name when role=tool (some providers)
	ToolCallID string     `json:"tool_call_id,omitempty"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
}

// ChatRequest is a chat completion request.
// Streaming is a transport concern controlled by Config.Stream (or Stream override);
// Chat still returns the fully aggregated assistant turn.
type ChatRequest struct {
	Model       string
	Messages    []Message
	Tools       []ToolDef
	ToolChoice  string // "auto" | "none" | ""
	Temperature *float64
	MaxTokens   *int
	// Stream overrides Config.Stream when non-nil. nil = use provider config.
	Stream *bool
	// OnContentDelta receives each non-empty assistant text fragment while the
	// transport is streaming. It is never called for non-stream Chat calls.
	// Callers must treat fragments as deltas (append), not full snapshots.
	// The callback runs on the Chat caller's goroutine; keep it cheap.
	OnContentDelta func(delta string)
}

// Usage token counts (provider-reported).
type Usage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
	// CachedTokens is prompt-cache hits when the provider reports them
	// (OpenAI prompt_tokens_details.cached_tokens, Anthropic cache_read, etc.).
	CachedTokens int `json:"cached_tokens,omitempty"`
	// CacheReadReported distinguishes a reported zero from a provider that did
	// not include cache usage in its response.
	CacheReadReported bool `json:"cache_read_reported"`
}

// ChatResponse is a completed assistant turn (may include tool_calls).
type ChatResponse struct {
	Content string
	Model   string
	Usage   Usage
	// FinishReason e.g. stop / length / tool_calls
	FinishReason string
	ToolCalls    []ToolCall
}

// Client talks to one configured backend.
type Client interface {
	// Chat runs a chat completion and returns the fully aggregated assistant turn.
	// When the provider is configured with Stream=true (or req.Stream forces it),
	// the transport may use SSE under the hood; callers still see one ChatResponse.
	Chat(ctx context.Context, req ChatRequest) (*ChatResponse, error)
	// Kind returns the provider kind (e.g. "openai-compatible").
	Kind() string
	// ModelDefault returns the configured default model id.
	ModelDefault() string
}

// Config is persisted provider settings (OpenAI-compatible first).
type Config struct {
	// Kind: "openai-compatible" (default). Future: anthropic, xai, ollama.
	Kind string `json:"kind"`
	// BaseURL e.g. https://api.openai.com/v1 or http://127.0.0.1:8317/v1 (cliproxyapi).
	BaseURL string `json:"base_url"`
	// APIKey optional for local proxies.
	APIKey string `json:"api_key"`
	// Model default chat model id.
	Model string `json:"model"`
	// Stream requests SSE token streaming from the provider and aggregates the
	// result before returning from Chat. Helps with gateway idle timeouts and
	// future partial-progress UX; agent tool loops still wait for a full turn.
	Stream bool `json:"stream,omitempty"`
}

// Settings keys in store.
const (
	KeyKind    = "provider.kind"
	KeyBaseURL = "provider.base_url"
	KeyAPIKey  = "provider.api_key"
	KeyModel   = "provider.model"
	// KeyStream is "true" / "false" (or empty = false) on the legacy single-slot mirror.
	KeyStream = "provider.stream"
)

// Normalize fills defaults and trims.
// For openai-compatible hosts that omit the API root, appends "/v1"
// (e.g. https://aipool.example.com → https://aipool.example.com/v1).
func (c Config) Normalize() Config {
	c.Kind = strings.TrimSpace(c.Kind)
	if c.Kind == "" {
		c.Kind = "openai-compatible"
	}
	c.BaseURL = strings.TrimRight(strings.TrimSpace(c.BaseURL), "/")
	c.APIKey = strings.TrimSpace(c.APIKey)
	c.Model = strings.TrimSpace(c.Model)
	if c.Kind == "openai-compatible" {
		c.BaseURL = ensureOpenAIRoot(c.BaseURL)
	}
	return c
}

// ensureOpenAIRoot makes sure we hit …/v1 before /chat/completions.
// Leaves URLs that already contain a /v1 path segment unchanged.
func ensureOpenAIRoot(base string) string {
	if base == "" {
		return base
	}
	lower := strings.ToLower(base)
	// Already has /v1 as final segment or deeper (…/v1, …/v1/…, …/openai/v1).
	if strings.HasSuffix(lower, "/v1") || strings.Contains(lower, "/v1/") {
		return base
	}
	// Host-only or custom root without version → OpenAI-compatible default.
	return base + "/v1"
}

// Configured reports whether enough is set to attempt calls.
// Local proxies may omit API key; require base_url + model.
func (c Config) Configured() bool {
	c = c.Normalize()
	return c.BaseURL != "" && c.Model != ""
}

// Validate checks config shape (not live connectivity).
func (c Config) Validate() error {
	c = c.Normalize()
	if c.BaseURL == "" {
		return fmt.Errorf("provider.base_url is required")
	}
	if !strings.HasPrefix(c.BaseURL, "http://") && !strings.HasPrefix(c.BaseURL, "https://") {
		return fmt.Errorf("provider.base_url must be http(s)")
	}
	if c.Model == "" {
		return fmt.Errorf("provider.model is required")
	}
	switch c.Kind {
	case "openai-compatible", "":
	default:
		return fmt.Errorf("unsupported provider.kind %q (v1: openai-compatible)", c.Kind)
	}
	return nil
}

// MaskAPIKey redacts secrets for GET /api/settings.
func MaskAPIKey(key string) string {
	key = strings.TrimSpace(key)
	if key == "" {
		return ""
	}
	if len(key) <= 8 {
		return "••••••••"
	}
	return key[:3] + "…" + key[len(key)-4:]
}

// NewClient builds a Client from config.
func NewClient(cfg Config) (Client, error) {
	cfg = cfg.Normalize()
	apiKey, err := resolveAPIKey(cfg.APIKey)
	if err != nil {
		return nil, err
	}
	cfg.APIKey = apiKey
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	switch cfg.Kind {
	case "openai-compatible", "":
		return newOpenAICompat(cfg), nil
	default:
		return nil, fmt.Errorf("unsupported provider.kind %q", cfg.Kind)
	}
}

// resolveAPIKey supports exact $NAME and ${NAME} references in persisted
// provider configuration, keeping the actual secret out of Kin's database.
func resolveAPIKey(value string) (string, error) {
	value = strings.TrimSpace(value)
	name := ""
	if strings.HasPrefix(value, "${") && strings.HasSuffix(value, "}") {
		name = value[2 : len(value)-1]
	} else if strings.HasPrefix(value, "$") {
		name = value[1:]
	} else {
		return value, nil
	}
	if name == "" || strings.ContainsAny(name, "${} \\t\\r\\n") {
		return "", fmt.Errorf("invalid provider API key environment reference %q", value)
	}
	resolved, ok := os.LookupEnv(name)
	if !ok || strings.TrimSpace(resolved) == "" {
		return "", fmt.Errorf("provider API key environment variable %s is not set", name)
	}
	return strings.TrimSpace(resolved), nil
}
