package task

import (
	"strings"
	"testing"
)

func TestParseDelegatePlan_multi(t *testing.T) {
	avail := map[string]bool{"kin": true, "claude-code": true, "codex": true}
	raw := "调研某个任务，@claude 你去做实验 @codex 你根据实验结果做验收和总结"
	plan := ParseDelegatePlan(raw, avail)
	if plan.Overview == "" {
		t.Fatalf("expected overview, got empty")
	}
	if len(plan.Steps) != 2 {
		t.Fatalf("steps=%d want 2: %+v", len(plan.Steps), plan.Steps)
	}
	if plan.Steps[0].Agent != "claude-code" {
		t.Fatalf("step0 agent=%s", plan.Steps[0].Agent)
	}
	if plan.Steps[1].Agent != "codex" {
		t.Fatalf("step1 agent=%s", plan.Steps[1].Agent)
	}
	if !plan.HasSubAgents() {
		t.Fatal("expected HasSubAgents")
	}
}

func TestParseDelegatePlan_models(t *testing.T) {
	avail := map[string]bool{"claude-code": true, "codex": true}
	raw := "@claude[opus] 实现功能 @codex[openai/gpt-5.5] 验收"
	plan := ParseDelegatePlan(raw, avail)
	if len(plan.Steps) != 2 {
		t.Fatalf("steps=%d want 2: %+v", len(plan.Steps), plan.Steps)
	}
	if got := plan.Steps[0].Model; got != "opus" {
		t.Fatalf("step0 model=%q want opus", got)
	}
	if got := plan.Steps[1].Model; got != "openai/gpt-5.5" {
		t.Fatalf("step1 model=%q want openai/gpt-5.5", got)
	}
	if strings.Contains(plan.Steps[0].Instruction, "[opus]") || strings.Contains(plan.Steps[1].Instruction, "[openai/gpt-5.5]") {
		t.Fatalf("model suffix leaked into instructions: %+v", plan.Steps)
	}
}

func TestParseDelegatePlan_none(t *testing.T) {
	avail := map[string]bool{"kin": true, "codex": true}
	plan := ParseDelegatePlan("just chat with me", avail)
	if len(plan.Steps) != 0 {
		t.Fatalf("unexpected steps: %+v", plan.Steps)
	}
	if plan.Overview != "just chat with me" {
		t.Fatalf("overview=%q", plan.Overview)
	}
}

func TestParseDelegatePlan_unavailableSkipped(t *testing.T) {
	avail := map[string]bool{"kin": true}
	plan := ParseDelegatePlan("@codex fix it", avail)
	if len(plan.Steps) != 0 {
		t.Fatalf("codex unavailable should not produce steps: %+v", plan.Steps)
	}
}

func TestPlanWaves_parallelIndependent(t *testing.T) {
	steps := []DelegateStep{
		{Agent: "claude-code", Instruction: "查 auth 模块"},
		{Agent: "codex", Instruction: "查 billing 模块"},
	}
	waves := PlanWaves(steps)
	if len(waves) != 1 {
		t.Fatalf("want 1 parallel wave, got %v", waves)
	}
	if len(waves[0]) != 2 {
		t.Fatalf("want both steps in wave: %v", waves[0])
	}
}

func TestPlanWaves_serialOnDependency(t *testing.T) {
	steps := []DelegateStep{
		{Agent: "claude-code", Instruction: "你去做实验"},
		{Agent: "codex", Instruction: "你根据实验结果做验收和总结"},
	}
	waves := PlanWaves(steps)
	if len(waves) != 2 {
		t.Fatalf("want 2 serial waves, got %v", waves)
	}
	if len(waves[0]) != 1 || waves[0][0] != 0 {
		t.Fatalf("wave0=%v", waves[0])
	}
	if len(waves[1]) != 1 || waves[1][0] != 1 {
		t.Fatalf("wave1=%v", waves[1])
	}
}

func TestPlanWaves_mentionPriorAgent(t *testing.T) {
	steps := []DelegateStep{
		{Agent: "claude-code", Instruction: "investigate auth"},
		{Agent: "codex", Instruction: "review what claude found and summarize"},
	}
	waves := PlanWaves(steps)
	if len(waves) < 2 {
		t.Fatalf("expected serial due to 'claude' mention, got %v", waves)
	}
}

func TestUserTurnPrompt_stripsHandoffWrapper(t *testing.T) {
	raw := "Continue this Kin task.\n\n--- prior context ---\nassistant: 收到。我作为主 agent 编排；@claude 做实验\n--- end context ---\n\nUser request:\n只修 UI 文案，不要委派"
	got := UserTurnPrompt(raw)
	if got != "只修 UI 文案，不要委派" {
		t.Fatalf("got %q", got)
	}
	// Bare prompt unchanged.
	if UserTurnPrompt("hello @claude") != "hello @claude" {
		t.Fatal("bare prompt should pass through")
	}
}

func TestParseDelegatePlan_userTurnOnly(t *testing.T) {
	avail := map[string]bool{"kin": true, "claude-code": true, "codex": true}
	// Historical @claude inside handoff context must not create steps when we parse UserTurnPrompt.
	wrapped := "Continue this Kin task.\n\n--- prior context ---\nuser: 调研，@claude 做实验 @codex 验收\n--- end context ---\n\nUser request:\n继续修 bug，不要委派"
	plan := ParseDelegatePlan(UserTurnPrompt(wrapped), avail)
	if plan.HasSubAgents() {
		t.Fatalf("plain follow-up must not orchestrate: %+v", plan.Steps)
	}
	// Explicit @ on current turn still works.
	wrapped2 := "Continue this Kin task.\n\nUser request:\n@codex 只跑测试"
	plan2 := ParseDelegatePlan(UserTurnPrompt(wrapped2), avail)
	if !plan2.HasSubAgents() || plan2.Steps[0].Agent != "codex" {
		t.Fatalf("expected codex step: %+v", plan2.Steps)
	}
}

func TestExtractPriorContext(t *testing.T) {
	raw := "Continue this Kin task.\n\n--- prior context ---\nuser: 先让codex 干活\nassistant: codex 不支持\n--- end context ---\n\nUser request:\n@claude 来干吧"
	got := ExtractPriorContext(raw)
	if got == "" || !strings.Contains(got, "先让codex") || !strings.Contains(got, "不支持") {
		t.Fatalf("context=%q", got)
	}
	if ExtractPriorContext("@claude only") != "" {
		t.Fatal("bare prompt should have empty prior context")
	}
}
