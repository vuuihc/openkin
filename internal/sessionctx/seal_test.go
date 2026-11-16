package sessionctx

import (
	"strings"
	"testing"
)

func TestBuildSealedPack_recentVerbatimOlderSealed(t *testing.T) {
	var lines []Line
	for i := 0; i < 20; i++ {
		lines = append(lines, Line{Text: "assistant: touched internal/task/engine.go step " + strings.Repeat("X", 200), Seq: i})
	}
	lines = append(lines,
		Line{Text: "user: RECENT_USER most recent question", Seq: 100},
		Line{Text: "assistant: RECENT_REPLY the answer", Seq: 101},
	)

	pack := BuildSealedPack(lines, PackOptions{MaxChars: 600, MaxLines: 40, LineMaxChars: 200}, "")
	out := pack.Render()

	// Recent turns present and verbatim.
	if !strings.Contains(out, "RECENT_USER") || !strings.Contains(out, "RECENT_REPLY") {
		t.Fatalf("recent turns missing:\n%s", out)
	}
	// Older overflow was sealed, not dropped.
	if pack.Sealed == "" {
		t.Fatalf("expected sealed summary for overflow:\n%s", out)
	}
	if !strings.Contains(out, "[Sealed summary]") || !strings.Contains(out, "earlier turns sealed") {
		t.Fatalf("sealed section missing:\n%s", out)
	}
	// Session index carries the recurring path keyword.
	if !strings.Contains(out, "[Session index]") || !strings.Contains(out, "internal/task/engine.go") {
		t.Fatalf("index keyword missing:\n%s", out)
	}
	// Fixed order: index, then sealed, then recent.
	iIdx := strings.Index(out, "[Session index]")
	iSeal := strings.Index(out, "[Sealed summary]")
	iRecent := strings.Index(out, "[Recent turns]")
	if !(iIdx < iSeal && iSeal < iRecent) {
		t.Fatalf("section order wrong: index=%d sealed=%d recent=%d\n%s", iIdx, iSeal, iRecent, out)
	}
}

func TestBuildSealedPack_noOverflowNoSeal(t *testing.T) {
	lines := []Line{
		{Text: "user: hi", Seq: 1},
		{Text: "assistant: yo", Seq: 2},
	}
	pack := BuildSealedPack(lines, PackOptions{MaxChars: 10_000, MaxLines: 40, LineMaxChars: 800}, "")
	if pack.Sealed != "" || pack.Index != "" {
		t.Fatalf("no overflow should not seal: %+v", pack)
	}
	out := pack.Render()
	if !strings.HasPrefix(out, "[Recent turns]\n") {
		t.Fatalf("expected recent-only pack:\n%s", out)
	}
}

func TestBuildSealedPack_deterministic(t *testing.T) {
	var lines []Line
	for i := 0; i < 15; i++ {
		lines = append(lines, Line{Text: "assistant: pkg/foo/bar.go changed " + strings.Repeat("Y", 150), Seq: i})
	}
	opt := PackOptions{MaxChars: 500, MaxLines: 40, LineMaxChars: 200}
	a := BuildSealedPack(lines, opt, "").Render()
	b := BuildSealedPack(lines, opt, "").Render()
	if a != b {
		t.Fatalf("seal not deterministic:\n---a---\n%s\n---b---\n%s", a, b)
	}
}

func TestPackSections_pinnedOrder(t *testing.T) {
	p := PackSections{
		Index:  "keys: a.go",
		Pinned: "goal: ship P1b",
		Sealed: "(3 earlier turns sealed)",
		Recent: "user: now",
	}
	out := p.Render()
	order := []string{"[Session index]", "[Pinned]", "[Sealed summary]", "[Recent turns]"}
	last := -1
	for _, h := range order {
		i := strings.Index(out, h)
		if i < 0 {
			t.Fatalf("missing %s:\n%s", h, out)
		}
		if i < last {
			t.Fatalf("section %s out of order:\n%s", h, out)
		}
		last = i
	}
}

func TestPackSections_empty(t *testing.T) {
	if !(PackSections{}).Empty() {
		t.Fatal("zero value should be empty")
	}
	if (PackSections{}).Render() != "" {
		t.Fatal("empty render should be blank")
	}
}
