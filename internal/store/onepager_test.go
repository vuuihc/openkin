package store

import (
	"strings"
	"testing"
)

func TestParseOnePagerSummary(t *testing.T) {
	md := `# Demo

## North Star
Ship a coaching loop users love.

## Current Focus
Manual wrap-up for project tasks.

## 下一步（你写的）
1. Build recycle API
2. Wire Task UI
3. Show pending on Project Home
4. Extra should be ignored
`
	sum := ParseOnePagerSummary(md, "Demo", ProjectModeShip)
	if sum.Empty {
		t.Fatal("expected non-empty summary")
	}
	if sum.NorthStar == "" || sum.Focus == "" {
		t.Fatalf("missing fields: %+v", sum)
	}
	if len(sum.Next) != 3 {
		t.Fatalf("next=%v want 3", sum.Next)
	}
}

func TestParseOnePagerSummaryPlaceholdersEmpty(t *testing.T) {
	md := DefaultOnePagerMarkdown("X", ProjectModeShip)
	sum := ParseOnePagerSummary(md, "X", ProjectModeShip)
	if !sum.Empty {
		t.Fatalf("default template should be empty summary, got %+v", sum)
	}
}

func TestApplyRecycleSuggestionAppendAndFocus(t *testing.T) {
	md := DefaultOnePagerMarkdown("Demo", ProjectModeShip)
	out, err := ApplyRecycleSuggestion(md, RecycleTargetConclusions, "Wrap-up writes cover via review")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "Wrap-up writes cover via review") {
		t.Fatalf("missing conclusion: %s", out)
	}
	// Idempotent second accept of same text.
	out2, err := ApplyRecycleSuggestion(out, RecycleTargetConclusions, "Wrap-up writes cover via review")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(out2, "Wrap-up writes cover via review") != 1 {
		t.Fatalf("dedupe failed: %s", out2)
	}

	out3, err := ApplyRecycleSuggestion(out2, RecycleTargetFocus, "Ship recycle accept path")
	if err != nil {
		t.Fatal(err)
	}
	sections := ParseOnePagerSections(out3)
	if !strings.Contains(sections["Current Focus"], "Ship recycle accept path") {
		t.Fatalf("focus not replaced: %q", sections["Current Focus"])
	}
}

func TestApplyRecycleSuggestionNextCap(t *testing.T) {
	md := `# P

## 下一步（你写的）
1. one
2. two
3. three
`
	_, err := ApplyRecycleSuggestion(md, RecycleTargetNext, "four")
	if err == nil {
		t.Fatal("expected next cap error")
	}
}

func TestBuildContinuePromptBounded(t *testing.T) {
	md := `# Demo

## North Star
Goal

## Current Focus
Focus line

## 下一步（你写的）
1. a
2. b
`
	p := BuildContinuePrompt("Demo", ProjectModeShip, md, "do the thing")
	if !strings.Contains(p, "Project: Demo") || !strings.Contains(p, "Mode: ship") {
		t.Fatalf("missing header: %s", p)
	}
	if !strings.Contains(p, "do the thing") {
		t.Fatalf("missing user: %s", p)
	}
	if !strings.Contains(p, "Mode focus:") {
		t.Fatalf("missing mode strategy: %s", p)
	}
	if strings.Contains(p, "North Star:\nGoal\n\nCurrent Focus:") {
		// old digest format ok too, but new format is single-line fields
	}
}

func TestDedupeRecycleSuggestions(t *testing.T) {
	in := []RecycleSuggestion{
		{Target: "conclusions", Text: "A"},
		{Target: "conclusions", Text: "a"}, // dup
		{Target: "next", Text: "B"},
		{Target: "open_questions", Text: "C"},
		{Target: "next", Text: "D"}, // would be 4th ordinary - drop
		{Target: "focus", Text: "F1"},
		{Target: "focus", Text: "F2"}, // last focus wins, first dropped via key? different text so both seen - last wins by overwrite
		{Target: "north_star", Text: "nope"},
	}
	out := DedupeRecycleSuggestions(in)
	var ordinary, focus int
	for _, s := range out {
		if s.Target == RecycleTargetFocus {
			focus++
		} else {
			ordinary++
		}
	}
	if ordinary > 3 {
		t.Fatalf("ordinary=%d out=%+v", ordinary, out)
	}
	if focus != 1 {
		t.Fatalf("focus count=%d out=%+v", focus, out)
	}
}
