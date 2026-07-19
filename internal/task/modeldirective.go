package task

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"

	"github.com/vuuihc/kin/internal/provider"
)

// modelHintRE gates the (LLM-backed) directive extraction: only messages that
// mention a model, a provider family, or a cost/capability preference are worth
// a provider round-trip. Plain task prompts skip extraction entirely.
var modelHintRE = regexp.MustCompile(`(?i)(` +
	`模型|model|gpt|claude|opus|sonnet|haiku|grok|gemini|o3|o4|codex|` +
	`便宜|省钱|省成本|成本|贵|花钱|聪明|最强|强大|快|快速|` +
	`cheap|cheaper|cheapest|expensive|smart|smarter|strong|capable|fast|faster|cost|tier` +
	`)`)

// plannerRE / executorRE classify a delegate step's role so macro tier
// preferences ("计划用聪明模型，执行用便宜模型") map onto concrete models.
var (
	plannerRE = regexp.MustCompile(`(?i)(` +
		`plan|design|architect|research|review|audit|analy|` +
		`计划|规划|设计|架构|调研|方案|审查|评审|验收|分析` +
		`)`)
	executorRE = regexp.MustCompile(`(?i)(` +
		`implement|execute|build|run|fix|write|refactor|code|` +
		`实现|执行|构建|编写|修复|重构|编码|落地|干活` +
		`)`)
)

// ModelDirective is the model intent extracted from one natural-language turn.
// All fields are optional; an all-empty directive means "no model steering".
type ModelDirective struct {
	// Global model requested for the whole task ("整个任务用 opus").
	Global string `json:"global"`
	// PerAgent maps an agent id to a requested model ("用 Codex 的 GPT-5.6").
	PerAgent map[string]string `json:"per_agent"`
	// PlannerTier / ExecutorTier are macro role→tier preferences.
	PlannerTier  ModelTier `json:"planner_tier"`
	ExecutorTier ModelTier `json:"executor_tier"`
}

// Empty reports whether the directive carries no usable steering signal.
func (d ModelDirective) Empty() bool {
	return d.Global == "" && len(d.PerAgent) == 0 &&
		d.PlannerTier == "" && d.ExecutorTier == ""
}

// modelDirectiveSystemPrompt asks the provider for a strict-JSON extraction.
const modelDirectiveSystemPrompt = `You extract MODEL routing intent from a user message for a multi-agent coding orchestrator.
Return ONLY a JSON object, no prose, with this shape:
{"global":"","per_agent":{},"planner_tier":"","executor_tier":""}
Rules:
- "global": a single model the user wants for the whole task, else "".
- "per_agent": map of agent id -> model, ONLY for agents the user explicitly ties a model to.
  Valid agent ids: "claude-code" (aka claude/cc), "codex" (aka gpt/openai), "grok", "kin".
- "planner_tier"/"executor_tier": one of "smart","balanced","fast","" — set ONLY when the user
  expresses a cost/capability preference by role (e.g. "smart model for planning, cheap for execution").
- Copy model names verbatim as the user wrote them; do not invent or "correct" them.
- If the user expressed no model intent at all, return all empty fields.`

// ExtractModelDirective runs a gated, best-effort provider call to parse model
// intent from userTurn. ok is false (and no provider call is made) when the turn
// has no model-ish hint, when the client is nil, or when parsing fails.
func ExtractModelDirective(ctx context.Context, client provider.Client, model, userTurn string) (ModelDirective, bool) {
	turn := strings.TrimSpace(userTurn)
	if turn == "" || client == nil || !modelHintRE.MatchString(turn) {
		return ModelDirective{}, false
	}
	in := turn
	if r := []rune(in); len(r) > 1200 {
		in = string(r[:1200]) + "…"
	}
	temp := 0.0
	maxTok := 200
	resp, err := client.Chat(ctx, provider.ChatRequest{
		Model: model,
		Messages: []provider.Message{
			{Role: provider.RoleSystem, Content: modelDirectiveSystemPrompt},
			{Role: provider.RoleUser, Content: in},
		},
		Temperature: &temp,
		MaxTokens:   &maxTok,
	})
	if err != nil {
		return ModelDirective{}, false
	}
	d, ok := parseModelDirective(resp.Content)
	if !ok || d.Empty() {
		return ModelDirective{}, false
	}
	return d, true
}

// parseModelDirective decodes the provider's JSON reply, tolerating code fences
// and surrounding prose by extracting the first {...} block.
func parseModelDirective(raw string) (ModelDirective, bool) {
	s := strings.TrimSpace(raw)
	if i := strings.Index(s, "{"); i >= 0 {
		if j := strings.LastIndex(s, "}"); j >= i {
			s = s[i : j+1]
		}
	}
	var wire struct {
		Global       string            `json:"global"`
		PerAgent     map[string]string `json:"per_agent"`
		PlannerTier  string            `json:"planner_tier"`
		ExecutorTier string            `json:"executor_tier"`
	}
	if err := json.Unmarshal([]byte(s), &wire); err != nil {
		return ModelDirective{}, false
	}
	d := ModelDirective{
		Global:       strings.TrimSpace(wire.Global),
		PlannerTier:  NormalizeTier(wire.PlannerTier),
		ExecutorTier: NormalizeTier(wire.ExecutorTier),
	}
	for agent, m := range wire.PerAgent {
		id, ok := agentAliases[strings.ToLower(strings.TrimSpace(agent))]
		if !ok {
			id = strings.ToLower(strings.TrimSpace(agent))
		}
		if m = strings.TrimSpace(m); id != "" && m != "" {
			if d.PerAgent == nil {
				d.PerAgent = map[string]string{}
			}
			d.PerAgent[id] = m
		}
	}
	return d, true
}

// resolveModel picks the concrete model for one agent+role using the directive
// precedence: per-agent explicit → global explicit → role tier. Returns "" when
// the directive says nothing for this agent. Names are normalized through the
// catalog but unknown-yet-explicit names pass through verbatim.
func (d ModelDirective) resolveModel(agent string, planner bool, cat ModelCatalog) string {
	if raw, ok := d.PerAgent[agent]; ok && raw != "" {
		return normalizeOrRaw(cat, agent, raw)
	}
	if d.Global != "" {
		return normalizeOrRaw(cat, agent, d.Global)
	}
	tier := d.ExecutorTier
	if planner && d.PlannerTier != "" {
		tier = d.PlannerTier
	} else if planner {
		tier = "" // planner step but no planner preference set
	}
	if tier != "" {
		if id, ok := cat.PickByTier(agent, tier); ok {
			return id
		}
	}
	return ""
}

func normalizeOrRaw(cat ModelCatalog, agent, raw string) string {
	if id, ok := cat.Normalize(agent, raw); ok {
		return id
	}
	return raw
}

// ApplyTo fills each step's Model where empty, honoring precedence. Steps that
// already carry an explicit @agent[model] are never overwritten.
func (d ModelDirective) ApplyTo(plan *DelegatePlan, cat ModelCatalog) {
	if plan == nil || d.Empty() {
		return
	}
	for i := range plan.Steps {
		if plan.Steps[i].Model != "" {
			continue
		}
		planner := stepIsPlanner(plan.Steps[i].Instruction)
		if m := d.resolveModel(plan.Steps[i].Agent, planner, cat); m != "" {
			plan.Steps[i].Model = m
		}
	}
}

// ForAgent resolves a single (non-orchestrated) task's model for its host
// agent. Role tiers do not apply to a bare task, so only explicit per-agent /
// global steering is honored.
func (d ModelDirective) ForAgent(agent string, cat ModelCatalog) string {
	if raw, ok := d.PerAgent[agent]; ok && raw != "" {
		return normalizeOrRaw(cat, agent, raw)
	}
	if d.Global != "" {
		return normalizeOrRaw(cat, agent, d.Global)
	}
	return ""
}

// stepIsPlanner classifies a delegate step as planning-ish (vs execution-ish)
// from its instruction, so macro tier preferences land on the right steps.
func stepIsPlanner(instruction string) bool {
	if plannerRE.MatchString(instruction) && !executorRE.MatchString(instruction) {
		return true
	}
	return false
}

// WantsRoleSplit reports whether the directive asks for different model tiers
// for planning vs execution (the "smart plan, cheap exec" macro).
func (d ModelDirective) WantsRoleSplit() bool {
	if d.PlannerTier == "" || d.ExecutorTier == "" {
		return false
	}
	return d.PlannerTier != d.ExecutorTier
}

// BuildRoleSplitPlan turns a bare single-agent turn into a two-step plan:
// plan (smart tier) then execute (fast/cheap tier) on the same agent.
// Returns ok=false when tiers are missing or the catalog cannot resolve models.
func (d ModelDirective) BuildRoleSplitPlan(agent, userTurn string, cat ModelCatalog) (DelegatePlan, bool) {
	if !d.WantsRoleSplit() || strings.TrimSpace(agent) == "" {
		return DelegatePlan{}, false
	}
	planModel, ok1 := cat.PickByTier(agent, d.PlannerTier)
	execModel, ok2 := cat.PickByTier(agent, d.ExecutorTier)
	if !ok1 || !ok2 || planModel == "" || execModel == "" {
		return DelegatePlan{}, false
	}
	if modelsEqual(planModel, execModel) {
		return DelegatePlan{}, false
	}
	turn := strings.TrimSpace(userTurn)
	if turn == "" {
		turn = "Complete the assigned work for this session."
	}
	planInstr := "Create a concrete implementation plan only. Do not modify files or run commands. " +
		"Output a clear step-by-step plan for: " + turn
	execInstr := "Execute the plan from the previous step for the original request. " +
		"Implement changes, run checks when useful, and finish the work: " + turn
	return DelegatePlan{
		Overview: turn,
		Raw:      turn,
		Steps: []DelegateStep{
			{Agent: agent, Model: planModel, Instruction: planInstr, Mention: agent},
			{Agent: agent, Model: execModel, Instruction: execInstr, Mention: agent},
		},
	}, true
}
