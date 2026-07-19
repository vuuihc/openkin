package task

import (
	"regexp"
	"strings"
)

// Agent aliases for @mentions (UI-aligned).
var agentAliases = map[string]string{
	"kin":         "kin",
	"claude-code": "claude-code",
	"claude":      "claude-code",
	"cc":          "claude-code",
	"codex":       "codex",
	"gpt":         "codex",
	"openai":      "codex",
	"grok":        "grok",
	"xai":         "grok",
}

// A model may be selected per worker with @agent[model]. Model IDs are kept
// deliberately provider-agnostic while excluding whitespace and bracket
// delimiters; adapters receive the value as one argv element.
var mentionRE = regexp.MustCompile(`@([a-zA-Z][a-zA-Z0-9_-]*)(?:\[([a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,127})\])?`)

// Generic dependency language: step likely needs prior worker output.
var genericDepRE = regexp.MustCompile(`(?i)(根据|基于|依赖|参考|承接|验收|总结|汇总|based\s+on|depends?\s+on|after\s+(the\s+)?|using\s+(the\s+)?(previous|prior|above)|from\s+(the\s+)?result|实验结果|上一步|前述)`)

// DelegateStep is one sub-agent assignment parsed from a user prompt.
type DelegateStep struct {
	Agent       string // resolved agent id
	Model       string // optional model id from @agent[model]
	Instruction string // text after the @mention until the next one
	Mention     string // raw token as typed
}

// DelegatePlan is a multi-agent work plan embedded in one user message.
//
// Example:
//
//	"调研 X，@claude 你做实验 @codex 你根据实验结果验收"
//
// Overview = "调研 X，" Steps = [{claude-code, "你做实验"}, {codex, "你根据实验结果验收"}]
type DelegatePlan struct {
	Overview string
	Steps    []DelegateStep
	// Original prompt with aliases expanded to agent ids for the orchestrator.
	Raw string
	// SessionContext is prior conversation transcript (from handoff wrapper),
	// injected into worker briefs so multi-turn @worker follow-ups stay coherent.
	SessionContext string
}

// HasSubAgents is true when at least one worker step is assigned.
// Prefer HasWorkersOtherThan(host) when a session host is known.
func (p DelegatePlan) HasSubAgents() bool {
	return p.HasWorkersOtherThan("")
}

// HasWorkersOtherThan reports whether the plan assigns at least one worker
// that is not the selected session host.
func (p DelegatePlan) HasWorkersOtherThan(host string) bool {
	for _, s := range p.Steps {
		if s.Agent != "" && s.Agent != host {
			return true
		}
	}
	return false
}

// SubSteps returns worker steps (all assigned agents in the plan).
func (p DelegatePlan) SubSteps() []DelegateStep {
	var out []DelegateStep
	for _, s := range p.Steps {
		if s.Agent != "" {
			out = append(out, s)
		}
	}
	return out
}

// ParseDelegatePlan extracts @agent segments. available is the set of agent ids
// that may be targeted; unknown aliases that resolve to unavailable agents are kept as plain text.
func ParseDelegatePlan(raw string, available map[string]bool) DelegatePlan {
	plan := DelegatePlan{Raw: raw}
	if strings.TrimSpace(raw) == "" {
		return plan
	}

	type hit struct {
		start, end int
		agent      string
		model      string
		mention    string
	}
	var hits []hit
	for _, m := range mentionRE.FindAllStringSubmatchIndex(raw, -1) {
		tok := raw[m[2]:m[3]]
		key := strings.ToLower(tok)
		id, ok := agentAliases[key]
		if !ok {
			id = key
		}
		if !available[id] {
			continue
		}
		model := ""
		if len(m) >= 6 && m[4] >= 0 {
			model = raw[m[4]:m[5]]
		}
		hits = append(hits, hit{
			start:   m[0],
			end:     m[1],
			agent:   id,
			model:   model,
			mention: tok,
		})
	}
	if len(hits) == 0 {
		plan.Overview = strings.TrimSpace(raw)
		return plan
	}

	plan.Overview = strings.TrimSpace(raw[:hits[0].start])
	for i, h := range hits {
		end := len(raw)
		if i+1 < len(hits) {
			end = hits[i+1].start
		}
		instr := strings.TrimSpace(raw[h.end:end])
		// Collapse whitespace a bit but keep newlines for long instructions.
		instr = collapseSpaces(instr)
		if instr == "" {
			instr = plan.Overview
			if instr == "" {
				instr = "Complete the assigned work for this session."
			}
		}
		plan.Steps = append(plan.Steps, DelegateStep{
			Agent:       h.agent,
			Model:       h.model,
			Instruction: instr,
			Mention:     h.mention,
		})
	}
	return plan
}

// PlanWaves groups step indices into parallel waves.
// A step runs after any prior step it depends on (agent mention or generic "based on result" language).
// Independent steps in the same wave run concurrently.
func PlanWaves(steps []DelegateStep) [][]int {
	n := len(steps)
	if n == 0 {
		return nil
	}
	deps := make([]map[int]bool, n)
	for i := range deps {
		deps[i] = map[int]bool{}
	}

	for i := 0; i < n; i++ {
		instr := strings.ToLower(steps[i].Instruction)
		specific := false
		for j := 0; j < i; j++ {
			if instructionMentionsAgent(instr, steps[j].Agent) {
				deps[i][j] = true
				specific = true
			}
		}
		// "根据实验结果 / based on previous results" without naming an agent → wait for all prior.
		if !specific && genericDepRE.MatchString(instr) && i > 0 {
			for j := 0; j < i; j++ {
				deps[i][j] = true
			}
		}
	}

	done := make([]bool, n)
	var waves [][]int
	remaining := n
	for remaining > 0 {
		var wave []int
		for i := 0; i < n; i++ {
			if done[i] {
				continue
			}
			ready := true
			for j := range deps[i] {
				if !done[j] {
					ready = false
					break
				}
			}
			if ready {
				wave = append(wave, i)
			}
		}
		if len(wave) == 0 {
			// Cycle / bug: force next unfinished step alone.
			for i := 0; i < n; i++ {
				if !done[i] {
					wave = []int{i}
					break
				}
			}
		}
		if len(wave) == 0 {
			break
		}
		waves = append(waves, wave)
		for _, i := range wave {
			if !done[i] {
				done[i] = true
				remaining--
			}
		}
	}
	return waves
}

func instructionMentionsAgent(instrLower, agentID string) bool {
	// Match known aliases that resolve to agentID.
	for alias, id := range agentAliases {
		if id != agentID {
			continue
		}
		if strings.Contains(instrLower, strings.ToLower(alias)) {
			return true
		}
	}
	// Display-ish tokens
	switch agentID {
	case "claude-code":
		return strings.Contains(instrLower, "claude code") || strings.Contains(instrLower, "claudecode")
	case "codex":
		return strings.Contains(instrLower, "codex")
	case "grok":
		return strings.Contains(instrLower, "grok")
	}
	return strings.Contains(instrLower, strings.ToLower(agentID))
}

func collapseSpaces(s string) string {
	// Keep newlines; collapse runs of spaces/tabs.
	var b strings.Builder
	b.Grow(len(s))
	space := false
	for _, r := range s {
		if r == ' ' || r == '\t' {
			if !space {
				b.WriteByte(' ')
				space = true
			}
			continue
		}
		space = false
		b.WriteRune(r)
	}
	return strings.TrimSpace(b.String())
}

// AvailableSet builds a set from agent ids.
func AvailableSet(ids []string) map[string]bool {
	m := make(map[string]bool, len(ids))
	for _, id := range ids {
		m[id] = true
	}
	return m
}

// UserTurnPrompt returns the live user message, stripping engine-injected
// handoff / resume wrappers. Historical @mentions in prior context must not
// re-trigger multi-agent orchestration on a plain follow-up.
func UserTurnPrompt(prompt string) string {
	s := strings.TrimSpace(prompt)
	if s == "" {
		return s
	}
	// formatHandoffPrompt always ends with "User request:\n" + original text.
	const marker = "User request:\n"
	if i := strings.LastIndex(s, marker); i >= 0 {
		return strings.TrimSpace(s[i+len(marker):])
	}
	// Defensive: older variants.
	for _, m := range []string{"User request:\r\n", "\nUser request:\n"} {
		if i := strings.LastIndex(s, m); i >= 0 {
			return strings.TrimSpace(s[i+len(m):])
		}
	}
	return s
}

// ExtractPriorContext returns the body between --- prior context --- markers
// injected by formatHandoffPrompt. Empty when the prompt is a bare user turn.
func ExtractPriorContext(prompt string) string {
	s := prompt
	const start = "--- prior context ---"
	const end = "--- end context ---"
	i := strings.Index(s, start)
	if i < 0 {
		return ""
	}
	i += len(start)
	j := strings.Index(s[i:], end)
	if j < 0 {
		return strings.TrimSpace(s[i:])
	}
	return strings.TrimSpace(s[i : i+j])
}
