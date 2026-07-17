package task

import (
	"context"
	"strings"
	"testing"

	"github.com/vuuihc/kin/internal/provider"
)

func TestTruncateTitle(t *testing.T) {
	if got := TruncateTitle("  hello world  ", 80); got != "hello world" {
		t.Fatalf("got %q", got)
	}
	if got := TruncateTitle("line1\nline2", 80); got != "line1" {
		t.Fatalf("first line: %q", got)
	}
	long := strings.Repeat("你好", 40) // 80 runes
	got := TruncateTitle(long, 48)
	if !strings.HasSuffix(got, "…") {
		t.Fatalf("want ellipsis, got %q", got)
	}
	// Rune-aware: 48 runes of content + ellipsis, not 48 bytes.
	r := []rune(strings.TrimSuffix(got, "…"))
	if len(r) > 48 {
		t.Fatalf("too long: %d runes in %q", len(r), got)
	}
	if got := TruncateTitle("", 10); got != "New chat" {
		t.Fatalf("empty: %q", got)
	}
}

func TestCleanGeneratedTitle(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{`"Fix auth tests"`, "Fix auth tests"},
		{"**修复登录测试**\nextra", "修复登录测试"},
		{"Summarize the repo.", "Summarize the repo"},
		{"  'hello'  ", "hello"},
	}
	for _, c := range cases {
		if got := cleanGeneratedTitle(c.in); got != c.want {
			t.Fatalf("clean(%q)=%q want %q", c.in, got, c.want)
		}
	}
}

type stubClient struct {
	content string
	err     error
}

func (s *stubClient) Chat(ctx context.Context, req provider.ChatRequest) (*provider.ChatResponse, error) {
	if s.err != nil {
		return nil, s.err
	}
	return &provider.ChatResponse{Content: s.content, Model: "stub"}, nil
}
func (s *stubClient) Kind() string         { return "stub" }
func (s *stubClient) ModelDefault() string { return "stub" }

func TestSummarizeTitle(t *testing.T) {
	ctx := context.Background()
	got, err := SummarizeTitle(ctx, &stubClient{content: `"Fix flaky auth test"`}, "m", "please fix the flaky auth test and add regression")
	if err != nil {
		t.Fatal(err)
	}
	if got != "Fix flaky auth test" {
		t.Fatalf("got %q", got)
	}
	if _, err := SummarizeTitle(ctx, &stubClient{content: "   "}, "m", "x"); err == nil {
		t.Fatal("expected empty title error")
	}
	if _, err := SummarizeTitle(ctx, nil, "m", "x"); err == nil {
		t.Fatal("expected nil client error")
	}
}
