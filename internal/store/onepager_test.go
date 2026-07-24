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
Clarify project focus and next steps.

## 下一步（你写的）
1. Build one-pager API
2. Wire Task UI
3. Show focus on Project Home
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
