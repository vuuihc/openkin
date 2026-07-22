package task

import (
	"context"
	"strings"
	"testing"

	"github.com/vuuihc/kin/internal/agent"
)

func TestValidateRefinedPlanOK(t *testing.T) {
	req := []RequiredStep{
		{Index: 0, Agent: "claude-code", Instruction: "do A"},
		{Index: 1, Agent: "codex", Instruction: "do B"},
	}
	refined := RefinedPlan{Steps: []RefinedStep{
		{Index: 0, Brief: "expanded A", Announcement: "start A"},
		{Index: 1, Brief: "expanded B", DependsOn: []int{0}},
	}}
	if err := ValidateRefinedPlan(req, refined); err != nil {
		t.Fatal(err)
	}
}

func TestValidateRefinedPlanRejectsReassignmentShape(t *testing.T) {
	req := []RequiredStep{{Index: 0, Agent: "codex", Instruction: "x"}}
	// Missing step / wrong length.
	if err := ValidateRefinedPlan(req, RefinedPlan{}); err == nil {
		t.Fatal("expected length error")
	}
	// Self dependency.
	if err := ValidateRefinedPlan(req, RefinedPlan{Steps: []RefinedStep{
		{Index: 0, Brief: "ok", DependsOn: []int{0}},
	}}); err == nil {
		t.Fatal("expected self-dep error")
	}
	// Empty brief.
	if err := ValidateRefinedPlan(req, RefinedPlan{Steps: []RefinedStep{
		{Index: 0, Brief: "  "},
	}}); err == nil {
		t.Fatal("expected empty brief error")
	}
}

func TestParseRefinedPlanJSONFence(t *testing.T) {
	req := []RequiredStep{{Index: 0, Agent: "codex", Instruction: "x"}}
	raw := "```json\n{\"steps\":[{\"index\":0,\"brief\":\"hello\"}]}\n```"
	got, err := ParseRefinedPlanJSON(req, raw)
	if err != nil {
		t.Fatal(err)
	}
	if got.Steps[0].Brief != "hello" {
		t.Fatalf("%+v", got)
	}
}

func TestApplyRefinedPlanPreservesAgents(t *testing.T) {
	plan := DelegatePlan{Steps: []DelegateStep{
		{Agent: "codex", Instruction: "do A"},
		{Agent: "claude-code", Instruction: "do B"},
	}}
	refined := RefinedPlan{Steps: []RefinedStep{
		{Index: 0, Brief: "expanded A"},
		{Index: 1, Brief: "expanded B"},
	}}
	got := ApplyRefinedPlan(plan, refined)
	if got.Steps[0].Agent != "codex" || got.Steps[1].Agent != "claude-code" {
		t.Fatalf("agents mutated: %+v", got.Steps)
	}
	if got.Steps[0].Instruction != "expanded A" || got.Steps[1].Instruction != "expanded B" {
		t.Fatalf("briefs not applied: %+v", got.Steps)
	}
}

func TestBuildPlanRefinePromptMentionsFixedAgents(t *testing.T) {
	plan := DelegatePlan{Raw: "fix the login flow", Steps: []DelegateStep{
		{Agent: "codex", Instruction: "implement"},
	}}
	prompt := buildPlanRefinePrompt(plan, RequiredStepsFromPlan(plan))
	if !strings.Contains(prompt, "agent=codex") {
		t.Fatalf("prompt missing agent: %s", prompt)
	}
	if !strings.Contains(prompt, "Do NOT change which agent") {
		t.Fatalf("prompt missing immutability rule: %s", prompt)
	}
}

func TestTryHostPlanRefineFailClosed(t *testing.T) {
	e := &Engine{}
	plan := DelegatePlan{Steps: []DelegateStep{{Agent: "codex", Instruction: "x"}}}
	got, _, ok := e.tryHostPlanRefine(t.Context(), "missing-host", "", plan)
	if ok {
		t.Fatal("expected fail-closed without orchestrate host")
	}
	if got.Steps[0].Instruction != "x" {
		t.Fatalf("plan mutated on failure: %+v", got)
	}
}

type stubController struct {
	text string
	err  error
}

func (s stubController) Complete(ctx context.Context, req agent.ControlRequest) (agent.ControlResult, error) {
	if s.err != nil {
		return agent.ControlResult{}, s.err
	}
	return agent.ControlResult{Text: s.text, Usage: agent.ControlUsage{TokensIn: 1, TokensOut: 2}}, nil
}

func TestTryHostPlanRefineAppliesValidatedJSON(t *testing.T) {
	ctrl := stubController{text: `{"steps":[{"index":0,"brief":"refined brief"}]}`}
	reg := agent.MustRegistry(agent.Entry{
		ID:         "kin",
		Name:       "Kin",
		Kind:       agent.KindBuiltin,
		Priority:   10,
		Caps:       []agent.Capability{agent.CapabilityRun, agent.CapabilityOrchestrate},
		Controller: ctrl,
		Status: func(context.Context) agent.Status {
			return agent.Status{Installed: true, Available: true}
		},
	})
	e := NewEngine(nil, reg, NewBus(), 1)
	plan := DelegatePlan{Steps: []DelegateStep{{Agent: "codex", Instruction: "original"}}}
	got, usage, ok := e.tryHostPlanRefine(t.Context(), "kin", "", plan)
	if !ok {
		t.Fatal("expected refine success")
	}
	if got.Steps[0].Agent != "codex" {
		t.Fatalf("agent reassigned: %+v", got.Steps[0])
	}
	if got.Steps[0].Instruction != "refined brief" {
		t.Fatalf("brief not refined: %+v", got.Steps[0])
	}
	if usage.TokensIn != 1 || usage.TokensOut != 2 {
		t.Fatalf("usage=%+v", usage)
	}
}

func TestTryHostPlanRefineRejectsInvalidJSON(t *testing.T) {
	ctrl := stubController{text: `not-json`}
	reg := agent.MustRegistry(agent.Entry{
		ID:         "kin",
		Name:       "Kin",
		Kind:       agent.KindBuiltin,
		Priority:   10,
		Caps:       []agent.Capability{agent.CapabilityRun, agent.CapabilityOrchestrate},
		Controller: ctrl,
		Status: func(context.Context) agent.Status {
			return agent.Status{Installed: true, Available: true}
		},
	})
	e := NewEngine(nil, reg, NewBus(), 1)
	plan := DelegatePlan{Steps: []DelegateStep{{Agent: "codex", Instruction: "original"}}}
	got, _, ok := e.tryHostPlanRefine(t.Context(), "kin", "", plan)
	if ok {
		t.Fatal("expected invalid JSON to fail closed")
	}
	if got.Steps[0].Instruction != "original" {
		t.Fatalf("plan mutated: %+v", got.Steps[0])
	}
}

func TestTryHostSynthesisCleansAndRejectsInternalOutput(t *testing.T) {
	tests := []struct {
		name   string
		prompt string
		text   string
		want   string
		ok     bool
	}{
		{
			name:   "cleans English wrapper",
			prompt: "Respond directly to the user in English.",
			text:   "Multi-agent run summary\nDeliverable: The fix is complete.",
			want:   "The fix is complete.",
			ok:     true,
		},
		{
			name:   "cleans Chinese wrapper",
			prompt: "Respond directly to the user in Chinese.",
			text:   "Deliverable：修复已完成。",
			want:   "修复已完成。",
			ok:     true,
		},
		{
			name:   "rejects internal-only output",
			prompt: "Respond directly to the user in English.",
			text:   "[Codex] (ok)\n… details in task log / session_search",
			ok:     false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg := agent.MustRegistry(agent.Entry{
				ID:         "kin",
				Name:       "Kin",
				Kind:       agent.KindBuiltin,
				Priority:   10,
				Caps:       []agent.Capability{agent.CapabilityRun, agent.CapabilityOrchestrate},
				Controller: stubController{text: tt.text},
				Status: func(context.Context) agent.Status {
					return agent.Status{Installed: true, Available: true}
				},
			})
			e := NewEngine(nil, reg, NewBus(), 1)
			lang := responseLanguageForPrompt(tt.prompt)
			got, _, ok := e.tryHostSynthesis(t.Context(), "kin", "", tt.prompt, lang)
			if ok != tt.ok {
				t.Fatalf("ok=%v want %v, text=%q", ok, tt.ok, got)
			}
			if got != tt.want {
				t.Fatalf("text=%q want %q", got, tt.want)
			}
		})
	}
}
