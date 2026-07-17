package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type openAICompat struct {
	cfg    Config
	client *http.Client
}

func newOpenAICompat(cfg Config) *openAICompat {
	return &openAICompat{
		cfg: cfg,
		client: &http.Client{
			// Agent loop may issue many tool rounds; each call can be long.
			Timeout: 180 * time.Second,
		},
	}
}

func (c *openAICompat) Kind() string         { return "openai-compatible" }
func (c *openAICompat) ModelDefault() string { return c.cfg.Model }

type oaiChatReq struct {
	Model       string       `json:"model"`
	Messages    []oaiMessage `json:"messages"`
	Tools       []ToolDef    `json:"tools,omitempty"`
	ToolChoice  any          `json:"tool_choice,omitempty"`
	Temperature *float64     `json:"temperature,omitempty"`
	MaxTokens   *int         `json:"max_tokens,omitempty"`
	Stream      bool         `json:"stream"`
}

type oaiMessage struct {
	Role       string     `json:"role"`
	Content    any        `json:"content,omitempty"` // string or null when tool_calls-only
	Name       string     `json:"name,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
}

type oaiChatResp struct {
	Model   string `json:"model"`
	Choices []struct {
		FinishReason string `json:"finish_reason"`
		Message      struct {
			Role      string     `json:"role"`
			Content   *string    `json:"content"`
			ToolCalls []ToolCall `json:"tool_calls"`
		} `json:"message"`
	} `json:"choices"`
	Usage struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
		TotalTokens      int `json:"total_tokens"`
		// OpenAI-style nested detail (may be absent).
		PromptTokensDetails *struct {
			CachedTokens int `json:"cached_tokens"`
		} `json:"prompt_tokens_details"`
		// Alternate flat / Anthropic-compatible fields some proxies expose.
		CachedTokens       int `json:"cached_tokens"`
		CacheReadInputTokens int `json:"cache_read_input_tokens"`
	} `json:"usage"`
	Error *struct {
		Message string `json:"message"`
		Type    string `json:"type"`
	} `json:"error"`
}

func (c *openAICompat) Chat(ctx context.Context, req ChatRequest) (*ChatResponse, error) {
	model := req.Model
	if model == "" {
		model = c.cfg.Model
	}
	msgs := make([]oaiMessage, 0, len(req.Messages))
	for _, m := range req.Messages {
		om := oaiMessage{
			Role:       m.Role,
			Name:       m.Name,
			ToolCallID: m.ToolCallID,
			ToolCalls:  m.ToolCalls,
		}
		// OpenAI: assistant tool_calls turns often use content: null
		if m.Role == RoleAssistant && len(m.ToolCalls) > 0 && m.Content == "" {
			om.Content = nil
		} else {
			om.Content = m.Content
		}
		msgs = append(msgs, om)
	}
	body := oaiChatReq{
		Model:       model,
		Messages:    msgs,
		Temperature: req.Temperature,
		MaxTokens:   req.MaxTokens,
		Stream:      false,
	}
	if len(req.Tools) > 0 {
		body.Tools = req.Tools
		tc := req.ToolChoice
		if tc == "" {
			tc = "auto"
		}
		body.ToolChoice = tc
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}

	url := strings.TrimRight(c.cfg.BaseURL, "/") + "/chat/completions"
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if c.cfg.APIKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+c.cfg.APIKey)
	}

	res, err := c.client.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("provider request %s: %w", url, err)
	}
	defer res.Body.Close()
	respBody, err := io.ReadAll(io.LimitReader(res.Body, 16<<20))
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}

	var parsed oaiChatResp
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return nil, fmt.Errorf("decode %s (HTTP %d): %w; body=%s", url, res.StatusCode, err, truncate(string(respBody), 200))
	}
	if parsed.Error != nil && parsed.Error.Message != "" {
		return nil, fmt.Errorf("provider error (%s): %s", url, parsed.Error.Message)
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("provider HTTP %d (%s): %s", res.StatusCode, url, truncate(string(respBody), 300))
	}
	if len(parsed.Choices) == 0 {
		return nil, fmt.Errorf("provider returned no choices")
	}
	msg := parsed.Choices[0].Message
	content := ""
	if msg.Content != nil {
		content = *msg.Content
	}
	cached := parsed.Usage.CachedTokens
	if cached == 0 && parsed.Usage.PromptTokensDetails != nil {
		cached = parsed.Usage.PromptTokensDetails.CachedTokens
	}
	if cached == 0 && parsed.Usage.CacheReadInputTokens > 0 {
		cached = parsed.Usage.CacheReadInputTokens
	}
	return &ChatResponse{
		Content: content,
		Model:   firstNonEmpty(parsed.Model, model),
		Usage: Usage{
			PromptTokens:     parsed.Usage.PromptTokens,
			CompletionTokens: parsed.Usage.CompletionTokens,
			TotalTokens:      parsed.Usage.TotalTokens,
			CachedTokens:     cached,
		},
		FinishReason: parsed.Choices[0].FinishReason,
		ToolCalls:    msg.ToolCalls,
	}, nil
}

func firstNonEmpty(a, b string) string {
	if strings.TrimSpace(a) != "" {
		return a
	}
	return b
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
