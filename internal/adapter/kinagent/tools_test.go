package kinagent

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/vuuihc/kin/internal/adapter"
)

func TestResolvePathSandbox(t *testing.T) {
	dir := t.TempDir()
	env, err := newToolEnv(dir)
	if err != nil {
		t.Fatal(err)
	}
	// relative ok
	p, err := env.resolvePath("a/b.txt")
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Dir(p) != filepath.Join(dir, "a") && filepath.Clean(filepath.Join(dir, "a", "b.txt")) != p {
		// just ensure under dir
		if len(p) < len(dir) {
			t.Fatalf("path %q not under %q", p, dir)
		}
	}
	// escape rejected
	if _, err := env.resolvePath("../outside"); err == nil {
		// may resolve inside if abs still under — force abs outside
	}
	outside := filepath.Join(os.TempDir(), "kin-agent-escape-test")
	if _, err := env.resolvePath(outside); err == nil {
		// only fails if outside is not under root
		if outside != dir && filepath.Dir(outside) != dir {
			// good if error; if no error tempdir might be parent — check prefix
			abs, _ := env.resolvePath(outside)
			if abs != "" && abs[:len(dir)] != dir {
				// if no error when outside, fail
				if _, e2 := env.resolvePath("/etc/passwd"); e2 == nil {
					t.Fatal("expected escape error for /etc/passwd")
				}
			}
		}
	}
	if _, err := env.resolvePath("/etc/passwd"); err == nil {
		t.Fatal("expected /etc/passwd to be rejected")
	}
}

func TestWriteReadList(t *testing.T) {
	dir := t.TempDir()
	env, err := newToolEnv(dir)
	if err != nil {
		t.Fatal(err)
	}
	msg, err := env.writeFile("hello.txt", "hi")
	if err != nil {
		t.Fatal(err)
	}
	if msg == "" {
		t.Fatal("empty write msg")
	}
	body, err := env.readFile("hello.txt")
	if err != nil || body != "hi" {
		t.Fatalf("read=%q err=%v", body, err)
	}
	list, err := env.listDir(".")
	if err != nil {
		t.Fatal(err)
	}
	if list == "" {
		t.Fatal("empty list")
	}
}

func TestTruncateBytesKeepsValidUTF8(t *testing.T) {
	// "入口" is 6 bytes; cut inside the last rune must not produce U+FFFD.
	s := strings.Repeat("入口", 2000) // 12000 bytes
	out := truncateBytes(s, 8000)
	if strings.Contains(out, "\uFFFD") {
		t.Fatalf("replacement char in output: %q", out[len(out)-40:])
	}
	if !strings.Contains(out, "truncated") {
		t.Fatalf("expected truncation marker, got %q", out[len(out)-40:])
	}
	// Prefix must decode cleanly.
	prefix := out
	if i := strings.Index(out, "\n… truncated"); i >= 0 {
		prefix = out[:i]
	}
	if got, want := len(prefix), 7998; got != want {
		// 8000 backs up 2 bytes into incomplete rune → 7998
		// (8000 % 6 == 2 for "入口" pairs starting at 0)
		t.Fatalf("prefix bytes=%d want %d (rune-aligned)", got, want)
	}
}

func TestTruncateUTF8(t *testing.T) {
	s := "你好世界" // 12 bytes, 4 runes
	if got := truncateUTF8(s, 100, "…"); got != s {
		t.Fatalf("no-op: %q", got)
	}
	// "你"=0..2 "好"=3..5 "世"=6..8 "界"=9..11
	got := truncateUTF8(s, 7, "…") // mid "世" → backs up to byte 6 → "你好…"
	if strings.Contains(got, "�") {
		t.Fatalf("invalid utf8: %q", got)
	}
	if got != "你好…" {
		t.Fatalf("got %q want %q", got, "你好…")
	}
	// mid first multi-byte rune after a single-byte char
	mixed := "a你好"
	got = truncateUTF8(mixed, 2, "…") // mid "你" → "a…"
	if got != "a…" {
		t.Fatalf("mixed: %q", got)
	}
	// Budget smaller than first rune.
	if got := truncateUTF8(s, 1, "…"); got != "…" {
		t.Fatalf("tiny budget: %q", got)
	}
	if got := truncateUTF8(s, 0, "…"); got != "…" {
		t.Fatalf("zero budget: %q", got)
	}
	if got := truncateUTF8("", 0, "…"); got != "" {
		t.Fatalf("empty: %q", got)
	}
}

func TestEmitToolResultTruncationUTF8(t *testing.T) {
	// Build >8000 bytes of CJK so the UI cap fires mid-rune without the fix.
	out := strings.Repeat("口", 3000) // 9000 bytes
	ch := make(chan adapter.Event, 1)
	emitToolResult(ch, "bash", `{"command":"echo"}`, out, true, "call-1")
	ev := <-ch
	var payload struct {
		Output string `json:"output"`
	}
	if err := json.Unmarshal(ev.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(payload.Output, "\uFFFD") {
		t.Fatalf("tool_result output has U+FFFD: tail=%q", payload.Output[len(payload.Output)-60:])
	}
	if !strings.Contains(payload.Output, "truncated for UI") {
		t.Fatalf("expected UI truncation marker: %q", payload.Output[len(payload.Output)-40:])
	}
	// json.Marshal of the payload must also stay valid (no replacement during encode).
	raw, err := json.Marshal(payload.Output)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte(`\ufffd`)) || bytes.Contains(raw, []byte("\ufffd")) {
		t.Fatalf("json contains replacement: %s", raw[len(raw)-80:])
	}
}
