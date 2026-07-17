package sessionctx

import (
	"fmt"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestToolDigestBashTailAndBudget(t *testing.T) {
	// Large log: head noise + FAIL near the end — digest should keep the tail.
	var lines []string
	for i := 0; i < 100; i++ {
		lines = append(lines, "build step noise "+strings.Repeat("x", 40))
	}
	lines = append(lines, "FAIL: TestFoo")
	lines = append(lines, "--- FAIL: TestFoo (0.01s)")
	out := strings.Join(lines, "\n")
	args := `{"command":"go test ./..."}`
	d := ToolDigest("bash", args, out, false)
	if !strings.Contains(d, "bash [error]") {
		t.Fatalf("status missing: %q", d[:min(80, len(d))])
	}
	if !strings.Contains(d, "go test") {
		t.Fatalf("command missing: %s", d)
	}
	if !strings.Contains(d, "FAIL: TestFoo") {
		t.Fatalf("tail FAIL missing:\n%s", d)
	}
	// Must not contain the full dump.
	if utf8.RuneCountInString(d) > BashDigestMaxChars+200 {
		t.Fatalf("digest too large: %d runes", utf8.RuneCountInString(d))
	}
	// Deterministic.
	d2 := ToolDigest("bash", args, out, false)
	if d != d2 {
		t.Fatal("ToolDigest not deterministic")
	}
}

func TestToolDigestReadFileLarge(t *testing.T) {
	body := strings.Repeat("package foo\n", 300)
	args := `{"path":"internal/foo/bar.go"}`
	d := ToolDigest("read_file", args, body, true)
	if !strings.Contains(d, "read_file [ok] internal/foo/bar.go") {
		t.Fatalf("header: %s", d[:min(120, len(d))])
	}
	if !strings.Contains(d, "re-read") {
		t.Fatalf("should note re-read: %s", d[len(d)-80:])
	}
	if utf8.RuneCountInString(d) > ReadDigestMaxChars+300 {
		t.Fatalf("digest too large: %d", utf8.RuneCountInString(d))
	}
	// Full body must not be present.
	if strings.Count(d, "package foo") >= 300 {
		t.Fatal("full dump present in digest")
	}
}

func TestToolDigestReadFileSmall(t *testing.T) {
	body := "hello\nworld\n"
	d := ToolDigest("read_file", `{"path":"a.txt"}`, body, true)
	if !strings.Contains(d, "hello") || !strings.Contains(d, "world") {
		t.Fatalf("small file should pass through: %q", d)
	}
}

func TestToolDigestListAndGlob(t *testing.T) {
	var entries []string
	for i := 0; i < 80; i++ {
		entries = append(entries, fmt.Sprintf("file_%02d.go", i))
	}
	out := strings.Join(entries, "\n")
	d := ToolDigest("list_dir", `{"path":"pkg"}`, out, true)
	if !strings.Contains(d, "80 entries") {
		t.Fatalf("count: %s", d)
	}
	if !strings.Contains(d, "+40 more") && !strings.Contains(d, "showing first") {
		t.Fatalf("should truncate listing: %s", d)
	}
	// First entries present, last ones dropped.
	if !strings.Contains(d, entries[0]) {
		t.Fatal("first entry missing")
	}
	if strings.Contains(d, entries[len(entries)-1]) {
		t.Fatal("last entry should be dropped from digest")
	}
}

func TestToolDigestWriteFile(t *testing.T) {
	d := ToolDigest("write_file", `{"path":"a.go"}`, "wrote 12 bytes to a.go", true)
	if !strings.Contains(d, "write_file [ok]") || !strings.Contains(d, "wrote 12") {
		t.Fatalf("got %q", d)
	}
}

func TestToolDigestUnknown(t *testing.T) {
	big := strings.Repeat("Z", 5000)
	d := ToolDigest("custom_tool", `{}`, big, true)
	if utf8.RuneCountInString(d) > UnknownDigestMaxChars+50 {
		t.Fatalf("unknown tool should hard-cap: %d", utf8.RuneCountInString(d))
	}
}

func TestWorkerDigestCapsAndSignals(t *testing.T) {
	var b strings.Builder
	b.WriteString("[Claude Code]\n")
	b.WriteString("# Summary\n")
	for i := 0; i < 50; i++ {
		b.WriteString("filler narrative line number ")
		b.WriteString(strings.Repeat("n", 20))
		b.WriteByte('\n')
	}
	b.WriteString("Edited internal/sessionctx/digest.go\n")
	b.WriteString("FAIL: TestSomething\n")
	b.WriteString("- recommend: enable compact-on-entry\n")
	// pad more
	for i := 0; i < 30; i++ {
		b.WriteString("more filler ")
		b.WriteString(strings.Repeat("y", 40))
		b.WriteByte('\n')
	}
	prior := b.String()
	d := WorkerDigest(prior, false)
	if !strings.Contains(d, "[Claude Code] (ok)") {
		t.Fatalf("header: %q", d[:min(60, len(d))])
	}
	if utf8.RuneCountInString(d) > WorkerDigestMaxRunes+80 {
		t.Fatalf("worker digest too large: %d", utf8.RuneCountInString(d))
	}
	// Signal lines should survive.
	if !strings.Contains(d, "FAIL: TestSomething") && !strings.Contains(d, "digest.go") {
		t.Fatalf("signals missing:\n%s", d)
	}
	if !strings.Contains(d, "details in task log") {
		t.Fatalf("should point to archive:\n%s", d)
	}
	// Full prior must not appear.
	if strings.Count(d, "filler narrative") >= 40 {
		t.Fatal("full worker dump present")
	}
	// Deterministic.
	if d != WorkerDigest(prior, false) {
		t.Fatal("WorkerDigest not deterministic")
	}
}

func TestWorkerDigestShortPassthrough(t *testing.T) {
	prior := "[Codex]\nFixed the bug in foo.go"
	d := WorkerDigest(prior, false)
	if !strings.Contains(d, "Fixed the bug") {
		t.Fatalf("got %q", d)
	}
	if strings.Contains(d, "details in task log") {
		t.Fatalf("short answer should not need pointer: %q", d)
	}
}

func TestWorkerDigestFailed(t *testing.T) {
	d := WorkerDigest("[Codex]\nboom", true)
	if !strings.Contains(d, "(failed)") {
		t.Fatalf("got %q", d)
	}
}

func TestFormatPackSections(t *testing.T) {
	if FormatPackSections("") != "" {
		t.Fatal("empty")
	}
	got := FormatPackSections("user: hi\nassistant: yo")
	if !strings.HasPrefix(got, "[Recent turns]\n") {
		t.Fatalf("got %q", got)
	}
	if !strings.Contains(got, "user: hi") {
		t.Fatalf("got %q", got)
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
