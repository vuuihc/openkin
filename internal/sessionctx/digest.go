// ToolDigest / WorkerDigest — compact-on-entry for the main agent path (ADR 0002 Policy C).
// Full tool/worker payloads stay in SQLite events; only digests enter model messages.
package sessionctx

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"
)

// Digest budgets (char/rune proxies; tunable later via settings).
const (
	BashDigestMaxChars    = 4_000
	BashDigestMaxLines    = 40
	ReadDigestMaxChars    = 4_000
	ReadDigestMaxLines    = 120
	ListDigestMaxEntries  = 40
	GlobDigestMaxMatches  = 40
	UnknownDigestMaxChars = 1_000
	// WorkerDigestMaxRunes caps each worker's contribution to the main chat.
	WorkerDigestMaxRunes = 1_800
)

// ToolDigest builds a deterministic, budgeted digest of a tool result for the
// main agent messages path. Templates are stable so similar tools yield similar shapes.
//
// ok is the tool-level success flag (false when the tool returned an error).
// argsJSON is the raw tool-call arguments (used for command/path one-liners).
func ToolDigest(name, argsJSON, output string, ok bool) string {
	name = strings.TrimSpace(name)
	out := strings.TrimRight(output, "\n")
	if out == "" {
		out = "(empty)"
	}
	status := "ok"
	if !ok {
		status = "error"
	}

	switch name {
	case "bash":
		return digestBash(argsJSON, out, status)
	case "read_file":
		return digestReadFile(argsJSON, out, status)
	case "write_file":
		// write_file already returns a short confirmation; keep as-is under a soft cap.
		return fmt.Sprintf("write_file [%s]: %s", status, TruncateRunes(oneLine(out), 240))
	case "list_dir":
		return digestListOrGlob("list_dir", argsJSON, out, status, ListDigestMaxEntries, "entries")
	case "glob":
		return digestListOrGlob("glob", argsJSON, out, status, GlobDigestMaxMatches, "matches")
	default:
		head := TruncateRunes(out, UnknownDigestMaxChars)
		if name == "" {
			name = "tool"
		}
		return fmt.Sprintf("%s [%s]:\n%s", name, status, head)
	}
}

func digestBash(argsJSON, out, status string) string {
	cmd := jsonStringField(argsJSON, "command")
	cmdOne := TruncateRunes(oneLine(cmd), 160)
	if cmdOne == "" {
		cmdOne = "(no command)"
	}

	// Prefer the tail of large logs (errors/summaries usually land last).
	body := tailLines(out, BashDigestMaxLines, BashDigestMaxChars)
	// Collapse long runs of identical lines (e.g. repeated progress).
	body = collapseRepeatedLines(body)

	// Surface high-signal snippets even if they fell outside the pure tail window.
	signals := extractSignalLines(out, 8)
	var b strings.Builder
	fmt.Fprintf(&b, "bash [%s] $ %s\n", status, cmdOne)
	if body != "" && body != "(empty)" {
		b.WriteString(body)
	}
	if len(signals) > 0 {
		var extra []string
		for _, s := range signals {
			if !strings.Contains(body, s) {
				extra = append(extra, s)
			}
		}
		if len(extra) > 0 {
			if b.Len() > 0 && !strings.HasSuffix(b.String(), "\n") {
				b.WriteByte('\n')
			}
			b.WriteString("… signals: ")
			b.WriteString(strings.Join(extra, " | "))
		}
	}
	return strings.TrimRight(b.String(), "\n")
}

func digestReadFile(argsJSON, out, status string) string {
	path := jsonStringField(argsJSON, "path")
	if path == "" {
		path = "(unknown path)"
	}
	lineN := 0
	if out != "" && out != "(empty)" {
		lineN = strings.Count(out, "\n") + 1
	}
	byteN := len(out)

	// Small files: pass through under budget.
	if utf8.RuneCountInString(out) <= ReadDigestMaxChars && lineN <= ReadDigestMaxLines {
		return fmt.Sprintf("read_file [%s] %s (%d lines):\n%s", status, path, lineN, out)
	}

	// Large files: focused head excerpt + pointer to re-read.
	excerpt := headLines(out, ReadDigestMaxLines/2, ReadDigestMaxChars)
	var b strings.Builder
	fmt.Fprintf(&b, "read_file [%s] %s (~%d lines, %d bytes shown truncated)\n", status, path, lineN, byteN)
	b.WriteString(excerpt)
	if !strings.HasSuffix(excerpt, "\n") {
		b.WriteByte('\n')
	}
	b.WriteString("… note: full file not in context; re-read with a narrower path/range if needed")
	return b.String()
}

func digestListOrGlob(name, argsJSON, out, status string, maxN int, unit string) string {
	label := jsonStringField(argsJSON, "path")
	if label == "" {
		label = jsonStringField(argsJSON, "pattern")
	}
	if label == "" {
		label = "."
	}

	if out == "(empty)" || out == "(no matches)" || out == "(no output)" {
		return fmt.Sprintf("%s [%s] %s: %s", name, status, label, out)
	}

	lines := splitNonEmptyLines(out)
	clean := make([]string, 0, len(lines))
	for _, ln := range lines {
		if strings.HasPrefix(ln, "…") {
			continue
		}
		clean = append(clean, ln)
	}
	total := len(clean)
	show := clean
	if len(show) > maxN {
		show = show[:maxN]
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%s [%s] %s: %d %s", name, status, label, total, unit)
	if total > len(show) {
		fmt.Fprintf(&b, " (showing first %d, +%d more)", len(show), total-len(show))
	}
	b.WriteByte('\n')
	b.WriteString(strings.Join(show, "\n"))
	return b.String()
}

// WorkerDigest compresses a worker's full answer into key findings for the
// main agent / main chat (Policy C). prior is typically "[Agent Label]\n<body>".
// failed marks the worker outcome.
func WorkerDigest(prior string, failed bool) string {
	prior = strings.TrimSpace(prior)
	if prior == "" {
		if failed {
			return "_worker failed (no text)_"
		}
		return "_no text_"
	}

	agent, body := splitWorkerPrior(prior)
	outcome := "ok"
	if failed {
		outcome = "failed"
	}

	findings := extractiveFindings(body, WorkerDigestMaxRunes)
	var b strings.Builder
	if agent != "" {
		fmt.Fprintf(&b, "[%s] (%s)\n", agent, outcome)
	} else {
		fmt.Fprintf(&b, "(%s)\n", outcome)
	}
	b.WriteString(findings)
	// Pointer for recoverability (full text remains in events).
	if utf8.RuneCountInString(body) > WorkerDigestMaxRunes {
		b.WriteString("\n… details in task log / session_search")
	}
	return strings.TrimSpace(b.String())
}

func splitWorkerPrior(prior string) (agent, body string) {
	if strings.HasPrefix(prior, "[") {
		if i := strings.Index(prior, "]\n"); i >= 0 {
			return prior[1:i], strings.TrimSpace(prior[i+2:])
		}
		if i := strings.Index(prior, "]"); i >= 0 {
			rest := strings.TrimSpace(prior[i+1:])
			return prior[1:i], rest
		}
	}
	return "", prior
}

// extractiveFindings picks high-signal lines (paths, test verdicts, errors,
// headings) plus a short head, under a rune budget.
func extractiveFindings(body string, maxRunes int) string {
	body = strings.TrimSpace(body)
	if body == "" {
		return "(empty)"
	}
	if utf8.RuneCountInString(body) <= maxRunes {
		return body
	}

	lines := strings.Split(body, "\n")
	const headKeep = 6
	var picked []string
	seen := map[string]bool{}
	add := func(ln string) {
		ln = strings.TrimRight(ln, "\r")
		key := strings.TrimSpace(ln)
		if key == "" || seen[key] {
			return
		}
		seen[key] = true
		picked = append(picked, ln)
	}

	for i, ln := range lines {
		if i >= headKeep {
			break
		}
		add(ln)
	}
	for _, ln := range lines {
		if isSignalLine(ln) {
			add(ln)
		}
	}

	out := strings.Join(picked, "\n")
	if utf8.RuneCountInString(out) >= maxRunes {
		return TruncateRunes(out, maxRunes)
	}

	// Append more non-signal lines until budget.
	for i, ln := range lines {
		if i < headKeep || isSignalLine(ln) {
			continue
		}
		candidate := out
		if candidate != "" {
			candidate += "\n"
		}
		candidate += ln
		if utf8.RuneCountInString(candidate) > maxRunes {
			break
		}
		out = candidate
		add(ln)
	}
	if out == "" {
		return TruncateRunes(body, maxRunes)
	}
	return TruncateRunes(out, maxRunes)
}

var (
	reFailPass  = regexp.MustCompile(`(?i)\b(FAIL|FAILED|PASS|PASSED|ERROR|panic:|FATAL)\b|[✓✗]`)
	rePathish   = regexp.MustCompile(`(?:[A-Za-z0-9_.@-]+/)+[A-Za-z0-9_.@-]+`)
	reRecommend = regexp.MustCompile(`(?i)^\s*(?:[-*•]|\d+\.)\s+|^(?:recommendation|建议|结论|summary|findings)\b`)
)

func isSignalLine(ln string) bool {
	s := strings.TrimSpace(ln)
	if s == "" {
		return false
	}
	if reFailPass.MatchString(s) {
		return true
	}
	if reRecommend.MatchString(s) {
		return true
	}
	if rePathish.MatchString(s) {
		return true
	}
	lower := strings.ToLower(s)
	for _, ext := range []string{".go", ".ts", ".tsx", ".js", ".py", ".md", ".json", ".yaml", ".yml"} {
		if strings.Contains(lower, ext) {
			return true
		}
	}
	if strings.HasPrefix(s, "#") || strings.HasPrefix(s, "**") {
		return true
	}
	return false
}

func extractSignalLines(out string, max int) []string {
	var found []string
	for _, ln := range strings.Split(out, "\n") {
		if !isSignalLine(ln) {
			continue
		}
		s := TruncateRunes(oneLine(ln), 120)
		if s == "" {
			continue
		}
		found = append(found, s)
		if len(found) >= max {
			break
		}
	}
	return found
}

func headLines(s string, maxLines, maxChars int) string {
	if maxLines <= 0 {
		maxLines = 40
	}
	if maxChars <= 0 {
		maxChars = 4_000
	}
	lines := strings.Split(s, "\n")
	if len(lines) > maxLines {
		lines = lines[:maxLines]
	}
	out := strings.Join(lines, "\n")
	return TruncateRunes(out, maxChars)
}

func tailLines(s string, maxLines, maxChars int) string {
	if maxLines <= 0 {
		maxLines = 40
	}
	if maxChars <= 0 {
		maxChars = 4_000
	}
	s = strings.TrimRight(s, "\n")
	if s == "" {
		return "(empty)"
	}
	lines := strings.Split(s, "\n")
	trimmedLines := false
	if len(lines) > maxLines {
		lines = lines[len(lines)-maxLines:]
		trimmedLines = true
	}
	out := strings.Join(lines, "\n")
	// If still over char budget, keep the rune tail (not head).
	if utf8.RuneCountInString(out) > maxChars {
		r := []rune(out)
		out = string(r[len(r)-maxChars:])
		// Avoid partial first line after slicing.
		if i := strings.IndexByte(out, '\n'); i >= 0 && i+1 < len(out) {
			out = out[i+1:]
		}
		out = "…\n" + out
	}
	if trimmedLines {
		out = "… (tail)\n" + out
	}
	return out
}

func collapseRepeatedLines(s string) string {
	lines := strings.Split(s, "\n")
	if len(lines) < 4 {
		return s
	}
	var out []string
	i := 0
	for i < len(lines) {
		j := i + 1
		for j < len(lines) && lines[j] == lines[i] {
			j++
		}
		rep := j - i
		if rep > 2 {
			out = append(out, lines[i])
			out = append(out, fmt.Sprintf("… (%d identical lines omitted)", rep-1))
		} else {
			for k := i; k < j; k++ {
				out = append(out, lines[k])
			}
		}
		i = j
	}
	return strings.Join(out, "\n")
}

func splitNonEmptyLines(s string) []string {
	raw := strings.Split(s, "\n")
	out := make([]string, 0, len(raw))
	for _, ln := range raw {
		if strings.TrimSpace(ln) == "" {
			continue
		}
		out = append(out, ln)
	}
	return out
}

func jsonStringField(argsJSON, key string) string {
	argsJSON = strings.TrimSpace(argsJSON)
	if argsJSON == "" || key == "" {
		return ""
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(argsJSON), &m); err != nil {
		return ""
	}
	if v, ok := m[key].(string); ok {
		return strings.TrimSpace(v)
	}
	return ""
}

// FormatPackSections wraps packed recent turns in stable section headers
// (Policy K: fixed template). Empty sealed/pinned/index slots are omitted so
// cold starts stay short; headings that are present stay byte-stable.
//
// Kept for the recent-only path; the sealed path uses BuildSealedPack +
// PackSections.Render (same headers, same order).
func FormatPackSections(recent string) string {
	return PackSections{Recent: recent}.Render()
}
