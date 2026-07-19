package task

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
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
func (e *Engine) tryHostSynthesis(ctx context.Context, host, model, prompt string) (string, agent.ControlUsage, bool) {
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
	text := strings.TrimSpace(res.Text)
	if text == "" || isWorkerMetaOutput(text) {
		return "", res.Usage, false
	}
	return text, res.Usage, true
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
	e.appendEventLocked(ctx, taskID, "orchestration_fallback", payload)
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
	e.appendEventLocked(ctx, taskID, "usage", payload)
}
