// Package projectpulse builds deterministic project cover signals
// (session activity + optional git commit activity) for the One-Pager UI.
package projectpulse

import (
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/vuuihc/kin/internal/store"
)

// DayCount is activity for one calendar day (UTC date key YYYY-MM-DD).
type DayCount struct {
	Date  string `json:"date"`
	Count int    `json:"count"`
}

// Pulse is a dense, always-available cover strip.
type Pulse struct {
	ProjectID       string     `json:"project_id"`
	GeneratedAt     int64      `json:"generated_at"`
	WindowDays      int        `json:"window_days"`
	SessionTotal    int        `json:"session_total"`
	SessionWindow   int        `json:"session_window"`
	SessionsRunning int        `json:"sessions_running"`
	SessionsWaiting int        `json:"sessions_waiting"`
	LastSessionAt   int64      `json:"last_session_at,omitempty"`
	SessionHeat     []DayCount `json:"session_heat"`
	GitAvailable    bool       `json:"git_available"`
	GitRoot         string     `json:"git_root,omitempty"`
	CommitWindow    int        `json:"commit_window"`
	CommitHeat      []DayCount `json:"commit_heat,omitempty"`
	TopPaths        []PathStat `json:"top_paths,omitempty"`
	// AutoMarkdown is a managed block suitable for embedding under kin:auto markers.
	AutoMarkdown string `json:"auto_markdown"`
}

// PathStat is a rough "where work concentrated" hint from recent git.
type PathStat struct {
	Path  string `json:"path"`
	Count int    `json:"count"`
}

// Build constructs a pulse for a project from store + optional git.
func Build(ctx context.Context, st *store.Store, p store.Project, windowDays int) (Pulse, error) {
	if windowDays <= 0 {
		windowDays = 90
	}
	if windowDays > 366 {
		windowDays = 366
	}
	now := time.Now().UTC()
	out := Pulse{
		ProjectID:   p.ID,
		GeneratedAt: now.UnixMilli(),
		WindowDays:  windowDays,
	}

	tasks, err := st.ListTasksForProject(ctx, p.ID, p.Roots, 200)
	if err != nil {
		return out, err
	}
	out.SessionTotal = len(tasks)
	sessionHeat := map[string]int{}
	cutoff := now.AddDate(0, 0, -windowDays)
	for _, t := range tasks {
		switch t.Status {
		case "running", "queued":
			out.SessionsRunning++
		case "waiting_approval":
			out.SessionsWaiting++
		}
		ts := t.CreatedAt
		if t.FinishedAt != nil && *t.FinishedAt > ts {
			ts = *t.FinishedAt
		}
		if ts > out.LastSessionAt {
			out.LastSessionAt = ts
		}
		day := time.UnixMilli(ts).UTC()
		if day.Before(cutoff) {
			continue
		}
		out.SessionWindow++
		key := day.Format("2006-01-02")
		sessionHeat[key]++
	}
	out.SessionHeat = fillDays(sessionHeat, now, windowDays)

	root := firstRoot(p.Roots)
	if root != "" {
		if gr, ok := gitTopLevel(ctx, root); ok {
			out.GitAvailable = true
			out.GitRoot = gr
			commitHeat, top, n := gitActivity(ctx, gr, windowDays, now)
			out.CommitHeat = commitHeat
			out.TopPaths = top
			out.CommitWindow = n
		}
	}

	out.AutoMarkdown = renderAutoMarkdown(out, p)
	return out, nil
}

func firstRoot(roots []string) string {
	for _, r := range roots {
		r = strings.TrimSpace(r)
		if r != "" {
			return r
		}
	}
	return ""
}

func fillDays(m map[string]int, now time.Time, windowDays int) []DayCount {
	out := make([]DayCount, 0, windowDays)
	for i := windowDays - 1; i >= 0; i-- {
		d := now.AddDate(0, 0, -i).Format("2006-01-02")
		out = append(out, DayCount{Date: d, Count: m[d]})
	}
	return out
}

func gitTopLevel(ctx context.Context, dir string) (string, bool) {
	cmd := exec.CommandContext(ctx, "git", "-C", dir, "rev-parse", "--show-toplevel")
	out, err := cmd.Output()
	if err != nil {
		return "", false
	}
	return strings.TrimSpace(string(out)), true
}

func gitActivity(ctx context.Context, gitRoot string, windowDays int, now time.Time) (heat []DayCount, top []PathStat, total int) {
	since := fmt.Sprintf("%d.days", windowDays)
	// Dates
	cmd := exec.CommandContext(ctx, "git", "-C", gitRoot, "log", "--since="+since, "--pretty=format:%ad", "--date=short")
	out, err := cmd.Output()
	if err != nil {
		return fillDays(nil, now, windowDays), nil, 0
	}
	m := map[string]int{}
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		m[line]++
		total++
	}
	heat = fillDays(m, now, windowDays)

	// Path churn (name-only, capped)
	cmd = exec.CommandContext(ctx, "git", "-C", gitRoot, "log", "--since="+since, "--name-only", "--pretty=format:")
	out, err = cmd.Output()
	if err != nil {
		return heat, nil, total
	}
	pathCount := map[string]int{}
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "commit ") {
			continue
		}
		// normalize to top-level segment for module-ish hint
		seg := line
		if i := strings.IndexByte(line, '/'); i > 0 {
			seg = line[:i]
		}
		pathCount[seg]++
	}
	type kv struct {
		k string
		v int
	}
	var list []kv
	for k, v := range pathCount {
		list = append(list, kv{k, v})
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].v == list[j].v {
			return list[i].k < list[j].k
		}
		return list[i].v > list[j].v
	})
	if len(list) > 8 {
		list = list[:8]
	}
	for _, it := range list {
		top = append(top, PathStat{Path: it.k, Count: it.v})
	}
	return heat, top, total
}

func renderAutoMarkdown(p Pulse, proj store.Project) string {
	var b strings.Builder
	b.WriteString("## Pulse（自动）\n\n")
	fmt.Fprintf(&b, "- 窗口：最近 %d 天\n", p.WindowDays)
	fmt.Fprintf(&b, "- 会话：窗口内 %d · 全量列表 %d · 进行中 %d · 待批准 %d\n",
		p.SessionWindow, p.SessionTotal, p.SessionsRunning, p.SessionsWaiting)
	if p.LastSessionAt > 0 {
		fmt.Fprintf(&b, "- 最近会话：%s\n", time.UnixMilli(p.LastSessionAt).Local().Format("2006-01-02 15:04"))
	}
	if p.GitAvailable {
		fmt.Fprintf(&b, "- Git：%s · 窗口内提交 %d\n", filepath.Base(p.GitRoot), p.CommitWindow)
		if len(p.TopPaths) > 0 {
			b.WriteString("- 变动集中：")
			parts := make([]string, 0, len(p.TopPaths))
			for _, tp := range p.TopPaths {
				parts = append(parts, fmt.Sprintf("%s(%d)", tp.Path, tp.Count))
			}
			b.WriteString(strings.Join(parts, " · "))
			b.WriteString("\n")
		}
	} else {
		b.WriteString("- Git：不可用或非仓库\n")
	}
	b.WriteString("\n## 建议下一步（自动草稿）\n\n")
	b.WriteString(autoSuggestions(p, proj))
	return b.String()
}

func autoSuggestions(p Pulse, proj store.Project) string {
	var lines []string
	if p.SessionsWaiting > 0 {
		lines = append(lines, fmt.Sprintf("1. 处理 %d 个待批准会话，先清阻塞。", p.SessionsWaiting))
	}
	if p.SessionsRunning > 0 {
		lines = append(lines, fmt.Sprintf("%d. 查看进行中的会话，决定续跑或收工。", len(lines)+1))
	}
	if p.SessionWindow == 0 {
		lines = append(lines, fmt.Sprintf("%d. 本窗口几乎没有 Kin 会话：开一次「继续当前焦点」，把封面目标落到一次可检查的改动。", len(lines)+1))
	} else if p.SessionWindow >= 5 && p.CommitWindow == 0 && p.GitAvailable {
		lines = append(lines, fmt.Sprintf("%d. 会话很多但提交很少：把结论收成可提交增量，或更新封面说明「为何停在探索」。", len(lines)+1))
	}
	if len(p.TopPaths) > 0 {
		lines = append(lines, fmt.Sprintf("%d. 模块向：近期变动集中在 `%s` —— 为该模块写一条可验证的下一步。", len(lines)+1, p.TopPaths[0].Path))
		if len(p.TopPaths) > 1 {
			lines = append(lines, fmt.Sprintf("%d. 次模块 `%s`：是否需要单独会话��避免和主线缠在一起。", len(lines)+1, p.TopPaths[1].Path))
		}
	}
	// soft_progress enum is legacy metadata; prefer cover text over coaching taxonomy (ADR 0013).
	if len(lines) == 0 {
		lines = append(lines, fmt.Sprintf("%d. 更新封面「项目描述 / North Star / Current Focus」，写成一句话主线。", len(lines)+1))
	}
	if len(lines) == 0 {
		lines = append(lines, "1. 维护 Current Focus：只保留一条主线。")
		lines = append(lines, "2. 把最近会话里已成立的结论写进「结论」。")
		lines = append(lines, "3. 选一个小而可演示的下一步并开会话。")
	}
	// cap 6
	if len(lines) > 6 {
		lines = lines[:6]
	}
	return strings.Join(lines, "\n") + "\n"
}

// Auto markers wrap machine-maintained markdown inside ONE_PAGER.md.
const (
	AutoStart = "<!-- kin:auto:start -->"
	AutoEnd   = "<!-- kin:auto:end -->"
)

// MergeAutoSection replaces or appends the managed auto block in markdown.
func MergeAutoSection(markdown, autoBody string) string {
	md := strings.ReplaceAll(markdown, "\r\n", "\n")
	block := AutoStart + "\n\n" + strings.TrimSpace(autoBody) + "\n\n" + AutoEnd + "\n"
	start := strings.Index(md, AutoStart)
	end := strings.Index(md, AutoEnd)
	if start >= 0 && end > start {
		end += len(AutoEnd)
		// swallow trailing newline after end marker once
		rest := md[end:]
		if strings.HasPrefix(rest, "\n") {
			rest = rest[1:]
		}
		return strings.TrimRight(md[:start], "\n") + "\n\n" + block + strings.TrimLeft(rest, "\n")
	}
	// append
	md = strings.TrimRight(md, "\n") + "\n\n" + block
	return md
}
