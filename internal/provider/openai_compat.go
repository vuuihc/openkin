package provider

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
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
	Model         string            `json:"model"`
	Messages      []oaiMessage      `json:"messages"`
	Tools         []ToolDef         `json:"tools,omitempty"`
	ToolChoice    any               `json:"tool_choice,omitempty"`
	Temperature   *float64          `json:"temperature,omitempty"`
	MaxTokens     *int              `json:"max_tokens,omitempty"`
	Stream        bool              `json:"stream"`
	StreamOptions *oaiStreamOptions `json:"stream_options,omitempty"`
}

type oaiStreamOptions struct {
	IncludeUsage bool `json:"include_usage"`
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
			Role             string     `json:"role"`
			Content          *string    `json:"content"`
			ReasoningContent string     `json:"reasoning_content"`
			ToolCalls        []ToolCall `json:"tool_calls"`
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
		// Multimodal parts (vision) take precedence over plain text Content.
		if len(m.Parts) > 0 {
			om.Content = m.Parts
		} else if m.Role == RoleAssistant && len(m.ToolCalls) > 0 && m.Content == "" {
			// OpenAI: assistant tool_calls turns often send content=null.
			om.Content = nil
		} else {
			om.Content = m.Content
		}
		msgs = append(msgs, om)
	}
	useStream := c.cfg.Stream
	if req.Stream != nil {
		useStream = *req.Stream
	}
	body := oaiChatReq{
		Model:       model,
		Messages:    msgs,
		Temperature: req.Temperature,
		MaxTokens:   req.MaxTokens,
		Stream:      useStream,
	}
	if len(req.Tools) > 0 {
		body.Tools = req.Tools
		tc := req.ToolChoice
		if tc == "" {
			tc = "auto"
		}
		body.ToolChoice = tc
	}
	// OpenAI-compatible stream responses only include usage when stream_options
	// is set; keep the field optional for proxies that ignore unknown keys.
	if useStream {
		body.StreamOptions = &oaiStreamOptions{IncludeUsage: true}
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}

	url := strings.TrimRight(c.cfg.BaseURL, "/") + "/chat/completions"

	var lastErr error
	tried := 0
	streamedToCaller := false
	trackDelta := func(callback func(string)) func(string) {
		if callback == nil {
			return nil
		}
		return func(delta string) {
			streamedToCaller = true
			callback(delta)
		}
	}
	onContentDelta := trackDelta(req.OnContentDelta)
	onReasoningDelta := trackDelta(req.OnReasoningDelta)
	for attempt := 1; attempt <= chatMaxAttempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		tried = attempt
		var resp *ChatResponse
		var err error
		if useStream {
			resp, err = c.chatOnceStream(
				ctx,
				url,
				raw,
				model,
				onContentDelta,
				onReasoningDelta,
			)
		} else {
			resp, err = c.chatOnce(ctx, url, raw, model)
		}
		if err == nil {
			return resp, nil
		}
		lastErr = err
		if streamedToCaller || !isTransientProviderErr(ctx, err) || attempt == chatMaxAttempts {
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
		return nil, fmt.Errorf("decode %s (HTTP %d): non-JSON body=%s", url, res.StatusCode, bodyExcerpt(bodyStr, 200))
	}

	var parsed oaiChatResp
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		if res.StatusCode < 200 || res.StatusCode >= 300 {
			return nil, httpStatusErr(res.StatusCode, url, bodyStr)
		}
		return nil, fmt.Errorf("decode %s (HTTP %d): %w; body=%s", url, res.StatusCode, err, bodyExcerpt(bodyStr, 200))
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
		Content:   content,
		Reasoning: msg.ReasoningContent,
		Model:     firstNonEmpty(parsed.Model, model),
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

// oaiStreamChunk is one SSE data payload from stream=true chat completions.
type oaiStreamChunk struct {
	Model   string `json:"model"`
	Choices []struct {
		Index        int    `json:"index"`
		FinishReason string `json:"finish_reason"`
		Delta        struct {
			Role             string `json:"role"`
			Content          string `json:"content"`
			ReasoningContent string `json:"reasoning_content"`
			ToolCalls        []struct {
				Index    int    `json:"index"`
				ID       string `json:"id"`
				Type     string `json:"type"`
				Function struct {
					Name      string `json:"name"`
					Arguments string `json:"arguments"`
				} `json:"function"`
			} `json:"tool_calls"`
		} `json:"delta"`
	} `json:"choices"`
	Usage *struct {
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

func (c *openAICompat) chatOnceStream(
	ctx context.Context,
	url string,
	raw []byte,
	model string,
	onContentDelta func(string),
	onReasoningDelta func(string),
) (*ChatResponse, error) {
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "text/event-stream")
	if c.cfg.APIKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+c.cfg.APIKey)
	}

	res, err := c.client.Do(httpReq)
	if err != nil {
		return nil, classifyRequestErr(url, err)
	}
	defer res.Body.Close()

	// Non-2xx: read a bounded body for error classification (same as non-stream).
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		respBody, _ := io.ReadAll(io.LimitReader(res.Body, 16<<20))
		bodyStr := string(respBody)
		trimmed := strings.TrimSpace(bodyStr)
		looksJSON := len(trimmed) > 0 && (trimmed[0] == '{' || trimmed[0] == '[')
		if looksJSON {
			var parsed oaiChatResp
			if err := json.Unmarshal(respBody, &parsed); err == nil && parsed.Error != nil && parsed.Error.Message != "" {
				return nil, httpStatusErr(res.StatusCode, url, parsed.Error.Message)
			}
		}
		return nil, httpStatusErr(res.StatusCode, url, bodyStr)
	}

	agg, err := readOpenAIStream(
		res.Body,
		model,
		onContentDelta,
		onReasoningDelta,
	)
	if err != nil {
		return nil, err
	}
	return agg, nil
}

func readOpenAIStream(
	r io.Reader,
	fallbackModel string,
	onContentDelta func(string),
	onReasoningDelta func(string),
) (*ChatResponse, error) {
	sc := bufio.NewScanner(r)
	// Tool-call argument streams can be large; raise the default 64KiB limit.
	sc.Buffer(make([]byte, 0, 64*1024), 8<<20)

	var content strings.Builder
	var reasoning strings.Builder
	// Indexed tool call assembly (OpenAI streams by index).
	type tcAcc struct {
		id, typ, name string
		args          strings.Builder
	}
	toolByIdx := map[int]*tcAcc{}
	maxToolIdx := -1
	finishReason := ""
	model := fallbackModel
	usage := Usage{}
	gotAny := false

	for sc.Scan() {
		line := sc.Text()
		if line == "" || strings.HasPrefix(line, ":") {
			continue
		}
		if !strings.HasPrefix(line, "data:") {
			// Some proxies omit the "data:" prefix; try raw JSON object lines.
			trimmed := strings.TrimSpace(line)
			if len(trimmed) == 0 || trimmed[0] != '{' {
				continue
			}
			line = "data: " + trimmed
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" {
			continue
		}
		if payload == "[DONE]" {
			break
		}
		var chunk oaiStreamChunk
		if err := json.Unmarshal([]byte(payload), &chunk); err != nil {
			return nil, fmt.Errorf("decode stream chunk: %w; payload=%s", err, truncate(payload, 200))
		}
		if chunk.Error != nil && chunk.Error.Message != "" {
			return nil, fmt.Errorf("provider stream error: %s", chunk.Error.Message)
		}
		gotAny = true
		if chunk.Model != "" {
			model = chunk.Model
		}
		if chunk.Usage != nil {
			usage.PromptTokens = chunk.Usage.PromptTokens
			usage.CompletionTokens = chunk.Usage.CompletionTokens
			usage.TotalTokens = chunk.Usage.TotalTokens
			if chunk.Usage.CachedTokens != nil {
				usage.CachedTokens = *chunk.Usage.CachedTokens
				usage.CacheReadReported = true
			} else if chunk.Usage.PromptTokensDetails != nil && chunk.Usage.PromptTokensDetails.CachedTokens != nil {
				usage.CachedTokens = *chunk.Usage.PromptTokensDetails.CachedTokens
				usage.CacheReadReported = true
			} else if chunk.Usage.CacheReadInputTokens != nil {
				usage.CachedTokens = *chunk.Usage.CacheReadInputTokens
				usage.CacheReadReported = true
			}
		}
		for _, ch := range chunk.Choices {
			if ch.FinishReason != "" {
				finishReason = ch.FinishReason
			}
			if ch.Delta.Content != "" {
				content.WriteString(ch.Delta.Content)
				if onContentDelta != nil {
					onContentDelta(ch.Delta.Content)
				}
			}
			if ch.Delta.ReasoningContent != "" {
				reasoning.WriteString(ch.Delta.ReasoningContent)
				if onReasoningDelta != nil {
					onReasoningDelta(ch.Delta.ReasoningContent)
				}
			}
			for _, tc := range ch.Delta.ToolCalls {
				idx := tc.Index
				acc, ok := toolByIdx[idx]
				if !ok {
					acc = &tcAcc{}
					toolByIdx[idx] = acc
					if idx > maxToolIdx {
						maxToolIdx = idx
					}
				} else if tc.ID != "" && acc.id != "" && tc.ID != acc.id {
					// Same index, different id: proxy reused idx for a
					// distinct tool call. Allocate a synthetic index so
					// they don't collide.
					maxToolIdx++
					idx = maxToolIdx
					acc = &tcAcc{}
					toolByIdx[idx] = acc
				}
				if tc.ID != "" {
					acc.id = tc.ID
				}
				if tc.Type != "" {
					acc.typ = tc.Type
				}
				if tc.Function.Name != "" {
					acc.name = tc.Function.Name
				}
				if tc.Function.Arguments != "" {
					acc.args.WriteString(tc.Function.Arguments)
				}
				log.Printf("openai_compat: tool_call delta idx=%d id=%q name=%q args=%q",
					idx, tc.ID, tc.Function.Name, tc.Function.Arguments)
			}
		}
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("read stream: %w", err)
	}
	if !gotAny {
		return nil, fmt.Errorf("empty stream response")
	}

	var toolCalls []ToolCall
	if maxToolIdx >= 0 {
		toolCalls = make([]ToolCall, 0, maxToolIdx+1)
		for i := 0; i <= maxToolIdx; i++ {
			acc, ok := toolByIdx[i]
			if !ok {
				continue
			}
			typ := acc.typ
			if typ == "" {
				typ = "function"
			}
			if acc.name == "" {
				log.Printf("openai_compat: skipping tool_call idx=%d with empty name (id=%q args=%q)",
					i, acc.id, acc.args.String())
				continue
			}
			tc := ToolCall{ID: acc.id, Type: typ}
			tc.Function.Name = acc.name
			tc.Function.Arguments = acc.args.String()
			toolCalls = append(toolCalls, tc)
		}
	}
	if finishReason == "" {
		if len(toolCalls) > 0 {
			finishReason = "tool_calls"
		} else {
			finishReason = "stop"
		}
	}
	return &ChatResponse{
		Content:      content.String(),
		Reasoning:    reasoning.String(),
		Model:        model,
		Usage:        usage,
		FinishReason: finishReason,
		ToolCalls:    toolCalls,
	}, nil
}

// httpStatusErr builds a clear, retry-classifiable provider HTTP error.
func httpStatusErr(code int, url, body string) error {
	hint := httpStatusHint(code)
	msg := truncate(oneLine(providerErrorMessage(body)), 300)
	if msg == "" && hint == "" {
		// No hint and no body message: a page's own title is the only thing
		// left that names the refusal ("Attention Required! | Cloudflare").
		msg = truncate(oneLine(markupPageTitle(body)), 120)
	}
	if msg == "" {
		if hint == "" {
			return fmt.Errorf("provider HTTP %d (%s)", code, url)
		}
		return fmt.Errorf("provider HTTP %d (%s): %s", code, url, hint)
	}
	// A body that already says what the hint would say ("rate limited", a
	// gateway's own "origin unreachable") is one line, not two.
	if hint == "" || strings.Contains(strings.ToLower(msg), strings.ToLower(hint)) {
		return fmt.Errorf("provider HTTP %d (%s): %s", code, url, msg)
	}
	return fmt.Errorf("provider HTTP %d (%s): %s — %s", code, url, hint, msg)
}

// providerErrorMessage reduces a failed response body to the sentence worth
// reading, and drops bodies that are an HTML page rather than a message.
//
// A gateway that cannot reach the origin answers with its own HTML error page;
// truncated into the task's error that page is a wall of doctypes and inline
// styles, it says nothing the status hint does not, and it is stored in the
// transcript, pushed to a phone, and shown to whoever the conversation is
// shared with. The status code and hint stand on their own there. A provider
// that answers with its own JSON error — OpenAI's and Anthropic's envelopes,
// or a bare {"message":…} — does name something worth keeping, so that message
// is extracted rather than half-quoted as JSON.
func providerErrorMessage(body string) string {
	body = strings.TrimSpace(strings.TrimPrefix(body, "\xef\xbb\xbf"))
	if body == "" {
		return ""
	}
	if msg := jsonBodyMessage(body); msg != "" {
		return msg
	}
	// Markup is recognised by how the body starts, not by what it mentions: a
	// provider's own message may say "expected text but got <html> markup",
	// and dropping that would leave a bare status with no cause at all. XML
	// error documents are text worth keeping, so only HTML openings count.
	// An empty root is a body of nothing but comments or declarations, or a
	// comment that never closes: either way there is no message in it.
	root := asciiLower(bodyRoot(body))
	if root == "" ||
		strings.HasPrefix(root, "<!doctype") ||
		strings.HasPrefix(root, "<html") ||
		strings.HasPrefix(root, "<head") ||
		strings.HasPrefix(root, "<body") {
		return ""
	}
	return body
}

// bodyRoot strips what may precede a document's first element — comments and
// an XML declaration, in either order and any number — so a page that opens
// with either is still recognised by the tag that actually follows.
func bodyRoot(body string) string {
	for {
		body = strings.TrimSpace(body)
		switch {
		case strings.HasPrefix(body, "<!--"):
			end := strings.Index(body, "-->")
			if end < 0 {
				return ""
			}
			body = body[end+3:]
		case len(body) >= 5 && strings.EqualFold(body[:5], "<?xml"):
			end := strings.Index(body, "?>")
			if end < 0 {
				return ""
			}
			body = body[end+2:]
		default:
			return body
		}
	}
}

// asciiLower lowercases A–Z only. Unlike strings.ToLower it cannot change the
// byte length of the string, so an offset found in its result is an offset in
// the original — the property slicing provider-controlled text depends on.
func asciiLower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + ('a' - 'A')
		}
	}
	return string(b)
}

// markupPageTitle reads the <title> out of an HTML error page. It is a label,
// not a page: one line, bounded, and only used where there is no status hint.
// Comments are removed first — a conditional comment can carry a decoy title,
// and a comment can mention one — so the title that is read is the document's.
func markupPageTitle(body string) string {
	body = stripHTMLComments(body)
	lower := asciiLower(body)
	open := strings.Index(lower, "<title")
	if open < 0 {
		return ""
	}
	gt := strings.IndexByte(lower[open:], '>')
	if gt < 0 {
		return ""
	}
	rest := body[open+gt+1:]
	end := strings.Index(asciiLower(rest), "</title>")
	if end < 0 {
		end = len(rest)
	}
	return strings.TrimSpace(rest[:end])
}

// stripHTMLComments removes every <!-- … --> span. An unterminated comment
// takes the rest of the body with it: nothing after it is document text.
func stripHTMLComments(s string) string {
	var b strings.Builder
	for {
		open := strings.Index(s, "<!--")
		if open < 0 {
			b.WriteString(s)
			return b.String()
		}
		b.WriteString(s[:open])
		end := strings.Index(s[open:], "-->")
		if end < 0 {
			return b.String()
		}
		s = s[open+end+3:]
	}
}

// jsonBodyMessage pulls the message out of a provider's JSON error envelope.
// Each field is decoded on its own: one field of an unexpected type must not
// hide a clean message in the one beside it.
func jsonBodyMessage(body string) string {
	var payload map[string]json.RawMessage
	if err := json.Unmarshal([]byte(body), &payload); err != nil {
		return ""
	}
	if raw, ok := payload["error"]; ok {
		if text := rawJSONString(raw); text != "" {
			return text
		}
		var envelope map[string]json.RawMessage
		if err := json.Unmarshal(raw, &envelope); err == nil {
			if msg := rawJSONString(envelope["message"]); msg != "" {
				return msg
			}
		}
	}
	for _, key := range []string{"message", "detail"} {
		if msg := rawJSONString(payload[key]); msg != "" {
			return msg
		}
	}
	return ""
}

func rawJSONString(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var text string
	if err := json.Unmarshal(raw, &text); err == nil && strings.TrimSpace(text) != "" {
		return text
	}
	return ""
}

// bodyExcerpt is what a decode error shows of a body it could not read: the
// message it carried, or a note that the body was a page rather than data.
func bodyExcerpt(body string, n int) string {
	if excerpt := truncate(oneLine(providerErrorMessage(body)), n); excerpt != "" {
		return excerpt
	}
	if strings.TrimSpace(body) != "" {
		return "an HTML error page"
	}
	return "an empty body"
}

// oneLine collapses a body's whitespace so an error stays one readable line.
func oneLine(s string) string {
	return strings.Join(strings.Fields(s), " ")
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
		strings.Contains(s, "eof") ||
		strings.Contains(s, "stream error") ||
		strings.Contains(s, "internal_error") ||
		strings.Contains(s, "received from peer") {
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
			if hint := httpStatusHint(code); hint != "" && !strings.Contains(strings.ToLower(s), strings.ToLower(hint)) {
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
		// The last attempt's message usually starts with the same words the
		// hint would ("provider HTTP 520 (…): cloudflare/origin unreachable"),
		// and prefixing them again reads as two faults. Name the cause once and
		// keep the attempt count on the end.
		if strings.Contains(strings.ToLower(s), strings.ToLower(hint)) {
			return fmt.Errorf("%s (failed after %d attempts)", s, attempts)
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
	cut := n
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	if cut == 0 {
		return "…"
	}
	return s[:cut] + "…"
}
