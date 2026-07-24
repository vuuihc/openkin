package task

import (
	"context"
	"sync/atomic"
	"testing"

	"github.com/vuuihc/kin/internal/provider"
)

// countingClient records how many times Chat is invoked (gating assertions).
type countingClient struct {
	content string
	calls   int32
}

func (c *countingClient) Chat(ctx context.Context, req provider.ChatRequest) (*provider.ChatResponse, error) {
	atomic.AddInt32(&c.calls, 1)
	return &provider.ChatResponse{Content: c.content, Model: "stub"}, nil
}
func (c *countingClient) Kind() string         { return "stub" }
func (c *countingClient) ModelDefault() string { return "stub" }

func TestExtractModelDirectiveGating(t *testing.T) {
	ctx := context.Background()
	// No model-ish hint → no provider call, ok=false.
	c := &countingClient{content: `{"per_agent":{"codex":"gpt-5"}}`}
	if _, ok := ExtractModelDirective(ctx, c, "m", "帮我修一下登录的 bug"); ok {
		t.Fatalf("plain prompt should not yield a directive")
	}
	if got := atomic.LoadInt32(&c.calls); got != 0 {
		t.Fatalf("prefilter must skip the provider call, got %d calls", got)
	}
	// nil client → ok=false, no panic.
	if _, ok := ExtractModelDirective(ctx, nil, "m", "用 gpt-5 执行"); ok {
		t.Fatalf("nil client should yield ok=false")
	}
}

func TestExtractModelDirectivePerAgent(t *testing.T) {
	ctx := context.Background()
	c := &countingClient{content: `{"global":"","per_agent":{"codex":"GPT 5.6 Terra"},"planner_tier":"","executor_tier":""}`}
	d, ok := ExtractModelDirective(ctx, c, "m", "这个任务用 Codex 的 GPT 5.6 Terra 去执行")
	if !ok {
		t.Fatalf("expected a directive")
	}
	if d.PerAgent["codex"] != "GPT 5.6 Terra" {
		t.Fatalf("per_agent codex = %q", d.PerAgent["codex"])
	}
	if atomic.LoadInt32(&c.calls) != 1 {
		t.Fatalf("expected exactly one provider call")
	}
}

func TestModelDirectiveApplyPrecedence(t *testing.T) {
	cat := BuiltinCatalog()
	plan := &DelegatePlan{Steps: []DelegateStep{
		{Agent: "claude-code", Instruction: "做实验", Model: "explicit-model"}, // explicit @model — keep
		{Agent: "codex", Instruction: "根据实验结果验收"},                           // fill from per-agent
		{Agent: "grok", Instruction: "跑一下测试"},                               // fill from global
	}}
	d := ModelDirective{
		Global:   "grok-4",
		PerAgent: map[string]string{"codex": "gpt 5.1 codex max"},
	}
	d.ApplyTo(plan, cat)

	if plan.Steps[0].Model != "explicit-model" {
		t.Errorf("explicit model overwritten: %q", plan.Steps[0].Model)
	}
	if plan.Steps[1].Model != "gpt-5.1-codex-max" { // per-agent, normalized
		t.Errorf("codex step = %q, want normalized per-agent model", plan.Steps[1].Model)
	}
	if plan.Steps[2].Model != "grok-4" { // global fallback
		t.Errorf("grok step = %q, want global", plan.Steps[2].Model)
	}
}

func TestModelDirectiveApplyTiers(t *testing.T) {
	cat := BuiltinCatalog()
	// "聪明模型做计划，便宜模型做执行" — role → tier mapping.
	plan := &DelegatePlan{Steps: []DelegateStep{
		{Agent: "claude-code", Instruction: "先做架构设计与调研方案"}, // planner → smart
		{Agent: "codex", Instruction: "根据方案实现并修复问题"},       // executor → fast
	}}
	d := ModelDirective{PlannerTier: TierSmart, ExecutorTier: TierFast}
	d.ApplyTo(plan, cat)

	if plan.Steps[0].Model != "claude-opus-4-8" {
		t.Errorf("planner step = %q, want smart tier", plan.Steps[0].Model)
	}
	if plan.Steps[1].Model != "o4-mini" {
		t.Errorf("executor step = %q, want fast tier", plan.Steps[1].Model)
	}
}

func TestModelDirectiveForAgent(t *testing.T) {
	cat := BuiltinCatalog()
	d := ModelDirective{
		Global:   "opus",
		PerAgent: map[string]string{"codex": "mini"},
	}
	if got := d.ForAgent("codex", cat); got != "o4-mini" {
		t.Errorf("ForAgent codex = %q, want o4-mini", got)
	}
	if got := d.ForAgent("claude-code", cat); got != "claude-opus-4-8" {
		t.Errorf("ForAgent claude-code = %q, want global opus normalized", got)
	}
	// Tiers do not apply to a bare task.
	empty := ModelDirective{PlannerTier: TierSmart}
	if got := empty.ForAgent("codex", cat); got != "" {
		t.Errorf("ForAgent with only tier = %q, want empty", got)
	}
}

func TestModelDirectiveWantsRoleSplit(t *testing.T) {
	if (ModelDirective{PlannerTier: TierSmart}).WantsRoleSplit() {
		t.Fatal("single tier should not split")
	}
	if !(ModelDirective{PlannerTier: TierSmart, ExecutorTier: TierFast}).WantsRoleSplit() {
		t.Fatal("smart/fast should split")
	}
	if (ModelDirective{PlannerTier: TierFast, ExecutorTier: TierFast}).WantsRoleSplit() {
		t.Fatal("identical tiers should not split")
	}
}

func TestBuildRoleSplitPlan(t *testing.T) {
	d := ModelDirective{PlannerTier: TierSmart, ExecutorTier: TierFast}
	plan, ok := d.BuildRoleSplitPlan("claude-code", "修登录 bug", BuiltinCatalog())
	if !ok {
		t.Fatal("expected plan")
	}
	if len(plan.Steps) != 2 {
		t.Fatalf("steps=%d", len(plan.Steps))
	}
	if plan.Steps[0].Model != "claude-opus-4-8" {
		t.Fatalf("plan model=%q", plan.Steps[0].Model)
	}
	if plan.Steps[1].Model != "claude-haiku-4-5" {
		t.Fatalf("exec model=%q", plan.Steps[1].Model)
	}
	if plan.Steps[0].Agent != "claude-code" || plan.Steps[1].Agent != "claude-code" {
		t.Fatalf("agents=%q/%q", plan.Steps[0].Agent, plan.Steps[1].Agent)
	}
}

func TestNormalizeOrRawDropsShortCrossAgentAlias(t *testing.T) {
	cat := BuiltinCatalog()
	// "opus" is a Claude alias; must not pass through for kin.
	if got := normalizeOrRaw(cat, "kin", "opus"); got != "" {
		t.Fatalf("kin+opus = %q want empty", got)
	}
	// Same alias normalizes for claude-code.
	if got := normalizeOrRaw(cat, "claude-code", "opus"); got != "claude-opus-4-8" {
		t.Fatalf("claude opus = %q", got)
	}
	// Explicit full ids still pass for unknown agents/catalog gaps.
	if got := normalizeOrRaw(cat, "kin", "provider/my-model"); got != "provider/my-model" {
		t.Fatalf("concrete id = %q", got)
	}
	if got := normalizeOrRaw(cat, "codex", "gpt-5.5"); got != "gpt-5.5" {
		t.Fatalf("gpt-5.5 = %q", got)
	}
}
