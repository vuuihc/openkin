// Sealed Context Pack — fixed-order slots for the cross-turn injection path
// (ADR 0002 Layer 1 / P1b). On overflow, older turns are compressed into a
// [Sealed summary] + [Session index] instead of being silently dropped, while
// the newest turns stay verbatim under [Recent turns].
//
// Section headers are byte-stable and always emitted in the same order so a
// follow-up that only grows [Recent turns] does not reshuffle the earlier
// slots (Policy K). True cross-turn persistence of a sealed segment is P1.5;
// this build re-derives the seal deterministically so identical inputs yield
// identical output.
package sessionctx

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

// SealIndexMaxTokens caps how many keyword tokens the session index carries.
const SealIndexMaxTokens = 12

// PackSections holds the fixed-order slots of a cross-turn Context Pack.
// Empty slots are omitted at render time; present headings stay byte-identical.
type PackSections struct {
	Index  string // [Session index] short keyword lines (stable once sealed)
	Pinned string // [Pinned] goals / decisions / key paths (caller-supplied)
	Sealed string // [Sealed summary] compressed older narrative
	Recent string // [Recent turns] newest verbatim digests (chronological)
}

// Render assembles the sections in the fixed ADR order, omitting empty slots.
func (p PackSections) Render() string {
	var b strings.Builder
	add := func(header, body string) {
		body = strings.TrimSpace(body)
		if body == "" {
			return
		}
		if b.Len() > 0 {
			b.WriteString("\n\n")
		}
		b.WriteString(header)
		b.WriteByte('\n')
		b.WriteString(body)
	}
	add("[Session index]", p.Index)
	add("[Pinned]", p.Pinned)
	add("[Sealed summary]", p.Sealed)
	add("[Recent turns]", p.Recent)
	return b.String()
}

// Empty reports whether the pack has no content in any slot.
func (p PackSections) Empty() bool {
	return strings.TrimSpace(p.Index) == "" &&
		strings.TrimSpace(p.Pinned) == "" &&
		strings.TrimSpace(p.Sealed) == "" &&
		strings.TrimSpace(p.Recent) == ""
}

// BuildSealedPack selects the newest lines that fit the Recent budget (verbatim,
// chronological) and seals any older overflow lines into a compressed summary
// plus a keyword index. pinned is passed through as-is (goals/decisions the
// caller wants to keep hot); pass "" when none.
func BuildSealedPack(lines []Line, opt PackOptions, pinned string) PackSections {
	opt = opt.Normalize()
	recent, olderIdx := selectRecent(lines, opt)
	sec := PackSections{
		Pinned: strings.TrimSpace(pinned),
		Recent: strings.Join(recent, "\n"),
	}
	if olderIdx > 0 {
		older := lines[:olderIdx]
		sec.Sealed = sealSummary(older, opt.MaxChars/2)
		sec.Index = sealIndex(older)
	}
	return sec
}

// selectRecent runs the newest-first budget selection used by BuildPack and
// additionally reports olderIdx: lines[:olderIdx] are the overflow (older)
// lines that did not fit and should be sealed. recent is returned chronological.
func selectRecent(lines []Line, opt PackOptions) (recent []string, olderIdx int) {
	opt = opt.Normalize()
	if len(lines) == 0 {
		return nil, 0
	}

	trimmed := make([]string, len(lines))
	for i, l := range lines {
		trimmed[i] = TruncateRunes(strings.TrimSpace(l.Text), opt.LineMaxChars)
	}

	var selected []string
	minIdx := len(trimmed) // smallest original index that was selected
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
			if len(selected) == 0 && opt.MaxChars > 32 {
				selected = append(selected, TruncateRunes(s, opt.MaxChars-1))
				minIdx = i
			}
			break
		}
		selected = append(selected, s)
		minIdx = i
		total += add
		if len(selected) >= opt.MaxLines {
			break
		}
	}

	// selected is newest→oldest; reverse for chronological order.
	for i, j := 0, len(selected)-1; i < j; i, j = i+1, j-1 {
		selected[i], selected[j] = selected[j], selected[i]
	}
	if minIdx >= len(trimmed) {
		minIdx = len(trimmed) // nothing selected → everything is "older"? no seal target
	}
	return selected, minIdx
}

// sealSummary extractively compresses older lines: a short chronological head
// plus high-signal lines (paths, verdicts, decisions), under a rune budget.
func sealSummary(older []Line, maxRunes int) string {
	if len(older) == 0 {
		return ""
	}
	if maxRunes <= 0 {
		maxRunes = DefaultMaxChars / 2
	}

	seen := map[string]bool{}
	var picked []string
	add := func(text string) {
		text = TruncateRunes(oneLine(strings.TrimSpace(text)), DefaultLineMaxChars)
		if text == "" || seen[text] {
			return
		}
		seen[text] = true
		picked = append(picked, text)
	}

	const headKeep = 3
	for i, l := range older {
		if i >= headKeep {
			break
		}
		add(l.Text)
	}
	for _, l := range older {
		if isSignalLine(l.Text) {
			add(l.Text)
		}
	}

	head := fmt.Sprintf("(%d earlier turns sealed)", len(older))
	body := strings.Join(picked, "\n")
	out := head
	if body != "" {
		out += "\n" + body
	}
	return TruncateRunes(out, maxRunes)
}

// sealIndex collects unique path-like keyword tokens from older lines so the
// agent can re-retrieve detail (Layer 4). First-seen order, deterministic.
func sealIndex(older []Line) string {
	seen := map[string]bool{}
	var toks []string
	for _, l := range older {
		for _, m := range rePathish.FindAllString(l.Text, -1) {
			m = strings.Trim(m, ".,;:)(")
			if m == "" || seen[m] || utf8.RuneCountInString(m) < 3 {
				continue
			}
			seen[m] = true
			toks = append(toks, m)
			if len(toks) >= SealIndexMaxTokens {
				break
			}
		}
		if len(toks) >= SealIndexMaxTokens {
			break
		}
	}
	if len(toks) == 0 {
		return ""
	}
	return "keys: " + strings.Join(toks, ", ")
}
