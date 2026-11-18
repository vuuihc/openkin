package store

import (
	"strings"
	"testing"
	"unicode/utf8"
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

// KIN-PROJECT-003: the cover's "工作方式" section is part of the digest a new
// chat receives. It keeps the section's own line breaks (a build command and a
// list are not one sentence), stays inside the 400-rune per-section bound and
// the existing 1200-rune context budget, and adds nothing when the document
// has no real content for it.
func TestBuildContinuePromptWorkInstructions(t *testing.T) {
	t.Run("KIN-PROJECT-003: carries the section between Current Focus and Next", func(t *testing.T) {
		md := `# Demo

## North Star
Goal

## Current Focus
ship the slice

## 工作方式
先跑 make test
不要手改 generated/

- 先读 docs/README.md

## 下一步（你写的）
1. a
2. b
`
		p := BuildContinuePrompt("Demo", ProjectModeShip, md, "do the thing")
		want := "How to work here:\n先跑 make test\n不要手改 generated/\n\n- 先读 docs/README.md"
		if !strings.Contains(p, want) {
			t.Fatalf("work instructions missing or reflowed: %q", p)
		}
		focus := strings.Index(p, "Current Focus:")
		work := strings.Index(p, "How to work here:")
		next := strings.Index(p, "\nNext:\n")
		if focus < 0 || work < 0 || next < 0 || !(focus < work && work < next) {
			t.Fatalf("order focus=%d work=%d next=%d in %q", focus, work, next, p)
		}
		_, user, ok := strings.Cut(p, "\n---\n")
		if !ok || strings.TrimSpace(user) != "do the thing" {
			t.Fatalf("user prompt lost after separator: %q", p)
		}
	})

	for _, heading := range []string{"How to work here", "Instructions"} {
		t.Run("KIN-PROJECT-003: reads the "+heading+" alias", func(t *testing.T) {
			md := "# Demo\n\n## " + heading + "\nrun the tests\n"
			p := BuildContinuePrompt("Demo", ProjectModeShip, md, "go")
			if !strings.Contains(p, "How to work here:\nrun the tests") {
				t.Fatalf("alias %q not read: %q", heading, p)
			}
		})
	}

	t.Run("KIN-PROJECT-003: empty, placeholder and absent sections add nothing", func(t *testing.T) {
		docs := map[string]string{
			"empty":      "# Demo\n\n## 工作方式\n\n## 下一步（你写的）\n1. a\n",
			"dash":       "# Demo\n\n## 工作方式\n-\n",
			"em dash":    "# Demo\n\n## 工作方式\n—\n",
			"absent":     "# Demo\n\n## Current Focus\nship\n",
			"whitespace": "# Demo\n\n## 工作方式\n \n\t\n",
		}
		for name, md := range docs {
			if p := BuildContinuePrompt("Demo", ProjectModeShip, md, "go"); strings.Contains(p, "How to work here:") {
				t.Fatalf("%s: unexpected instructions: %q", name, p)
			}
		}
	})

	t.Run("KIN-PROJECT-003: a 500-rune body is cut to 400 runes plus an ellipsis", func(t *testing.T) {
		body := strings.Repeat("工", 500)
		md := "# Demo\n\n## 工作方式\n" + body + "\n"
		p := BuildContinuePrompt("Demo", ProjectModeShip, md, "go")
		want := "How to work here:\n" + strings.Repeat("工", 400) + "…"
		if !strings.Contains(p, want) {
			t.Fatalf("truncated body missing: %q", p)
		}
		if strings.Contains(p, strings.Repeat("工", 401)) {
			t.Fatalf("body was not cut at 400 runes: %q", p)
		}
		ctx, _, _ := strings.Cut(p, "\n---\n")
		if got := utf8.RuneCountInString(ctx); got > OnePagerDigestMaxRunes {
			t.Fatalf("context runes = %d, want <= %d", got, OnePagerDigestMaxRunes)
		}
	})

	t.Run("KIN-PROJECT-003: the default template has an empty section", func(t *testing.T) {
		md := DefaultOnePagerMarkdown("Demo", ProjectModeShip)
		if !strings.Contains(md, "## 工作方式\n\n## ") {
			t.Fatalf("template has no empty work-instructions section: %q", md)
		}
		if p := BuildContinuePrompt("Demo", ProjectModeShip, md, "go"); strings.Contains(p, "How to work here:") {
			t.Fatalf("default template injected instructions: %q", p)
		}
	})
}
