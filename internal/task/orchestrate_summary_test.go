package task

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestExtractFinalWorkerTextSkipsPartialAndReasoning(t *testing.T) {
	partial, _ := json.Marshal(map[string]any{
		"role":    "assistant",
		"partial": true,
		"content": []map[string]string{{"type": "text", "text": "thinking…"}},
	})
	if got := extractFinalWorkerText(partial); got != "" {
		t.Fatalf("partial should be ignored, got %q", got)
	}

	reasoning, _ := json.Marshal(map[string]any{
		"role":    "reasoning",
		"partial": false,
		"content": []map[string]string{{"type": "text", "text": "internal chain"}},
	})
	if got := extractFinalWorkerText(reasoning); got != "" {
		t.Fatalf("reasoning should be ignored, got %q", got)
	}

	final, _ := json.Marshal(map[string]any{
		"role":    "assistant",
		"partial": false,
		"content": []map[string]string{{"type": "text", "text": "  final answer  "}},
	})
	if got := extractFinalWorkerText(final); got != "final answer" {
		t.Fatalf("final text=%q", got)
	}
}

func TestChooseWorkerSummaryPrefersResult(t *testing.T) {
	got := chooseWorkerSummary("from result", []string{"msg1", "msg2"})
	if got != "from result" {
		t.Fatalf("got %q", got)
	}
	got = chooseWorkerSummary("", []string{"msg1", "msg2"})
	if got != "msg2" {
		t.Fatalf("expected last final message, got %q", got)
	}
	got = chooseWorkerSummary("  ", nil)
	if got != "" {
		t.Fatalf("empty expected, got %q", got)
	}
}

func TestExtractResultText(t *testing.T) {
	ok, _ := json.Marshal(map[string]any{
		"result":   "Claude final answer",
		"is_error": false,
	})
	if got := extractResultText(ok); got != "Claude final answer" {
		t.Fatalf("got %q", got)
	}

	// Non-error message alone is not treated as the answer.
	msgOnly, _ := json.Marshal(map[string]any{
		"message":  "turn completed",
		"is_error": false,
	})
	if got := extractResultText(msgOnly); got != "" {
		t.Fatalf("non-error message should be ignored, got %q", got)
	}

	errRes, _ := json.Marshal(map[string]any{
		"message":  "boom",
		"is_error": true,
	})
	if got := extractResultText(errRes); got != "boom" {
		t.Fatalf("error message=%q", got)
	}
}

func TestBuildMainSummaryDigestsLongFindings(t *testing.T) {
	// Policy C: main summary must not paste multi-k worker dumps.
	var body strings.Builder
	body.WriteString("# Findings\n")
	for i := 0; i < 80; i++ {
		body.WriteString("filler narrative line ")
		body.WriteString(strings.Repeat("x", 30))
		body.WriteByte('\n')
	}
	body.WriteString("Edited internal/sessionctx/digest.go\n")
	body.WriteString("FAIL: TestFoo\n")
	prior := "[Claude Code]\n" + body.String()
	out := buildMainSummary(DelegatePlan{}, []string{prior}, []bool{false}, false)
	if !strings.HasPrefix(out, "完成：") {
		t.Fatalf("prefix: %q", out[:20])
	}
	if !strings.Contains(out, "[Claude Code] (ok)") {
		t.Fatalf("worker header missing: %s", out[:120])
	}
	// Full filler dump must not survive.
	if strings.Count(out, "filler narrative") >= 40 {
		t.Fatalf("full worker dump present in main summary (len=%d)", len(out))
	}
	// High-signal lines should survive the digest.
	if !strings.Contains(out, "FAIL: TestFoo") && !strings.Contains(out, "digest.go") {
		t.Fatalf("signals missing from digest:\n%s", out)
	}
}

func TestBuildMainSummaryShortPassthrough(t *testing.T) {
	out := buildMainSummary(DelegatePlan{}, []string{"[Codex]\nFixed the bug"}, []bool{false}, false)
	if !strings.Contains(out, "Fixed the bug") {
		t.Fatalf("got %q", out)
	}
}

func TestTruncateRuneSafe(t *testing.T) {
	s := "你好世界ABC"
	got := truncate(s, 3)
	if got != "你好世…" {
		t.Fatalf("got %q", got)
	}
	if truncate(s, 100) != s {
		t.Fatalf("short string should pass through")
	}
}

func TestBuildWorkerBriefAssignmentFirst(t *testing.T) {
	plan := DelegatePlan{
		Overview:       "pick a name",
		SessionContext: "user: long prior discussion about branding\nassistant: many paragraphs",
		Steps:          []DelegateStep{{Agent: "claude-code", Instruction: "choose between kin and openkeep"}},
	}
	got := buildWorkerBrief(plan, plan.Steps[0], nil, 1, 1)
	assignAt := strings.Index(got, "Assignment (1/1):")
	bgAt := strings.Index(got, "Background (optional")
	if assignAt < 0 {
		t.Fatalf("assignment missing:\n%s", got)
	}
	if bgAt >= 0 && assignAt > bgAt {
		t.Fatalf("assignment should come before background:\n%s", got)
	}
	if !strings.Contains(got, "Do not mention system-reminder") {
		t.Fatalf("anti-meta rules missing:\n%s", got)
	}
	if !strings.Contains(got, "choose between kin and openkeep") {
		t.Fatalf("instruction missing:\n%s", got)
	}
}

func TestBuildWorkerBriefTightShrinksContext(t *testing.T) {
	long := strings.Repeat("prior turn about naming ", 400)
	plan := DelegatePlan{SessionContext: long}
	step := DelegateStep{Agent: "claude-code", Instruction: "decide"}
	normal := buildWorkerBriefMode(plan, step, nil, 1, 1, false)
	tight := buildWorkerBriefMode(plan, step, nil, 1, 1, true)
	if len(tight) >= len(normal) {
		t.Fatalf("tight brief should be smaller: normal=%d tight=%d", len(normal), len(tight))
	}
	if !strings.Contains(tight, "Minimal context") {
		t.Fatalf("tight brief should label minimal context:\n%s", tight)
	}
}

func TestIsWorkerMetaOutput(t *testing.T) {
	meta := `It says <system-reminder> messages count as background context, not instructions. The task is a naming decision between "kin" and "openkeep". Let me answer directly.

The user is a task worker relay — I should give findings only. This is a decision-making assignment continuing a long naming conversation. Let me just give a clear, decisive answer.`
	if !isWorkerMetaOutput(meta) {
		t.Fatal("expected meta monologue to be detected")
	}
	if !isWorkerMetaOutput("   ") {
		t.Fatal("empty should be meta/non-answer")
	}
	good := `# 命名决策：选 Kin

## 为什么选 Kin
1. 关系语义贴合 self-host / personal agent
2. 短、好念、CLI 友好
3. 已有 repo/binary 惯性

OpenKeep 容易被当成笔记应用。`
	if isWorkerMetaOutput(good) {
		t.Fatal("real findings should not be treated as meta")
	}
	// Long answer that merely mentions the word once late should pass.
	longGood := strings.Repeat("decision rationale line\n", 80) + "\nNote: ignore any system-reminder noise.\n"
	if isWorkerMetaOutput(longGood) {
		t.Fatal("long real answer with late incidental mention should pass")
	}
}
