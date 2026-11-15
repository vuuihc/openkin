package sessionctx

import (
	"strings"
	"testing"
)

func TestBuildPack_newestFirstSurvivesOverflow(t *testing.T) {
	// Many large old lines + two recent short ones that must survive.
	var lines []Line
	for i := 0; i < 20; i++ {
		lines = append(lines, Line{Text: "old: " + strings.Repeat("X", 200), Seq: i})
	}
	lines = append(lines,
		Line{Text: "user: immediately previous turn about context overflow", Seq: 100},
		Line{Text: "assistant: agreed, we should fix newest-first packing", Seq: 101},
	)

	// Budget fits only ~3 short lines, not the old block.
	pack := BuildPack(lines, PackOptions{MaxChars: 500, MaxLines: 40, LineMaxChars: 200})
	if pack == "" {
		t.Fatal("empty pack")
	}
	if !strings.Contains(pack, "immediately previous turn") {
		t.Fatalf("recent user turn missing:\n%s", pack)
	}
	if !strings.Contains(pack, "newest-first packing") {
		t.Fatalf("recent assistant turn missing:\n%s", pack)
	}
	// Chronological: previous user before assistant.
	ui := strings.Index(pack, "immediately previous")
	ai := strings.Index(pack, "newest-first packing")
	if ui < 0 || ai < 0 || ui > ai {
		t.Fatalf("order wrong: user@%d assistant@%d\n%s", ui, ai, pack)
	}
}

func TestBuildPack_maxLines(t *testing.T) {
	lines := []Line{
		{Text: "user: a"},
		{Text: "assistant: b"},
		{Text: "user: c"},
		{Text: "assistant: d"},
	}
	pack := BuildPack(lines, PackOptions{MaxChars: 10_000, MaxLines: 2, LineMaxChars: 100})
	if strings.Contains(pack, "user: a") || strings.Contains(pack, "assistant: b") {
		t.Fatalf("should drop oldest: %q", pack)
	}
	if !strings.Contains(pack, "user: c") || !strings.Contains(pack, "assistant: d") {
		t.Fatalf("should keep newest two: %q", pack)
	}
}

func TestBuildPack_empty(t *testing.T) {
	if BuildPack(nil, PackOptions{}) != "" {
		t.Fatal("expected empty")
	}
}

func TestCollapseToolPayload(t *testing.T) {
	out := CollapseToolPayload("bash", "line1\nline2\nline3", 20)
	if !strings.Contains(out, "bash →") {
		t.Fatalf("got %q", out)
	}
	if !strings.Contains(out, "3 lines") {
		t.Fatalf("got %q", out)
	}
}

func TestTruncateRunes(t *testing.T) {
	if TruncateRunes("你好世界", 3) != "你好…" {
		t.Fatalf("got %q", TruncateRunes("你好世界", 3))
	}
}
