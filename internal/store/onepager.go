package store

import (
	"fmt"
	"strings"
)

// DefaultOnePagerMarkdown returns a mode-specific One-Pager template.
// name is the project display name.
func DefaultOnePagerMarkdown(name, mode string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		name = "Untitled project"
	}
	if !ValidProjectMode(mode) {
		mode = ProjectModeShip
	}

	var b strings.Builder
	fmt.Fprintf(&b, "# %s\n\n", name)
	b.WriteString("## What\n")
	b.WriteString("一句话：这是什么。\n\n")
	b.WriteString("## North Star\n")
	b.WriteString("用你自己的话写目标（可随时改；Agent 不应擅自覆盖）。\n\n")
	b.WriteString("## Current Focus\n")
	b.WriteString("当下唯一主线（越短越好）。\n\n")
	b.WriteString("## Conclusions\n")
	b.WriteString("- \n\n")
	b.WriteString("## Open questions\n")
	b.WriteString("- \n\n")
	b.WriteString("## Next\n")
	b.WriteString("1. \n")
	b.WriteString("2. \n")
	b.WriteString("3. \n\n")
	b.WriteString("## Evidence\n")
	b.WriteString("- （相关 sessions / artifacts 可写在这里）\n")

	switch mode {
	case ProjectModeShip:
		b.WriteString("\n## Definition of done (demo)\n")
		b.WriteString("怎样算「今天有进展 / 可演示」？\n\n")
		b.WriteString("## Risks\n")
		b.WriteString("- \n")
	case ProjectModeLearn:
		b.WriteString("\n## Understood\n")
		b.WriteString("- \n\n")
		b.WriteString("## Still fuzzy\n")
		b.WriteString("- \n\n")
		b.WriteString("## Teach-back\n")
		b.WriteString("如果现在让我讲，我能讲到哪？（5～10 行）\n\n")
	case ProjectModeExplore:
		b.WriteString("\n## Hypotheses\n")
		b.WriteString("- \n\n")
		b.WriteString("## Rejected paths\n")
		b.WriteString("- \n\n")
		b.WriteString("## Signals to deepen\n")
		b.WriteString("- \n")
	case ProjectModeMaintain:
		b.WriteString("\n## Health\n")
		b.WriteString("- \n\n")
		b.WriteString("## Footguns\n")
		b.WriteString("- \n\n")
		b.WriteString("## Do not touch\n")
		b.WriteString("- \n")
	}
	return b.String()
}

// OnePagerDigest extracts a short inject block for Continue Focus.
// Keeps size bounded for prompt packing (ADR 0002).
func OnePagerDigest(markdown string, maxRunes int) string {
	if maxRunes <= 0 {
		maxRunes = 1200
	}
	md := strings.ReplaceAll(markdown, "\r\n", "\n")
	sections := map[string]string{}
	var current string
	var buf strings.Builder
	flush := func() {
		if current == "" {
			return
		}
		sections[current] = strings.TrimSpace(buf.String())
		buf.Reset()
	}
	for _, line := range strings.Split(md, "\n") {
		if strings.HasPrefix(line, "## ") {
			flush()
			current = strings.TrimSpace(strings.TrimPrefix(line, "## "))
			continue
		}
		if current != "" {
			buf.WriteString(line)
			buf.WriteByte('\n')
		}
	}
	flush()

	pick := func(name string) string {
		v := strings.TrimSpace(sections[name])
		// drop placeholder-ish first lines only if entire section is tiny
		return v
	}

	var out strings.Builder
	if ns := pick("North Star"); ns != "" {
		out.WriteString("North Star:\n")
		out.WriteString(trimRunes(ns, 400))
		out.WriteString("\n\n")
	}
	if f := pick("Current Focus"); f != "" {
		out.WriteString("Current Focus:\n")
		out.WriteString(trimRunes(f, 300))
		out.WriteString("\n\n")
	}
	if n := pick("Next"); n != "" {
		out.WriteString("Next:\n")
		out.WriteString(trimRunes(n, 400))
		out.WriteString("\n")
	}
	s := strings.TrimSpace(out.String())
	if s == "" {
		// fallback: head of document
		s = trimRunes(strings.TrimSpace(md), maxRunes)
	}
	return trimRunes(s, maxRunes)
}

func trimRunes(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max]) + "…"
}

// BuildContinuePrompt wraps user intent with project context for new tasks.
func BuildContinuePrompt(projectName, mode, onePagerMarkdown, userPrompt string) string {
	userPrompt = strings.TrimSpace(userPrompt)
	digest := OnePagerDigest(onePagerMarkdown, 1200)
	var b strings.Builder
	b.WriteString("[Project context — living One-Pager digest; user owns goals]\n")
	fmt.Fprintf(&b, "Project: %s | mode: %s\n\n", strings.TrimSpace(projectName), mode)
	if digest != "" {
		b.WriteString(digest)
		b.WriteString("\n")
	}
	b.WriteString("---\n")
	if userPrompt != "" {
		b.WriteString(userPrompt)
	} else {
		b.WriteString("Continue the Current Focus. Prefer the smallest useful next step; do not rewrite the North Star unless I ask.")
	}
	return b.String()
}
