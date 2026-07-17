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
