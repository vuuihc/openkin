package task

import (
	"regexp"
	"strings"
)

// Coding worker agent preference (lower index = preferred).
var codingAgentOrder = []string{"claude-code", "codex", "grok"}

// LooksLikeCodingTask is a heuristic: should bare (no @) prompts be auto-dispatched
// to a coding agent that actually has a tool/agent loop, instead of one-shot chat.
func LooksLikeCodingTask(prompt string) bool {
	p := strings.TrimSpace(prompt)
	if p == "" {
		return false
	}
	// Explicit pure-chat markers.
	if pureChatRE.MatchString(p) && !actionRE.MatchString(p) {
		return false
	}

	score := 0
	lower := strings.ToLower(p)

	if actionRE.MatchString(p) {
		score += 3
	}
	if codeArtifactRE.MatchString(p) {
		score += 2
	}
	if pathOrFileRE.MatchString(p) {
		score += 2
	}
	if errorishRE.MatchString(lower) {
		score += 2
	}
	if repoishRE.MatchString(lower) {
		score += 1
	}
	// Long imperative prompts tend to be work orders.
	if len([]rune(p)) > 80 && actionRE.MatchString(p) {
		score += 1
	}

	// Conceptual Q&A without action → chat.
	if conceptRE.MatchString(p) && score < 4 {
		return false
	}

	return score >= 3
}

// CodingAgents returns registered coding worker ids in preference order.
func (e *Engine) CodingAgents() []string {
	var out []string
	for _, id := range codingAgentOrder {
		if e.HasAgent(id) {
			out = append(out, id)
		}
	}
	return out
}

// DefaultCodingAgent is the preferred worker for auto-orchestration, or "".
func (e *Engine) DefaultCodingAgent() string {
	cs := e.CodingAgents()
	if len(cs) == 0 {
		return ""
	}
	return cs[0]
}

// AutoCodingPlan builds a single-step (or implement→review) plan when the user
// did not @-mention agents but the prompt looks like programming work.
func (e *Engine) AutoCodingPlan(prompt string) (DelegatePlan, bool) {
	if !LooksLikeCodingTask(prompt) {
		return DelegatePlan{}, false
	}
	workers := e.CodingAgents()
	if len(workers) == 0 {
		return DelegatePlan{}, false
	}

	primary := workers[0]
	plan := DelegatePlan{
		Raw:      prompt,
		Overview: strings.TrimSpace(prompt),
		Steps: []DelegateStep{
			{
				Agent:       primary,
				Instruction: strings.TrimSpace(prompt),
				Mention:     "auto",
			},
		},
	}

	// Optional second pass: review/verify when two coding CLIs exist and the
	// prompt looks substantial (not a one-line tweak).
	if len(workers) >= 2 && looksLikeNeedsReview(prompt) {
		reviewer := workers[1]
		if reviewer == primary && len(workers) > 2 {
			reviewer = workers[2]
		}
		if reviewer != primary {
			plan.Steps = append(plan.Steps, DelegateStep{
				Agent: reviewer,
				Instruction: "根据上一 agent 的工作结果做代码审查与验收：指出问题、确认是否完成用户目标，并给出简短总结。" +
					"不要重复实现整套方案，除非发现严重缺陷必须修。",
				Mention: "auto-review",
			})
		}
	}

	return plan, true
}

func looksLikeNeedsReview(prompt string) bool {
	if reviewRE.MatchString(prompt) {
		return true
	}
	// Longer work orders get a free review pass when two agents are free.
	return len([]rune(strings.TrimSpace(prompt))) >= 60
}

var (
	actionRE = regexp.MustCompile(`(?i)(` +
		`fix|implement|add|create|write|refactor|debug|repair|resolve|` +
		`patch|migrate|deploy|ship|build|test|lint|typecheck|compile|` +
		`optimize|perf|rewrite|delete|remove|rename|move|merge|rebase|` +
		`investigate|trace|profile|benchmark|` +
		`修|改|实现|添加|新增|写|重构|调试|排查|定位|解决|修复|` +
		`跑测|单测|集成测|编译|构建|部署|上线|迁移|优化|删|重命名` +
		`)`)

	codeArtifactRE = regexp.MustCompile(`(?i)(` +
		`\.(go|ts|tsx|js|jsx|py|rs|java|kt|swift|c|cc|cpp|h|hpp|rb|php|` +
		`cs|vue|svelte|css|scss|html|md|json|ya?ml|toml|sql|sh|bash|zsh)|` +
		"`[^`]{1,80}`|" + // inline code
		"```" +
		`)`)

	pathOrFileRE = regexp.MustCompile(`(?i)(` +
		`[/\\][\w.-]+[/\\][\w.-]+|` + // path-ish
		`\b(src|internal|pkg|cmd|app|lib|components?|hooks?|pages?|api)\b` +
		`)`)

	errorishRE = regexp.MustCompile(`(?i)(` +
		`error|panic|exception|stack\s*trace|segfault|nil pointer|` +
		`undefined|typeerror|compile|failed|failure|broken|flaky|` +
		`报错|失败|崩溃|异常|挂了|红了|不通过` +
		`)`)

	repoishRE = regexp.MustCompile(`(?i)(` +
		`\b(pr|pull request|commit|branch|git|repo|codebase|module|package)\b|` +
		`仓库|分支|提交|代码|项目|模块` +
		`)`)

	conceptRE = regexp.MustCompile(`(?i)^(` +
		`what\s+is|what's|explain|why\s+does|how\s+does|define|` +
		`什么是|是什么|解释一下|为什么|怎么理解|区别是` +
		`)`)

	pureChatRE = regexp.MustCompile(`(?i)^(` +
		`hi|hello|hey|thanks|thank you|ok|你好|嗨|谢谢|在吗` +
		`)[\s!?.。！？]*$`)

	reviewRE = regexp.MustCompile(`(?i)(` +
		`review|验收|审查|code\s*review|pr\s*review|audit|` +
		`完整实现|端到端|e2e|生产|production|安全` +
		`)`)
)
