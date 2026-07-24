package task

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/vuuihc/kin/internal/agent"
)

// RequiredStep is an immutable worker assignment from the deterministic parser.
type RequiredStep struct {
	Index       int    `json:"index"`
	Agent       string `json:"agent"`
	Instruction string `json:"instruction"`
}

// RefinedStep is a model-proposed refinement of a required step.
// The model may not reassign agent or invent indexes.
type RefinedStep struct {
	Index        int    `json:"index"`
	Brief        string `json:"brief"`
	Announcement string `json:"announcement,omitempty"`
	// DependsOn lists earlier required indexes only.
	DependsOn []int `json:"depends_on,omitempty"`
}

// RefinedPlan is the control-plane plan proposal.
type RefinedPlan struct {
	Steps []RefinedStep `json:"steps"`
}

// RequiredStepsFromPlan projects a DelegatePlan into required steps.
func RequiredStepsFromPlan(plan DelegatePlan) []RequiredStep {
	out := make([]RequiredStep, 0, len(plan.Steps))
	for i, s := range plan.Steps {
		out = append(out, RequiredStep{
			Index:       i,
			Agent:       s.Agent,
			Instruction: s.Instruction,
		})
	}
	return out
}

// ValidateRefinedPlan ensures model output cannot add/remove/reassign steps.
func ValidateRefinedPlan(required []RequiredStep, refined RefinedPlan) error {
	if len(refined.Steps) != len(required) {
		return fmt.Errorf("refined plan length %d != required %d", len(refined.Steps), len(required))
	}
	if len(refined.Steps) > 8 {
		return fmt.Errorf("refined plan has %d steps (max 8)", len(refined.Steps))
	}
	seen := make(map[int]bool, len(refined.Steps))
	for _, step := range refined.Steps {
		if step.Index < 0 || step.Index >= len(required) {
			return fmt.Errorf("refined step index %d out of range", step.Index)
		}
		if seen[step.Index] {
			return fmt.Errorf("duplicate refined step index %d", step.Index)
		}
		seen[step.Index] = true
		if strings.TrimSpace(step.Brief) == "" {
			return fmt.Errorf("refined step %d: empty brief", step.Index)
		}
		if utf8.RuneCountInString(step.Brief) > 4000 {
			return fmt.Errorf("refined step %d: brief too long", step.Index)
		}
		if utf8.RuneCountInString(step.Announcement) > 600 {
			return fmt.Errorf("refined step %d: announcement too long", step.Index)
		}
		for _, dep := range step.DependsOn {
			if dep < 0 || dep >= len(required) {
				return fmt.Errorf("refined step %d: bad dependency %d", step.Index, dep)
			}
			if dep >= step.Index {
				return fmt.Errorf("refined step %d: dependency %d must be earlier", step.Index, dep)
			}
		}
	}
	for i := range required {
		if !seen[i] {
			return fmt.Errorf("missing refined step index %d", i)
		}
	}
	return nil
}

// ParseRefinedPlanJSON parses and validates a control-plane plan proposal.
func ParseRefinedPlanJSON(required []RequiredStep, raw string) (RefinedPlan, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return RefinedPlan{}, fmt.Errorf("empty refined plan")
	}
	// Tolerate optional markdown fences.
	if strings.HasPrefix(raw, "```") {
		raw = strings.TrimPrefix(raw, "```json")
		raw = strings.TrimPrefix(raw, "```JSON")
		raw = strings.TrimPrefix(raw, "```")
		raw = strings.TrimSuffix(strings.TrimSpace(raw), "```")
		raw = strings.TrimSpace(raw)
	}
	var plan RefinedPlan
	if err := json.Unmarshal([]byte(raw), &plan); err != nil {
		return RefinedPlan{}, err
	}
	if err := ValidateRefinedPlan(required, plan); err != nil {
		return RefinedPlan{}, err
	}
	return plan, nil
}

// ApplyRefinedPlan overlays validated briefs onto the deterministic plan.
// Agent identity and step count stay engine-owned.
func ApplyRefinedPlan(plan DelegatePlan, refined RefinedPlan) DelegatePlan {
	out := plan
	out.Steps = append([]DelegateStep(nil), plan.Steps...)
	for _, rs := range refined.Steps {
		if rs.Index < 0 || rs.Index >= len(out.Steps) {
			continue
		}
		if b := strings.TrimSpace(rs.Brief); b != "" {
			out.Steps[rs.Index].Instruction = b
		}
	}
	return out
}

// hostHasOrchestrate reports whether the host plugin declares orchestrate + controller.
func (e *Engine) hostHasOrchestrate(host string) bool {
	reg, ok := e.agents.Get(host)
	if !ok {
		return false
	}
	return reg.Descriptor.Has(agent.CapabilityOrchestrate) && reg.Controller != nil
}

// tryHostPlanRefine asks the host controller to refine worker briefs.
// Fail-closed: any error/timeout/invalid JSON returns ok=false and leaves plan unchanged.
func (e *Engine) tryHostPlanRefine(ctx context.Context, host, model string, plan DelegatePlan) (DelegatePlan, agent.ControlUsage, bool) {
	if !e.hostHasOrchestrate(host) || len(plan.Steps) == 0 {
		return plan, agent.ControlUsage{}, false
	}
	reg, ok := e.agents.Get(host)
	if !ok || reg.Controller == nil {
		return plan, agent.ControlUsage{}, false
	}
	required := RequiredStepsFromPlan(plan)
	prompt := buildPlanRefinePrompt(plan, required)
	callCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	res, err := reg.Controller.Complete(callCtx, agent.ControlRequest{
		Purpose: agent.ControlPlan,
		Model:   model,
		Prompt:  prompt,
		Timeout: 60 * time.Second,
	})
	if err != nil {
		return plan, agent.ControlUsage{}, false
	}
	refined, err := ParseRefinedPlanJSON(required, res.Text)
	if err != nil {
		return plan, res.Usage, false
	}
	return ApplyRefinedPlan(plan, refined), res.Usage, true
}

// tryHostSynthesis asks the host controller for a final summary; empty/error → fallback.
func (e *Engine) tryHostSynthesis(ctx context.Context, host, model, prompt string, lang responseLanguage) (string, agent.ControlUsage, bool) {
	reg, ok := e.agents.Get(host)
	if !ok || reg.Controller == nil {
		return "", agent.ControlUsage{}, false
	}
	callCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	res, err := reg.Controller.Complete(callCtx, agent.ControlRequest{
		Purpose: agent.ControlSynthesis,
		Model:   model,
		Prompt:  prompt,
		Timeout: 60 * time.Second,
	})
	if err != nil {
		return "", agent.ControlUsage{}, false
	}
	text, ok := cleanUserFacingSynthesis(res.Text, lang)
	if !ok || isWorkerMetaOutput(text) {
		return "", res.Usage, false
	}
	return text, res.Usage, true
}

type responseLanguage uint8

const (
	responseLanguageEnglish responseLanguage = iota
	responseLanguageChinese
)

var (
	// These expressions intentionally only recognize explicit response-language
	// instructions. A casual mention of a language in the task should not
	// change the language of the final answer.
	responseLanguageEnglishRE  = regexp.MustCompile(`(?i)(?:\b(?:answer|respond|reply|write|output|use)\s+(?:in\s+)?english\b|\b(?:in|into|to)\s+english\b|(?:英文|英语)(?:回答|回复|输出)|(?:用|使用|以)\s*(?:英文|英语))`)
	responseLanguageChineseRE  = regexp.MustCompile(`(?i)(?:\b(?:answer|respond|reply|write|output|use)\s+(?:in\s+)?chinese\b|\b(?:in|into|to)\s+chinese\b|(?:中文|汉语|简体中文)(?:回答|回复|输出)|(?:用|使用|以)\s*(?:中文|汉语|简体中文))`)
	internalSynthesisLineRE    = regexp.MustCompile(`(?i)^\s*(?:[-*]\s*)?(?:#{1,6}\s*)?(?:multi[- ]agent(?: run)? summary|request|workers?|worker results?|worker digest|workerdigest|deliverable|digest|handoff|prompt|session_search|details in task log)\s*:?(?:\s*)$`)
	internalSynthesisLabelRE   = regexp.MustCompile(`(?i)^\s*(?:[-*]\s*)?(?:request|worker(?:\s+results?)?|worker\s*\d+|deliverable|digest|handoff|prompt)\s*[:：]\s*(.*)$`)
	internalSynthesisContextRE = regexp.MustCompile(`(?i)^\s*(?:[-*]\s*)?(?:multi[- ]agent(?: run)? summary|request|handoff|prompt)\s*[:：]`)
	workerStatusLineRE         = regexp.MustCompile(`^\s*(?:[-*]\s*)?\[[^]\r\n]+\](?:\s+\((?:ok|failed|error)\))?\s*$`)
)

// responseLanguageForPrompt follows the live user turn unless that turn
// explicitly asks for another response language. The final instruction added
// to synthesis prompts is also understood, which keeps this helper compatible
// with callers that only have the complete synthesis prompt.
func responseLanguageForPrompt(prompt string) responseLanguage {
	if lang, ok := lastExplicitResponseLanguage(prompt); ok {
		return lang
	}
	for _, r := range prompt {
		if unicode.Is(unicode.Han, r) {
			return responseLanguageChinese
		}
	}
	return responseLanguageEnglish
}

func lastExplicitResponseLanguage(prompt string) (responseLanguage, bool) {
	english := responseLanguageEnglishRE.FindAllStringIndex(prompt, -1)
	chinese := responseLanguageChineseRE.FindAllStringIndex(prompt, -1)
	if len(english) == 0 && len(chinese) == 0 {
		return responseLanguageEnglish, false
	}
	lastEnglish := -1
	if len(english) > 0 {
		lastEnglish = english[len(english)-1][0]
	}
	lastChinese := -1
	if len(chinese) > 0 {
		lastChinese = chinese[len(chinese)-1][0]
	}
	if lastChinese > lastEnglish {
		return responseLanguageChinese, true
	}
	return responseLanguageEnglish, true
}

// synthesisLanguageInstruction is the short control-plane line used by host
// synthesis prompts (and recognized by responseLanguageForPrompt).
func synthesisLanguageInstruction(lang responseLanguage) string {
	return replyLanguageInstruction(lang)
}

// replyLanguageInstruction is the engine-wide user-facing language policy.
// Appended to host single-agent prompts and worker briefs so Claude Code /
// Codex / Kin all reply in the live user turn's language by default.
func replyLanguageInstruction(lang responseLanguage) string {
	if lang == responseLanguageChinese {
		return "Respond directly to the user in Chinese. Keep the final user-facing summary in Chinese unless they explicitly requested a different reply language. Tool output, source code, and docs may stay as-is."
	}
	return "Respond directly to the user in English. Keep the final user-facing summary in English unless they explicitly requested a different reply language. Tool output, source code, and docs may stay as-is."
}

// withReplyLanguage appends the language policy once. Detection uses only the
// live user turn (UserTurnPrompt) so handoff wrappers and prior context do not
// flip the language. Safe to call on already-wrapped prompts.
func withReplyLanguage(prompt, liveUserTurn string) string {
	prompt = strings.TrimRight(prompt, " \t\r\n")
	if prompt == "" {
		return prompt
	}
	lang := responseLanguageForPrompt(liveUserTurn)
	instr := replyLanguageInstruction(lang)
	if strings.Contains(prompt, instr) {
		return prompt
	}
	// Drop a previously injected short/long instruction so re-wrap stays clean.
	for _, stale := range []string{
		replyLanguageInstruction(responseLanguageChinese),
		replyLanguageInstruction(responseLanguageEnglish),
		"Respond directly to the user in Chinese.",
		"Respond directly to the user in English.",
	} {
		if stale == instr {
			continue
		}
		if i := strings.LastIndex(prompt, "\n\n"+stale); i >= 0 && i+2+len(stale) == len(prompt) {
			prompt = strings.TrimRight(prompt[:i], " \t\r\n")
		} else if strings.HasSuffix(prompt, stale) {
			prompt = strings.TrimRight(prompt[:len(prompt)-len(stale)], " \t\r\n")
		}
	}
	if strings.HasSuffix(prompt, instr) {
		return prompt
	}
	return prompt + "\n\n" + instr
}

// cleanUserFacingSynthesis removes control-plane labels and recoverability
// pointers before a controller response reaches the user. It returns false
// when the response contains no usable user-facing content.
func cleanUserFacingSynthesis(raw string, lang responseLanguage) (string, bool) {
	text := strings.TrimSpace(raw)
	if text == "" {
		return "", false
	}
	if strings.HasPrefix(text, "```") {
		text = strings.TrimPrefix(text, "```markdown")
		text = strings.TrimPrefix(text, "```md")
		text = strings.TrimPrefix(text, "```")
		text = strings.TrimSuffix(strings.TrimSpace(text), "```")
	}

	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	kept := make([]string, 0, len(lines))
	for _, original := range lines {
		line := strings.TrimSpace(original)
		output := strings.TrimRight(original, " \t")
		if line == "" {
			if len(kept) > 0 && kept[len(kept)-1] != "" {
				kept = append(kept, "")
			}
			continue
		}
		if internalSynthesisLineRE.MatchString(line) || workerStatusLineRE.MatchString(line) {
			continue
		}
		if internalSynthesisContextRE.MatchString(line) {
			continue
		}
		if m := internalSynthesisLabelRE.FindStringSubmatch(line); m != nil {
			line = strings.TrimSpace(m[1])
			output = line
			if line == "" {
				continue
			}
			if workerStatusLineRE.MatchString(line) {
				continue
			}
		}
		if strings.Contains(strings.ToLower(line), "session_search") ||
			strings.Contains(strings.ToLower(line), "details in task log") {
			continue
		}
		// Preserve Markdown indentation for code blocks and nested lists.
		kept = append(kept, output)
	}

	text = strings.TrimSpace(strings.Join(kept, "\n"))
	if text == "" {
		return "", false
	}
	// A marker that survives line cleanup means the controller is still
	// speaking in orchestration terms; reject it so the deterministic fallback
	// can provide a safe answer in the user's language.
	lower := strings.ToLower(text)
	for _, marker := range []string{
		"multi-agent", "multi agent", "orchestration", "orchestrator",
		"worker digest", "workerdigest", "session_search", "handoff", "system prompt",
		"internal prompt", "task log",
	} {
		if strings.Contains(lower, marker) {
			return "", false
		}
	}
	if !isLanguageAppropriate(text, lang) {
		return "", false
	}
	return text, true
}

func isLanguageAppropriate(text string, lang responseLanguage) bool {
	han, latin := 0, 0
	for _, r := range text {
		switch {
		case unicode.Is(unicode.Han, r):
			han++
		case unicode.IsLetter(r) && r <= unicode.MaxASCII:
			latin++
		}
	}
	// Code-only or punctuation-only answers carry no language signal and are
	// safe to preserve. Otherwise reject a response written in the other
	// supported language so fallback remains language-appropriate.
	if han == 0 && latin == 0 {
		return true
	}
	if lang == responseLanguageChinese {
		return han > 0
	}
	return han == 0
}

func buildPlanRefinePrompt(plan DelegatePlan, required []RequiredStep) string {
	var b strings.Builder
	b.WriteString("You are refining a multi-agent delegation plan.\n")
	b.WriteString("Rules:\n")
	b.WriteString("- Keep the same step count and indexes.\n")
	b.WriteString("- Do NOT change which agent runs which step.\n")
	b.WriteString("- You may only rewrite each step's brief (and optional announcement / depends_on).\n")
	b.WriteString("- depends_on may only reference earlier indexes.\n")
	b.WriteString("- Reply with JSON only: {\"steps\":[{\"index\":0,\"brief\":\"...\",\"announcement\":\"...\",\"depends_on\":[]}]}\n\n")
	goal := strings.TrimSpace(plan.Raw)
	if goal == "" {
		goal = strings.TrimSpace(plan.Overview)
	}
	if goal != "" {
		if utf8.RuneCountInString(goal) > 2000 {
			r := []rune(goal)
			goal = string(r[:2000]) + "…"
		}
		b.WriteString("User goal:\n")
		b.WriteString(goal)
		b.WriteString("\n\n")
	}
	b.WriteString("Required steps (agent is fixed):\n")
	for _, s := range required {
		instr := strings.TrimSpace(s.Instruction)
		if utf8.RuneCountInString(instr) > 1000 {
			r := []rune(instr)
			instr = string(r[:1000]) + "…"
		}
		fmt.Fprintf(&b, "- index=%d agent=%s instruction=%s\n", s.Index, s.Agent, instr)
	}
	return b.String()
}

// agentDisplayName resolves a stable UI/display label from the registry when possible.
func (e *Engine) agentDisplayName(id, model string) string {
	name := strings.TrimSpace(id)
	if e != nil && e.agents != nil {
		if reg, ok := e.agents.Get(id); ok {
			if n := strings.TrimSpace(reg.Descriptor.Name); n != "" {
				name = n
			}
		}
	}
	if name == "" {
		name = id
	}
	// Presentation-only fallbacks for known built-ins when registry is absent (tests).
	if name == id {
		switch id {
		case "claude-code":
			name = "Claude Code"
		case "codex":
			name = "Codex"
		case "grok":
			name = "Grok"
		case "kin":
			name = "Kin"
		}
	}
	if model != "" {
		return name + "[" + model + "]"
	}
	return name
}

func (e *Engine) emitOrchestrationFallback(ctx context.Context, taskID, host, reason, stage string) {
	payload, _ := json.Marshal(map[string]any{
		"source": "orchestrator",
		"host":   host,
		"stage":  stage,
		"reason": reason,
	})
	_, _ = e.appendEventLocked(ctx, taskID, "orchestration_fallback", payload)
}

func (e *Engine) recordControllerUsage(ctx context.Context, taskID, host, purpose string, usage agent.ControlUsage) {
	if usage.TokensIn <= 0 && usage.TokensOut <= 0 && usage.CostUSD == nil {
		return
	}
	payload, _ := json.Marshal(map[string]any{
		"source":     "controller",
		"purpose":    purpose,
		"tokens_in":  usage.TokensIn,
		"tokens_out": usage.TokensOut,
		"model":      usage.Model,
		"cost_usd":   usage.CostUSD,
		"agent":      host,
		"speaker":    host,
	})
	_, _ = e.appendEventLocked(ctx, taskID, "usage", payload)
}
