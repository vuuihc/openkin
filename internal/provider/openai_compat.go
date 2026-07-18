package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Transient chat attempts: 1 initial + up to 4 retries = 5 total.
// Overridable in tests.
var chatMaxAttempts = 5

// chatBackoffFn computes sleep after a failed attempt (1-based).
var chatBackoffFn = defaultChatBackoff

type openAICompat struct {
	cfg    Config
	client *http.Client
}

func newOpenAICompat(cfg Config) *openAICompat {
	return &openAICompat{
		cfg: cfg,
		client: &http.Client{
			// Agent loop may issue many tool rounds; each call can be long.
			// Cloudflare 524 often fires around ~100s; keep client timeout higher
			// so we still receive the gateway error and can retry.
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
		PromptTokens         int  `json:"prompt_tokens"`
		CompletionTokens     int  `json:"completion_tokens"`
		TotalTokens          int  `json:"total_tokens"`
		CachedTokens         *int `json:"cached_tokens"`
		CacheReadInputTokens *int `json:"cache_read_input_tokens"`
		PromptTokensDetails  *struct {
			CachedTokens *int `json:"cached_tokens"`
		} `json:"prompt_tokens_details"`
	} `json:"usage"`
	Error *struct {
		Message string `json:"message"`
		Type    string `json:"type"`
		Code    any    `json:"code"`
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
		// OpenAI: assistant tool_calls turns often send content=null.
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

	var lastErr error
	tried := 0
	for attempt := 1; attempt <= chatMaxAttempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		tried = attempt
		resp, err := c.chatOnce(ctx, url, raw, model)
		if err == nil {
			return resp, nil
		}
		lastErr = err
		if !isTransientProviderErr(ctx, err) || attempt == chatMaxAttempts {
			break
		}
		wait := chatBackoffFn(attempt)
		notifyChatRetry(ctx, attempt, chatMaxAttempts, wait, err)
		if err := sleepCtx(ctx, wait); err != nil {
			return nil, err
		}
	}
	return nil, formatFinalProviderErr(lastErr, tried)
}

func (c *openAICompat) chatOnce(ctx context.Context, url string, raw []byte, model string) (*ChatResponse, error) {
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
		return nil, classifyRequestErr(url, err)
	}
	defer res.Body.Close()
	respBody, err := io.ReadAll(io.LimitReader(res.Body, 16<<20))
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}

	// Non-JSON error pages (Cloudflare 52x, HTML gateways, plain "error code: 524")
	// should surface as HTTP failures — not JSON decode noise. Decode only when
	// the body looks like JSON, or when status is 2xx (must parse).
	bodyStr := string(respBody)
	trimmed := strings.TrimSpace(bodyStr)
	looksJSON := len(trimmed) > 0 && (trimmed[0] == '{' || trimmed[0] == '[')

	if !looksJSON {
		if res.StatusCode < 200 || res.StatusCode >= 300 {
			return nil, httpStatusErr(res.StatusCode, url, bodyStr)
		}
		return nil, fmt.Errorf("decode %s (HTTP %d): non-JSON body=%s", url, res.StatusCode, truncate(bodyStr, 200))
	}

	var parsed oaiChatResp
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		if res.StatusCode < 200 || res.StatusCode >= 300 {
			return nil, httpStatusErr(res.StatusCode, url, bodyStr)
		}
		return nil, fmt.Errorf("decode %s (HTTP %d): %w; body=%s", url, res.StatusCode, err, truncate(bodyStr, 200))
	}
	if parsed.Error != nil && parsed.Error.Message != "" {
		// Prefer provider message; keep status when non-2xx.
		if res.StatusCode < 200 || res.StatusCode >= 300 {
			return nil, httpStatusErr(res.StatusCode, url, parsed.Error.Message)
		}
		return nil, fmt.Errorf("provider error (%s): %s", url, parsed.Error.Message)
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, httpStatusErr(res.StatusCode, url, bodyStr)
	}
	if len(parsed.Choices) == 0 {
		return nil, fmt.Errorf("provider returned no choices")
	}
	msg := parsed.Choices[0].Message
	content := ""
	if msg.Content != nil {
		content = *msg.Content
	}
	cached := 0
	cacheReadReported := false
	if parsed.Usage.CachedTokens != nil {
		cached = *parsed.Usage.CachedTokens
		cacheReadReported = true
	} else if parsed.Usage.PromptTokensDetails != nil && parsed.Usage.PromptTokensDetails.CachedTokens != nil {
		cached = *parsed.Usage.PromptTokensDetails.CachedTokens
		cacheReadReported = true
	} else if parsed.Usage.CacheReadInputTokens != nil {
		cached = *parsed.Usage.CacheReadInputTokens
		cacheReadReported = true
	}
	return &ChatResponse{
		Content: content,
		Model:   firstNonEmpty(parsed.Model, model),
		Usage: Usage{
			PromptTokens:      parsed.Usage.PromptTokens,
			CompletionTokens:  parsed.Usage.CompletionTokens,
			TotalTokens:       parsed.Usage.TotalTokens,
			CachedTokens:      cached,
			CacheReadReported: cacheReadReported,
		},
		FinishReason: parsed.Choices[0].FinishReason,
		ToolCalls:    msg.ToolCalls,
	}, nil
}

// httpStatusErr builds a clear, retry-classifiable provider HTTP error.
func httpStatusErr(code int, url, body string) error {
	hint := httpStatusHint(code)
	msg := truncate(strings.TrimSpace(body), 300)
	if hint != "" && msg != "" {
		return fmt.Errorf("provider HTTP %d (%s): %s — %s", code, url, hint, msg)
	}
	if hint != "" {
		return fmt.Errorf("provider HTTP %d (%s): %s", code, url, hint)
	}
	if msg != "" {
		return fmt.Errorf("provider HTTP %d (%s): %s", code, url, msg)
	}
	return fmt.Errorf("provider HTTP %d (%s)", code, url)
}

func httpStatusHint(code int) string {
	switch code {
	case 408:
		return "request timeout"
	case 429:
		return "rate limited"
	case 500:
		return "upstream internal error"
	case 502:
		return "bad gateway"
	case 503:
		return "service unavailable"
	case 504:
		return "gateway timeout"
	case 520, 521, 522, 523:
		return "cloudflare/origin unreachable"
	case 524:
		return "gateway timeout (origin did not respond in time)"
	case 525, 526:
		return "cloudflare TLS handshake error"
	default:
		return ""
	}
}

func classifyRequestErr(url string, err error) error {
	if err == nil {
		return nil
	}
	// Preserve context cancel/deadline as-is for abort paths.
	if errors.Is(err, context.Canceled) {
		return fmt.Errorf("provider request %s: %w", url, err)
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("provider request timeout %s: %w", url, err)
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return fmt.Errorf("provider request timeout %s: %w", url, err)
	}
	s := strings.ToLower(err.Error())
	if strings.Contains(s, "timeout") || strings.Contains(s, "deadline exceeded") {
		return fmt.Errorf("provider request timeout %s: %w", url, err)
	}
	return fmt.Errorf("provider request %s: %w", url, err)
}

// isTransientProviderErr reports whether the error is worth retrying.
// ctx is the parent Chat context: if it is already done, do not retry.
func isTransientProviderErr(ctx context.Context, err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.Canceled) {
		return false
	}
	// Parent canceled or timed out — stop. http.Client.Timeout also surfaces as
	// context.DeadlineExceeded on a child context; only skip when parent is done.
	if ctx != nil && ctx.Err() != nil {
		return false
	}
	s := strings.ToLower(err.Error())
	// Explicit non-retryable auth/validation.
	for _, k := range []string{
		"http 400", "http 401", "http 403", "http 404",
		"invalid api key", "unauthorized", "forbidden",
		"does not support tool", "tools are not supported",
		"function calling is not supported",
	} {
		if strings.Contains(s, k) {
			return false
		}
	}
	// http.Client.Timeout / child-ctx deadline with live parent.
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	// Timeouts / transport.
	if strings.Contains(s, "timeout") ||
		strings.Contains(s, "deadline exceeded") ||
		strings.Contains(s, "connection reset") ||
		strings.Contains(s, "connection refused") ||
		strings.Contains(s, "broken pipe") ||
		strings.Contains(s, "tls handshake timeout") ||
		strings.Contains(s, "i/o timeout") ||
		strings.Contains(s, "temporary failure") ||
		strings.Contains(s, "eof") {
		return true
	}
	// Retryable HTTP statuses (incl. Cloudflare 52x).
	if code, ok := parseProviderHTTPStatus(s); ok {
		switch code {
		case 408, 409, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 529:
			return true
		default:
			return false
		}
	}
	return false
}

func parseProviderHTTPStatus(s string) (int, bool) {
	// "provider HTTP 524 (...)"
	const mark = "http "
	idx := strings.Index(s, mark)
	for idx >= 0 {
		rest := s[idx+len(mark):]
		n := 0
		for n < len(rest) && rest[n] >= '0' && rest[n] <= '9' {
			n++
		}
		if n >= 3 {
			code, err := strconv.Atoi(rest[:n])
			if err == nil {
				return code, true
			}
		}
		next := strings.Index(rest, mark)
		if next < 0 {
			break
		}
		idx = idx + len(mark) + next
	}
	return 0, false
}

func defaultChatBackoff(attempt int) time.Duration {
	// attempt is 1-based (failed attempt number).
	// 1s, 2s, 4s, 8s — cap 8s between tries.
	d := time.Second << (attempt - 1)
	if d > 8*time.Second {
		d = 8 * time.Second
	}
	return d
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

func formatFinalProviderErr(err error, attempts int) error {
	if err == nil {
		return fmt.Errorf("provider failed after %d attempts", attempts)
	}
	s := err.Error()
	// Avoid double-wrapping if already annotated.
	if strings.Contains(s, "after ") && strings.Contains(s, " attempt") {
		return err
	}
	// Single non-retryable failure: keep original error (auth, 400, etc.).
	if attempts <= 1 {
		// Still clarify gateway timeout codes even on a single attempt.
		if code, ok := parseProviderHTTPStatus(strings.ToLower(s)); ok {
			if hint := httpStatusHint(code); hint != "" && !strings.Contains(s, hint) {
				return fmt.Errorf("%s — %s", hint, s)
			}
		}
		return err
	}
	if code, ok := parseProviderHTTPStatus(strings.ToLower(s)); ok {
		hint := httpStatusHint(code)
		if hint == "" {
			hint = "upstream error"
		}
		return fmt.Errorf("%s (failed after %d attempts; last: %s)", hint, attempts, s)
	}
	if strings.Contains(strings.ToLower(s), "timeout") {
		return fmt.Errorf("provider timeout (failed after %d attempts; last: %s)", attempts, s)
	}
	return fmt.Errorf("provider failed after %d attempts: %s", attempts, s)
}

// RetryNotifyFunc is invoked before sleeping between chat retries.
// attempt is the failed attempt (1-based); max is chatMaxAttempts.
type RetryNotifyFunc func(attempt, max int, wait time.Duration, err error)

type retryNotifyKey struct{}

// WithRetryNotify attaches a callback used by Chat when retrying transient errors.
func WithRetryNotify(ctx context.Context, fn RetryNotifyFunc) context.Context {
	if fn == nil {
		return ctx
	}
	return context.WithValue(ctx, retryNotifyKey{}, fn)
}

func notifyChatRetry(ctx context.Context, attempt, max int, wait time.Duration, err error) {
	fn, _ := ctx.Value(retryNotifyKey{}).(RetryNotifyFunc)
	if fn != nil {
		fn(attempt, max, wait, err)
	}
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
