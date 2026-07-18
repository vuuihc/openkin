package provider

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestOpenAICompatChat(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Fatalf("path %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer sk-test" {
			t.Fatalf("auth %q", r.Header.Get("Authorization"))
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"model": "gpt-test",
			"choices": []map[string]any{
				{"finish_reason": "stop", "message": map[string]string{"role": "assistant", "content": "hello kin"}},
			},
			"usage": map[string]any{
				"prompt_tokens": 10, "completion_tokens": 3, "total_tokens": 13,
				"prompt_tokens_details": map[string]int{"cached_tokens": 7},
			},
		})
	}))
	defer srv.Close()

	c, err := NewClient(Config{
		Kind:    "openai-compatible",
		BaseURL: srv.URL + "/v1",
		APIKey:  "sk-test",
		Model:   "gpt-test",
	})
	if err != nil {
		t.Fatal(err)
	}
	resp, err := c.Chat(context.Background(), ChatRequest{
		Messages: []Message{{Role: RoleUser, Content: "hi"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if resp.Content != "hello kin" {
		t.Fatalf("content %q", resp.Content)
	}
	if resp.Usage.PromptTokens != 10 {
		t.Fatalf("tokens %+v", resp.Usage)
	}
	if resp.Usage.CachedTokens != 7 {
		t.Fatalf("cached_tokens %+v", resp.Usage)
	}
	if !resp.Usage.CacheReadReported {
		t.Fatalf("cache field presence lost: %+v", resp.Usage)
	}
}

func TestOpenAICompatCachePresence(t *testing.T) {
	tests := []struct {
		name     string
		usage    map[string]any
		want     int
		reported bool
	}{
		{
			name: "reported zero",
			usage: map[string]any{
				"prompt_tokens": 10, "completion_tokens": 1, "total_tokens": 11,
				"prompt_tokens_details": map[string]int{"cached_tokens": 0},
			},
			want: 0, reported: true,
		},
		{
			name: "missing",
			usage: map[string]any{
				"prompt_tokens": 10, "completion_tokens": 1, "total_tokens": 11,
			},
			want: 0, reported: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_ = json.NewEncoder(w).Encode(map[string]any{
					"model": "gpt-test",
					"choices": []map[string]any{
						{"finish_reason": "stop", "message": map[string]string{"role": "assistant", "content": "ok"}},
					},
					"usage": tt.usage,
				})
			}))
			t.Cleanup(srv.Close)

			client, err := NewClient(Config{BaseURL: srv.URL + "/v1", Model: "gpt-test"})
			if err != nil {
				t.Fatal(err)
			}
			resp, err := client.Chat(context.Background(), ChatRequest{Messages: []Message{{Role: RoleUser, Content: "hi"}}})
			if err != nil {
				t.Fatal(err)
			}
			if resp.Usage.CachedTokens != tt.want || resp.Usage.CacheReadReported != tt.reported {
				t.Fatalf("usage=%+v want cached=%d reported=%v", resp.Usage, tt.want, tt.reported)
			}
		})
	}
}

func TestConfigConfigured(t *testing.T) {
	if (Config{}).Configured() {
		t.Fatal("empty should not be configured")
	}
	if !(Config{BaseURL: "http://x/v1", Model: "m"}).Configured() {
		t.Fatal("want configured")
	}
}

func TestMaskAPIKey(t *testing.T) {
	if MaskAPIKey("sk-abcdefghij") == "sk-abcdefghij" {
		t.Fatal("should mask")
	}
	if MaskAPIKey("") != "" {
		t.Fatal("empty")
	}
}

func TestEnsureOpenAIRoot(t *testing.T) {
	cases := map[string]string{
		"https://aipool.aitoolbox.fyi":    "https://aipool.aitoolbox.fyi/v1",
		"https://aipool.aitoolbox.fyi/":   "https://aipool.aitoolbox.fyi/v1",
		"https://aipool.aitoolbox.fyi/v1": "https://aipool.aitoolbox.fyi/v1",
		"https://api.openai.com/v1":       "https://api.openai.com/v1",
		"http://127.0.0.1:8317/v1":        "http://127.0.0.1:8317/v1",
		"http://127.0.0.1:8317":           "http://127.0.0.1:8317/v1",
	}
	for in, want := range cases {
		got := Config{Kind: "openai-compatible", BaseURL: in, Model: "m"}.Normalize().BaseURL
		if got != want {
			t.Fatalf("%q → %q want %q", in, got, want)
		}
	}
}

func TestChatNonJSONHTTPError(t *testing.T) {
	// Single attempt: this case only checks error shaping, not retry policy.
	prevAttempts, prevBackoff := chatMaxAttempts, chatBackoffFn
	chatMaxAttempts = 1
	chatBackoffFn = func(int) time.Duration { return 0 }
	t.Cleanup(func() {
		chatMaxAttempts = prevAttempts
		chatBackoffFn = prevBackoff
	})

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(524)
		_, _ = w.Write([]byte("error code: 524"))
	}))
	t.Cleanup(srv.Close)

	cli, err := NewClient(Config{
		Kind:    "openai-compatible",
		BaseURL: srv.URL + "/v1",
		Model:   "m",
		APIKey:  "k",
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = cli.Chat(context.Background(), ChatRequest{
		Model:    "m",
		Messages: []Message{{Role: RoleUser, Content: "hi"}},
		Tools:    []ToolDef{FunctionTool("bash", "d", nil)},
	})
	if err == nil {
		t.Fatal("want error")
	}
	s := err.Error()
	if !strings.Contains(s, "HTTP 524") {
		t.Fatalf("want HTTP 524 in error, got %q", s)
	}
	if !strings.Contains(s, "gateway timeout") {
		t.Fatalf("want clear timeout hint, got %q", s)
	}
	// Must not look like a JSON decode of the gateway body.
	if strings.Contains(s, "invalid character") {
		t.Fatalf("should not wrap as JSON decode: %q", s)
	}
}

func TestChatRetriesTransientThenSucceeds(t *testing.T) {
	prevAttempts, prevBackoff := chatMaxAttempts, chatBackoffFn
	chatMaxAttempts = 5
	chatBackoffFn = func(int) time.Duration { return 0 }
	t.Cleanup(func() {
		chatMaxAttempts = prevAttempts
		chatBackoffFn = prevBackoff
	})

	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := hits.Add(1)
		if n < 3 {
			w.WriteHeader(524)
			_, _ = w.Write([]byte("error code: 524"))
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"model": "m",
			"choices": []map[string]any{
				{"finish_reason": "stop", "message": map[string]string{"role": "assistant", "content": "ok"}},
			},
			"usage": map[string]int{"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
		})
	}))
	t.Cleanup(srv.Close)

	cli, err := NewClient(Config{
		Kind:    "openai-compatible",
		BaseURL: srv.URL + "/v1",
		Model:   "m",
		APIKey:  "k",
	})
	if err != nil {
		t.Fatal(err)
	}

	var notifies atomic.Int32
	ctx := WithRetryNotify(context.Background(), func(attempt, max int, wait time.Duration, err error) {
		notifies.Add(1)
		if attempt < 1 || attempt >= max {
			t.Errorf("bad attempt %d max %d", attempt, max)
		}
		if err == nil {
			t.Error("expected err in notify")
		}
	})
	resp, err := cli.Chat(ctx, ChatRequest{
		Model:    "m",
		Messages: []Message{{Role: RoleUser, Content: "hi"}},
	})
	if err != nil {
		t.Fatalf("chat: %v", err)
	}
	if resp.Content != "ok" {
		t.Fatalf("content %q", resp.Content)
	}
	if hits.Load() != 3 {
		t.Fatalf("hits=%d want 3", hits.Load())
	}
	if notifies.Load() != 2 {
		t.Fatalf("notifies=%d want 2", notifies.Load())
	}
}

func TestChatRetriesExhausted(t *testing.T) {
	prevAttempts, prevBackoff := chatMaxAttempts, chatBackoffFn
	chatMaxAttempts = 5
	chatBackoffFn = func(int) time.Duration { return 0 }
	t.Cleanup(func() {
		chatMaxAttempts = prevAttempts
		chatBackoffFn = prevBackoff
	})

	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(524)
		_, _ = w.Write([]byte("error code: 524"))
	}))
	t.Cleanup(srv.Close)

	cli, err := NewClient(Config{
		Kind:    "openai-compatible",
		BaseURL: srv.URL + "/v1",
		Model:   "m",
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = cli.Chat(context.Background(), ChatRequest{
		Model:    "m",
		Messages: []Message{{Role: RoleUser, Content: "hi"}},
	})
	if err == nil {
		t.Fatal("want error")
	}
	if hits.Load() != 5 {
		t.Fatalf("hits=%d want 5", hits.Load())
	}
	s := err.Error()
	if !strings.Contains(s, "after 5 attempts") {
		t.Fatalf("want exhausted message, got %q", s)
	}
	if !strings.Contains(strings.ToLower(s), "timeout") && !strings.Contains(s, "524") {
		t.Fatalf("want timeout/524 in final error, got %q", s)
	}
}

func TestIsTransientProviderErr(t *testing.T) {
	ctx := context.Background()
	cases := []struct {
		err  string
		want bool
	}{
		{"provider HTTP 524 (https://aipool.aitoolbox.fyi/v1/chat/completions): gateway timeout — error code: 524", true},
		{"provider HTTP 502 (x): bad gateway", true},
		{"provider HTTP 429 (x): rate limited", true},
		{"provider request timeout https://x: context deadline exceeded", true},
		{"provider HTTP 401 (x): unauthorized", false},
		{"provider HTTP 400 (x): invalid tools", false},
		{"tools are not supported", false},
	}
	for _, c := range cases {
		got := isTransientProviderErr(ctx, errors.New(c.err))
		if got != c.want {
			t.Fatalf("%q: got %v want %v", c.err, got, c.want)
		}
	}
	// Parent ctx done → no retry even for timeout-shaped errors.
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	if isTransientProviderErr(canceled, errors.New("provider HTTP 524: x")) {
		t.Fatal("canceled parent should not retry")
	}
}
