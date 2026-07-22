package projectpulse

import (
	"strings"
	"testing"

	"github.com/vuuihc/kin/internal/store"
)

func TestMergeAutoSection(t *testing.T) {
	base := "# Demo\n\n## 项目描述\nhi\n\n"
	merged := MergeAutoSection(base, "## Pulse（自动）\n\n- x\n")
	if !strings.Contains(merged, AutoStart) || !strings.Contains(merged, AutoEnd) {
		t.Fatalf("markers missing: %s", merged)
	}
	if !strings.Contains(merged, "## 项目描述") {
		t.Fatal("user section lost")
	}
	again := MergeAutoSection(merged, "## Pulse（自动）\n\n- y\n")
	if strings.Count(again, AutoStart) != 1 {
		t.Fatalf("expected single auto block, got %s", again)
	}
	if !strings.Contains(again, "- y") || strings.Contains(again, "- x") {
		t.Fatalf("auto body not replaced: %s", again)
	}
}

func TestRenderAutoMarkdown(t *testing.T) {
	p := Pulse{
		WindowDays:      90,
		SessionWindow:   3,
		SessionTotal:    5,
		SessionsWaiting: 1,
		GitAvailable:    true,
		GitRoot:         "/tmp/demo",
		CommitWindow:    2,
		TopPaths:        []PathStat{{Path: "internal", Count: 4}},
	}
	md := renderAutoMarkdown(p, store.Project{Name: "demo", SoftProgress: store.SoftProgressFog})
	if !strings.Contains(md, "Pulse") || !strings.Contains(md, "建议下一步") {
		t.Fatalf("md=%s", md)
	}
	if !strings.Contains(md, "internal") {
		t.Fatalf("missing module hint: %s", md)
	}
}
