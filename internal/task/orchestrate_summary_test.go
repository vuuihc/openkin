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

func TestResponseLanguageForPrompt(t *testing.T) {
	tests := []struct {
		name   string
		prompt string
		want   responseLanguage
	}{
		{name: "Chinese", prompt: "请修复登录问题并说明原因", want: responseLanguageChinese},
		{name: "English", prompt: "Fix the login issue and explain why", want: responseLanguageEnglish},
		{name: "Chinese prompt explicitly asks English", prompt: "请修复登录问题，用英文回答", want: responseLanguageEnglish},
		{name: "English prompt explicitly asks Chinese", prompt: "Fix the login issue and answer in Chinese", want: responseLanguageChinese},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := responseLanguageForPrompt(tt.prompt); got != tt.want {
				t.Fatalf("language=%v want %v", got, tt.want)
			}
		})
	}
}

func TestCleanUserFacingSynthesis(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		lang responseLanguage
		want string
		ok   bool
	}{
		{
			name: "removes orchestration wrapper",
			raw:  "Multi-agent run summary\n\nRequest: fix the login flow\nWorker: [Codex] (ok)\nDeliverable: The login flow now validates tokens.\n\nDetails in task log / session_search",
			lang: responseLanguageEnglish,
			want: "The login flow now validates tokens.",
			ok:   true,
		},
		{
			name: "rejects marker-only response",
			raw:  "[Codex] (ok)\nWorker Digest\n… details in task log / session_search",
			lang: responseLanguageEnglish,
			ok:   false,
		},
		{
			name: "rejects surviving internal prose",
			raw:  "I am the orchestration controller and here is the worker digest.",
			lang: responseLanguageEnglish,
			ok:   false,
		},
		{
			name: "rejects wrong response language",
			raw:  "The change is complete.",
			lang: responseLanguageChinese,
			ok:   false,
		},
		{
			name: "preserves Markdown indentation",
			raw:  "Fixed with:\n\n    go test ./internal/task\n\n- result\n  - nested",
			lang: responseLanguageEnglish,
			want: "Fixed with:\n\n    go test ./internal/task\n\n- result\n  - nested",
			ok:   true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := cleanUserFacingSynthesis(tt.raw, tt.lang)
			if ok != tt.ok {
				t.Fatalf("ok=%v want %v (text=%q)", ok, tt.ok, got)
			}
			if got != tt.want {
				t.Fatalf("text=%q want %q", got, tt.want)
			}
			for _, marker := range []string{"Multi-agent", "Worker", "Deliverable", "session_search", "task log"} {
				if strings.Contains(strings.ToLower(got), strings.ToLower(marker)) {
					t.Fatalf("internal marker %q leaked: %q", marker, got)
				}
			}
		})
	}
}

func TestBuildUserFacingSummaryLanguageAndFallback(t *testing.T) {
	tests := []struct {
		name   string
		prompt string
		prior  []string
		failed []bool
		anyErr bool
		want   string
	}{
		{
			name:   "Chinese result",
			prompt: "请修复登录问题",
			prior:  []string{"[Codex]\n登录流程已修复。\n… details in task log / session_search"},
			failed: []bool{false},
			want:   "已完成：\n\n登录流程已修复。",
		},
		{
			name:   "English result",
			prompt: "Fix the login issue",
			prior:  []string{"[Codex]\nThe login flow is fixed.\n… details in task log / session_search"},
			failed: []bool{false},
			want:   "Completed:\n\nThe login flow is fixed.",
		},
		{
			name:   "explicit English override",
			prompt: "请修复登录问题，用英文回答",
			prior:  []string{"[Codex]\nThe login flow is fixed."},
			failed: []bool{false},
			want:   "Completed:\n\nThe login flow is fixed.",
		},
		{
			name:   "explicit Chinese override",
			prompt: "Fix the login issue and answer in Chinese",
			prior:  []string{"[Codex]\n登录流程已修复。"},
			failed: []bool{false},
			want:   "已完成：\n\n登录流程已修复。",
		},
		{
			name:   "Chinese empty fallback",
			prompt: "请检查构建",
			anyErr: true,
			want:   "已完成，但有部分工作未成功：\n\n没有可显示的结果。",
		},
		{
			name:   "English empty fallback",
			prompt: "Check the build",
			anyErr: true,
			want:   "Completed, but some work was unsuccessful:\n\nNo result was available to display.",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := buildUserFacingSummary(tt.prompt, tt.prior, tt.failed, tt.anyErr)
			if got != tt.want {
				t.Fatalf("summary=%q want %q", got, tt.want)
			}
			for _, marker := range []string{"Multi-agent", "Request:", "Worker", "Deliverable", "session_search", "handoff", "digest"} {
				if strings.Contains(strings.ToLower(got), strings.ToLower(marker)) {
					t.Fatalf("internal marker %q leaked: %q", marker, got)
				}
			}
		})
	}
}

func TestWithReplyLanguageHostAndIdempotent(t *testing.T) {
	zh := withReplyLanguage("请修复登录问题", "请修复登录问题")
	if !strings.Contains(zh, replyLanguageInstruction(responseLanguageChinese)) {
		t.Fatalf("chinese policy missing: %q", zh)
	}
	if !strings.HasPrefix(zh, "请修复登录问题") {
		t.Fatalf("live turn should stay first: %q", zh)
	}
	// Idempotent: wrapping twice must not duplicate.
	zh2 := withReplyLanguage(zh, "请修复登录问题")
	if zh2 != zh {
		t.Fatalf("second wrap changed prompt:\n1: %q\n2: %q", zh, zh2)
	}

	en := withReplyLanguage("Fix the login bug", "Fix the login bug")
	if !strings.Contains(en, replyLanguageInstruction(responseLanguageEnglish)) {
		t.Fatalf("english policy missing: %q", en)
	}

	// Explicit override wins over Han detection.
	override := withReplyLanguage("请修复登录问题，用英文回答", "请修复登录问题，用英文回答")
	if !strings.Contains(override, replyLanguageInstruction(responseLanguageEnglish)) {
		t.Fatalf("explicit english override missing: %q", override)
	}
	if strings.Contains(override, replyLanguageInstruction(responseLanguageChinese)) {
		t.Fatalf("should not also inject chinese: %q", override)
	}

	// Detection uses live turn only — English wrapper + Chinese live → Chinese.
	handoff := "Continue this Kin task.\n\nUser request:\n请继续"
	wrapped := withReplyLanguage(handoff, "请继续")
	if !strings.Contains(wrapped, replyLanguageInstruction(responseLanguageChinese)) {
		t.Fatalf("handoff should follow live Chinese turn: %q", wrapped)
	}
}

func TestBuildWorkerBriefIncludesReplyLanguage(t *testing.T) {
	plan := DelegatePlan{Raw: "请调研登录失败原因"}
	step := DelegateStep{Agent: "claude-code", Instruction: "查日志"}
	got := buildWorkerBrief(plan, step, nil, 1, 1)
	if !strings.Contains(got, replyLanguageInstruction(responseLanguageChinese)) {
		t.Fatalf("worker brief missing chinese policy:\n%s", got)
	}
	if !strings.Contains(got, "Respond now with findings only.") {
		t.Fatalf("worker brief missing findings rule:\n%s", got)
	}
}

