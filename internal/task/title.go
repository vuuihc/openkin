package task

import (
	"context"
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/vuuihc/kin/internal/provider"
)

// TitleMaxRunes is the soft cap for session titles (sidebar + notifications).
const TitleMaxRunes = 48

// titleSystemPrompt asks for a short chat title, no quotes/punctuation fluff.
const titleSystemPrompt = `You name chat sessions.
Return ONLY a short title for the user message (3–8 words, max ~48 characters).
Match the user language. No quotes, no trailing punctuation, no explanation.`

// TruncateTitle returns a one-line fallback title from the raw prompt.
// Prefer this when the provider is unavailable or the user supplied no title.
func TruncateTitle(prompt string, maxRunes int) string {
	if maxRunes <= 0 {
		maxRunes = TitleMaxRunes
	}
	s := strings.TrimSpace(prompt)
	if s == "" {
		return "New chat"
	}
	// First non-empty line only (multi-line prompts read poorly in the sidebar).
	if i := strings.IndexAny(s, "\r\n"); i >= 0 {
		s = strings.TrimSpace(s[:i])
		if s == "" {
			s = strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(prompt, "\r", " "), "\n", " "))
		}
	}
	s = strings.Join(strings.Fields(s), " ")
	if s == "" {
		return "New chat"
	}
	r := []rune(s)
	if len(r) <= maxRunes {
		return s
	}
	// Prefer cutting on a word boundary when the tail is Latin-ish.
	cut := maxRunes
	if cut > 8 {
		for i := cut; i > cut*2/3; i-- {
			if unicode.IsSpace(r[i-1]) {
				cut = i - 1
				break
			}
		}
	}
	return strings.TrimRight(string(r[:cut]), " 	,;:-") + "…"
}

// SummarizeTitle asks the cognition provider for a short session name.
// On any failure the caller should keep the fallback title.
func SummarizeTitle(ctx context.Context, client provider.Client, model, prompt string) (string, error) {
	if client == nil {
		return "", fmt.Errorf("no provider client")
	}
	prompt = strings.TrimSpace(prompt)
	if prompt == "" {
		return "", fmt.Errorf("empty prompt")
	}
	// Cap input so title gen stays cheap.
	in := prompt
	if utf8.RuneCountInString(in) > 800 {
		r := []rune(in)
		in = string(r[:800]) + "…"
	}
	maxTok := 48
	temp := 0.2
	resp, err := client.Chat(ctx, provider.ChatRequest{
		Model: model,
		Messages: []provider.Message{
			{Role: provider.RoleSystem, Content: titleSystemPrompt},
			{Role: provider.RoleUser, Content: in},
		},
		Temperature: &temp,
		MaxTokens:   &maxTok,
	})
	if err != nil {
		return "", err
	}
	title := cleanGeneratedTitle(resp.Content)
	if title == "" {
		return "", fmt.Errorf("empty title from provider")
	}
	return title, nil
}

func cleanGeneratedTitle(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	// First line only.
	if i := strings.IndexAny(s, "\r\n"); i >= 0 {
		s = strings.TrimSpace(s[:i])
	}
	// Strip common wrapping quotes / markdown bold.
	s = strings.Trim(s, " \"'`")
	s = strings.TrimPrefix(s, "**")
	s = strings.TrimSuffix(s, "**")
	s = strings.TrimSpace(s)
	// Drop trailing sentence punctuation (titles should feel like labels).
	s = strings.TrimRight(s, "。.!?！？;；")
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	// Hard cap after cleanup.
	return TruncateTitle(s, TitleMaxRunes)
}
