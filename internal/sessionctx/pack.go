// Package sessionctx builds budget-aware conversation packs for Kin follow-ups
// and agent prompts. Full history stays in the event store; models only see a pack.
//
// See docs/adr/0002-context-management.md.
package sessionctx

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

// Defaults for v0 char-proxy budgets (not true tokenizer counts).
const (
	DefaultMaxChars     = 12_000
	DefaultMaxLines     = 40
	DefaultLineMaxChars = 800
)

// Line is one transcript line already role-tagged (e.g. "user: …").
type Line struct {
	// Text is the full line including role prefix when present.
	Text string
	// Seq is optional event order (higher = newer). Zero means unknown;
	// callers should pass lines oldest→newest so slice order is chronological.
	Seq int
}

// PackOptions controls BuildPack.
type PackOptions struct {
	// MaxChars is the hard cap for the assembled pack body (excluding live user request).
	MaxChars int
	// MaxLines caps how many source lines may enter the pack.
	MaxLines int
	// LineMaxChars truncates each individual line (runes).
	LineMaxChars int
}

// Normalize applies defaults.
func (o PackOptions) Normalize() PackOptions {
	if o.MaxChars <= 0 {
		o.MaxChars = DefaultMaxChars
	}
	if o.MaxLines <= 0 {
		o.MaxLines = DefaultMaxLines
	}
	if o.LineMaxChars <= 0 {
		o.LineMaxChars = DefaultLineMaxChars
	}
	return o
}

// BuildPack selects the newest lines that fit the budget and returns them in
// chronological order (oldest → newest) for prompt injection.
//
// Critical: packing is newest-first so adjacent recent turns survive overflow.
func BuildPack(lines []Line, opt PackOptions) string {
	opt = opt.Normalize()
	if len(lines) == 0 {
		return ""
	}

	// Work on a copy of texts, truncated per line.
	trimmed := make([]string, len(lines))
	for i, l := range lines {
		trimmed[i] = TruncateRunes(strings.TrimSpace(l.Text), opt.LineMaxChars)
	}

	// Newest-first selection.
	var selected []string
	total := 0
	for i := len(trimmed) - 1; i >= 0; i-- {
		s := trimmed[i]
		if s == "" {
			continue
		}
		add := len(s)
		if len(selected) > 0 {
			add++ // newline
		}
		if total+add > opt.MaxChars {
			// Try to fit a head slice of this line if nothing selected yet.
			if len(selected) == 0 && opt.MaxChars > 32 {
				selected = append(selected, TruncateRunes(s, opt.MaxChars-1))
			}
			break
		}
		selected = append(selected, s)
		total += add
		if len(selected) >= opt.MaxLines {
			break
		}
	}

	// selected is newest→oldest; reverse for chronological prompt order.
	for i, j := 0, len(selected)-1; i < j; i, j = i+1, j-1 {
		selected[i], selected[j] = selected[j], selected[i]
	}
	return strings.Join(selected, "\n")
}

// TruncateRunes soft-caps s to n runes with an ellipsis.
func TruncateRunes(s string, n int) string {
	if n <= 0 {
		return ""
	}
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	if n == 1 {
		return "…"
	}
	return string(r[:n-1]) + "…"
}

// EstimateChars is a cheap size proxy for message lists (runes ≈ tokens/2-ish).
func EstimateChars(parts ...string) int {
	n := 0
	for _, p := range parts {
		n += utf8.RuneCountInString(p)
	}
	return n
}

// CollapseToolPayload shortens a tool result for older loop turns.
func CollapseToolPayload(name, output string, max int) string {
	if max <= 0 {
		max = 240
	}
	out := strings.TrimSpace(output)
	if out == "" {
		return "(empty)"
	}
	lines := strings.Count(out, "\n") + 1
	head := TruncateRunes(oneLine(out), max)
	if name != "" {
		return fmt.Sprintf("%s → %s [%d lines; full output dropped from context]", name, head, lines)
	}
	return fmt.Sprintf("%s [%d lines; full output dropped from context]", head, lines)
}

func oneLine(s string) string {
	s = strings.ReplaceAll(s, "\n", " ")
	return strings.Join(strings.Fields(s), " ")
}
