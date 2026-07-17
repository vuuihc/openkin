package provider

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
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
		"https://api.openai.com/v1":      "https://api.openai.com/v1",
		"http://127.0.0.1:8317/v1":       "http://127.0.0.1:8317/v1",
		"http://127.0.0.1:8317":          "http://127.0.0.1:8317/v1",
	}
	for in, want := range cases {
		got := Config{Kind: "openai-compatible", BaseURL: in, Model: "m"}.Normalize().BaseURL
		if got != want {
			t.Fatalf("%q → %q want %q", in, got, want)
		}
	}
}
