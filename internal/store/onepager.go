package store

import (
	"fmt"
	"strings"
)

// OnePagerDigestMaxRunes is the default budget for project context injection.
const OnePagerDigestMaxRunes = 1200

// OnePagerSummary is a structured, bounded cover glance for UI and inject.
type OnePagerSummary struct {
	Name      string   `json:"name,omitempty"`
	Mode      string   `json:"mode,omitempty"`
	NorthStar string   `json:"north_star,omitempty"`
	Focus     string   `json:"focus,omitempty"`
	Next      []string `json:"next,omitempty"`
	Empty     bool     `json:"empty"`
}

// DefaultOnePagerMarkdown returns a mode-sensitive cover template.
// User-owned sections stay above the optional kin:auto block (filled by refresh).
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

	b.WriteString("## 项目描述\n")
	b.WriteString("这是什么、给谁用、边界在哪（3～8 行即可）。\n\n")

	b.WriteString("## North Star\n")
	b.WriteString("你为什么做这个项目（用户主权；刷新不会改这里）。\n\n")

	b.WriteString("## Current Focus\n")
	b.WriteString("当下唯一主线（越短越好）。\n\n")

	switch mode {
	case ProjectModeShip:
		b.WriteString("## 完成定义（Demo）\n")
		b.WriteString("怎样算今天有进展 / 可演示？\n\n")
	case ProjectModeLearn:
		b.WriteString("## Teach-back\n")
		b.WriteString("如果现在让我讲，我能讲到哪？\n\n")
		b.WriteString("## 仍模糊\n")
		b.WriteString("- \n\n")
	case ProjectModeExplore:
		b.WriteString("## 假设\n")
		b.WriteString("- \n\n")
		b.WriteString("## 已否决路径\n")
		b.WriteString("- \n\n")
	case ProjectModeMaintain:
		b.WriteString("## 健康与雷区\n")
		b.WriteString("- \n\n")
	}

	b.WriteString("## 结论\n")
	b.WriteString("- \n\n")

	b.WriteString("## 未决问题\n")
	b.WriteString("- \n\n")

	b.WriteString("## 下一步（你写的）\n")
	b.WriteString("1. \n2. \n3. \n\n")

	b.WriteString("## 模块笔记\n")
	b.WriteString("按目录/子系统随手记（可选）：\n\n")

	// Markers for managed auto content (pulse). User text above is never rewritten by refresh.
	b.WriteString("<!-- kin:auto:start -->\n")
	b.WriteString("## Pulse（自动）\n")
	b.WriteString("_点击「刷新封面」写入会话/提交活跃与建议下一步。_\n")
	b.WriteString("<!-- kin:auto:end -->\n")

	return b.String()
}

// ParseOnePagerSections splits markdown into H1 title (#) and ## section bodies.
func ParseOnePagerSections(md string) map[string]string {
	out := map[string]string{}
	var cur string
	var buf strings.Builder
	flush := func() {
		if cur == "" {
			return
		}
		out[cur] = strings.TrimSpace(buf.String())
		buf.Reset()
	}
	for _, line := range strings.Split(md, "\n") {
		if strings.HasPrefix(line, "# ") && !strings.HasPrefix(line, "## ") {
			flush()
			cur = "#"
			buf.WriteString(strings.TrimSpace(strings.TrimPrefix(line, "# ")))
			continue
		}
		if strings.HasPrefix(line, "## ") {
			flush()
			cur = strings.TrimSpace(strings.TrimPrefix(line, "## "))
			continue
		}
		if cur != "" {
			buf.WriteString(line)
			buf.WriteByte('\n')
		}
	}
	flush()
	return out
}

func sectionPick(sections map[string]string, names ...string) string {
	for _, name := range names {
		if v := strings.TrimSpace(sections[name]); v != "" {
			return v
		}
	}
	return ""
}

// ParseOnePagerSummary extracts bounded fields for UI glance and inject.
func ParseOnePagerSummary(md, projectName, mode string) OnePagerSummary {
	sections := ParseOnePagerSections(md)
	name := strings.TrimSpace(sectionPick(sections, "#"))
	if name == "" {
		name = strings.TrimSpace(projectName)
	}
	ns := cleanSummaryText(sectionPick(sections, "North Star"), 400)
	focus := cleanSummaryText(sectionPick(sections, "Current Focus", "当前焦点"), 300)
	nextRaw := sectionPick(sections, "下一步（你写的）", "Next", "下一步")
	next := ParseListItems(nextRaw, 3)

	// Drop placeholder-ish content so empty covers show as empty.
	if isPlaceholderText(ns) {
		ns = ""
	}
	if isPlaceholderText(focus) {
		focus = ""
	}
	filteredNext := make([]string, 0, len(next))
	for _, n := range next {
		if !isPlaceholderText(n) {
			filteredNext = append(filteredNext, n)
		}
	}
	empty := ns == "" && focus == "" && len(filteredNext) == 0
	return OnePagerSummary{
		Name:      name,
		Mode:      mode,
		NorthStar: ns,
		Focus:     focus,
		Next:      filteredNext,
		Empty:     empty,
	}
}

func isPlaceholderText(s string) bool {
	s = strings.TrimSpace(s)
	if s == "" || s == "-" || s == "—" {
		return true
	}
	// Default template phrases (zh/en short forms).
	placeholders := []string{
		"你为什么做这个项目",
		"当下唯一主线",
		"user owns",
		"why you are building",
		"single main thread",
	}
	lower := strings.ToLower(s)
	for _, p := range placeholders {
		if strings.Contains(lower, strings.ToLower(p)) {
			return true
		}
	}
	return false
}

func cleanSummaryText(s string, maxRunes int) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	// Collapse whitespace; keep one paragraph.
	parts := strings.Fields(s)
	s = strings.Join(parts, " ")
	return trimRunes(s, maxRunes)
}

// ParseListItems extracts bullet / numbered lines, skipping empties.
func ParseListItems(body string, max int) []string {
	if max <= 0 {
		max = 3
	}
	var out []string
	for _, line := range strings.Split(body, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		line = trimListMarker(line)
		line = strings.TrimSpace(line)
		if line == "" || line == "-" {
			continue
		}
		out = append(out, line)
		if len(out) >= max {
			break
		}
	}
	return out
}

func trimListMarker(line string) string {
	line = strings.TrimSpace(line)
	switch {
	case strings.HasPrefix(line, "- "):
		return strings.TrimSpace(line[2:])
	case strings.HasPrefix(line, "* "):
		return strings.TrimSpace(line[2:])
	case strings.HasPrefix(line, "+ "):
		return strings.TrimSpace(line[2:])
	}
	// Numbered: "1. ", "2) "
	i := 0
	for i < len(line) && line[i] >= '0' && line[i] <= '9' {
		i++
	}
	if i > 0 && i < len(line) {
		rest := strings.TrimSpace(line[i:])
		if strings.HasPrefix(rest, ".") || strings.HasPrefix(rest, ")") {
			rest = strings.TrimSpace(rest[1:])
			return rest
		}
	}
	return line
}

// CountListItems counts non-empty list items in a section body.
func CountListItems(body string) int {
	return len(ParseListItems(body, 1000))
}

// OnePagerDigest extracts a short inject block for Continue Focus / task create.
func OnePagerDigest(md string, maxRunes int) string {
	if maxRunes <= 0 {
		maxRunes = OnePagerDigestMaxRunes
	}
	sections := ParseOnePagerSections(md)

	var out strings.Builder
	if ns := sectionPick(sections, "North Star"); ns != "" && !isPlaceholderText(ns) {
		out.WriteString("North Star:\n")
		out.WriteString(trimRunes(ns, 400))
		out.WriteString("\n\n")
	}
	if f := sectionPick(sections, "Current Focus", "当前焦点"); f != "" && !isPlaceholderText(f) {
		out.WriteString("Current Focus:\n")
		out.WriteString(trimRunes(f, 300))
		out.WriteString("\n\n")
	}
	if d := sectionPick(sections, "项目描述", "What"); d != "" && !isPlaceholderText(d) {
		out.WriteString("Description:\n")
		out.WriteString(trimRunes(d, 300))
		out.WriteString("\n\n")
	}
	if n := sectionPick(sections, "下一步（你写的）", "Next", "下一步"); n != "" {
		items := ParseListItems(n, 3)
		if len(items) > 0 {
			out.WriteString("Next:\n")
			for i, it := range items {
				if isPlaceholderText(it) {
					continue
				}
				fmt.Fprintf(&out, "%d. %s\n", i+1, trimRunes(it, 200))
			}
		}
	}
	s := strings.TrimSpace(out.String())
	if s == "" {
		s = trimRunes(strings.TrimSpace(md), maxRunes)
	}
	return trimRunes(s, maxRunes)
}

// ModeStrategyLine is a single light inject hint. Detailed coaching belongs in
// the One-Pager / recipes (ADR 0013), not hard-coded mode taxonomies.
func ModeStrategyLine(mode string) string {
	mode = strings.TrimSpace(mode)
	if mode == "" {
		mode = ProjectModeShip
	}
	return "Mode focus: use cover Focus/Next; prefer the smallest useful next step (mode=" + mode + ")."
}

// BuildContinuePrompt wraps user intent with project context for new tasks.
func BuildContinuePrompt(projectName, mode, onePagerMarkdown, userPrompt string) string {
	userPrompt = strings.TrimSpace(userPrompt)
	summary := ParseOnePagerSummary(onePagerMarkdown, projectName, mode)
	var b strings.Builder
	b.WriteString("[Project context — living cover digest; user owns goals]\n")
	fmt.Fprintf(&b, "Project: %s\n", strings.TrimSpace(projectName))
	fmt.Fprintf(&b, "Mode: %s\n", mode)
	b.WriteString(ModeStrategyLine(mode))
	b.WriteByte('\n')
	if summary.NorthStar != "" {
		fmt.Fprintf(&b, "North Star: %s\n", summary.NorthStar)
	}
	if summary.Focus != "" {
		fmt.Fprintf(&b, "Current Focus: %s\n", summary.Focus)
	}
	if len(summary.Next) > 0 {
		b.WriteString("Next:\n")
		for i, n := range summary.Next {
			fmt.Fprintf(&b, "%d. %s\n", i+1, n)
		}
	}
	// Keep overall budget.
	ctx := trimRunes(strings.TrimSpace(b.String()), OnePagerDigestMaxRunes)
	var out strings.Builder
	out.WriteString(ctx)
	out.WriteString("\n---\n")
	if userPrompt != "" {
		out.WriteString(userPrompt)
	} else {
		out.WriteString("Continue the Current Focus. Prefer the smallest useful next step; do not rewrite the North Star unless I ask.")
	}
	return out.String()
}

func trimRunes(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max]) + "…"
}
