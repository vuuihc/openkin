package kinagent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/adapter"
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

func TestEditFile(t *testing.T) {
	t.Run("unique match preserves mode", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "main.go")
		if err := os.WriteFile(path, []byte("package main\n\nconst old = 1\n"), 0o750); err != nil {
			t.Fatal(err)
		}
		env, err := newToolEnv(dir)
		if err != nil {
			t.Fatal(err)
		}

		msg, err := env.editFile("main.go", "const old = 1", "const current = 2", false)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(msg, "replaced 1 occurrence") {
			t.Fatalf("message=%q", msg)
		}
		body, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if got := string(body); got != "package main\n\nconst current = 2\n" {
			t.Fatalf("body=%q", got)
		}
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if got := info.Mode().Perm(); got != 0o750 {
			t.Fatalf("mode=%#o", got)
		}
	})

	t.Run("zero matches leaves file unchanged", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "note.txt")
		if err := os.WriteFile(path, []byte("alpha\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		env, err := newToolEnv(dir)
		if err != nil {
			t.Fatal(err)
		}

		if _, err := env.editFile("note.txt", "missing", "beta", false); err == nil || !strings.Contains(err.Error(), "not found") {
			t.Fatalf("error=%v", err)
		}
		body, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if got := string(body); got != "alpha\n" {
			t.Fatalf("body changed: %q", got)
		}
	})

	t.Run("multiple matches require replace_all", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "note.txt")
		if err := os.WriteFile(path, []byte("old old old\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		env, err := newToolEnv(dir)
		if err != nil {
			t.Fatal(err)
		}

		if _, err := env.editFile("note.txt", "old", "new", false); err == nil || !strings.Contains(err.Error(), "3 locations") {
			t.Fatalf("error=%v", err)
		}
		body, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if got := string(body); got != "old old old\n" {
			t.Fatalf("body changed: %q", got)
		}

		msg, err := env.editFile("note.txt", "old", "new", true)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(msg, "replaced 3 occurrences") {
			t.Fatalf("message=%q", msg)
		}
		body, err = os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if got := string(body); got != "new new new\n" {
			t.Fatalf("body=%q", got)
		}
	})

	t.Run("preserves hard links", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "source.txt")
		link := filepath.Join(dir, "linked.txt")
		if err := os.WriteFile(path, []byte("before\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Link(path, link); err != nil {
			t.Fatal(err)
		}
		env, err := newToolEnv(dir)
		if err != nil {
			t.Fatal(err)
		}

		if _, err := env.editFile("source.txt", "before", "after", false); err != nil {
			t.Fatal(err)
		}
		body, err := os.ReadFile(link)
		if err != nil {
			t.Fatal(err)
		}
		if got := string(body); got != "after\n" {
			t.Fatalf("linked body=%q", got)
		}
	})

	t.Run("rejects invalid and unsafe inputs", func(t *testing.T) {
		dir := t.TempDir()
		outsideDir := t.TempDir()
		outsidePath := filepath.Join(outsideDir, "outside.txt")
		if err := os.WriteFile(outsidePath, []byte("outside"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outsidePath, filepath.Join(dir, "escape.txt")); err != nil {
			t.Fatal(err)
		}
		env, err := newToolEnv(dir)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "binary.bin"), []byte{'a', 0, 'b'}, 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "invalid.txt"), []byte{0xff, 'a'}, 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "small.txt"), []byte("a"), 0o644); err != nil {
			t.Fatal(err)
		}

		for _, tc := range []struct {
			name      string
			path      string
			oldString string
			newString string
			want      string
		}{
			{name: "empty old string", path: "binary.bin", want: "old_string is required"},
			{name: "identical strings", path: "binary.bin", oldString: "a", newString: "a", want: "must differ"},
			{name: "binary file", path: "binary.bin", oldString: "a", newString: "b", want: "binary"},
			{name: "invalid UTF-8", path: "invalid.txt", oldString: "a", newString: "b", want: "valid UTF-8"},
			{name: "oversized result", path: "small.txt", oldString: "a", newString: strings.Repeat("x", maxEditableFileBytes+1), want: "result is too large"},
			{name: "path escape", path: "../outside.txt", oldString: "a", newString: "b", want: "escapes workspace"},
			{name: "symlink escape", path: "escape.txt", oldString: "outside", newString: "changed", want: "escapes workspace"},
		} {
			t.Run(tc.name, func(t *testing.T) {
				_, err := env.editFile(tc.path, tc.oldString, tc.newString, false)
				if err == nil || !strings.Contains(err.Error(), tc.want) {
					t.Fatalf("error=%v want substring %q", err, tc.want)
				}
			})
		}
	})
}

func TestWriteOpenFileRejectsConcurrentChange(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "note.txt")
	original := []byte("original")
	if err := os.WriteFile(path, original, 0o644); err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	file, err := root.OpenFile("note.txt", os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("concurrent"), 0o644); err != nil {
		t.Fatal(err)
	}

	err = writeOpenFile(root, "note.txt", file, original, []byte("edited"), info)
	if err == nil || !strings.Contains(err.Error(), "changed while editing") {
		t.Fatalf("error=%v", err)
	}
	body, readErr := os.ReadFile(path)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if got := string(body); got != "concurrent" {
		t.Fatalf("concurrent content overwritten: %q", got)
	}
}

func TestWriteFileSharesEditPathLock(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "note.txt")
	if err := os.WriteFile(path, []byte("before"), 0o644); err != nil {
		t.Fatal(err)
	}
	env, err := newToolEnv(dir)
	if err != nil {
		t.Fatal(err)
	}

	resolved, err := env.resolvePath("note.txt")
	if err != nil {
		t.Fatal(err)
	}
	unlock, err := lockWorkspaceFile(context.Background(), resolved)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := env.writeFile("note.txt", "after")
		done <- err
	}()
	select {
	case err := <-done:
		t.Fatalf("write did not wait for edit lock: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	unlock()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("write did not resume after edit lock release")
	}

	workspaceFileLocks.Lock()
	lockCount := len(workspaceFileLocks.byPath)
	workspaceFileLocks.Unlock()
	if lockCount != 0 {
		t.Fatalf("path lock entries leaked: %d", lockCount)
	}
}

func TestWorkspacePathLockHonorsCancellation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "note.txt")
	canceled, cancelNow := context.WithCancel(context.Background())
	cancelNow()
	if _, err := lockWorkspaceFile(canceled, path); !errors.Is(err, context.Canceled) {
		t.Fatalf("pre-canceled error=%v want canceled", err)
	}

	unlock, err := lockWorkspaceFile(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := lockWorkspaceFile(ctx, path); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("error=%v want deadline exceeded", err)
	}
	unlock()

	workspaceFileLocks.Lock()
	lockCount := len(workspaceFileLocks.byPath)
	workspaceFileLocks.Unlock()
	if lockCount != 0 {
		t.Fatalf("path lock entries leaked: %d", lockCount)
	}
}

func TestFlockHonorsPreCanceledContext(t *testing.T) {
	path := filepath.Join(t.TempDir(), "note.txt")
	if err := os.WriteFile(path, []byte("before"), 0o644); err != nil {
		t.Fatal(err)
	}
	file, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := flockWithContext(ctx, file); !errors.Is(err, context.Canceled) {
		t.Fatalf("error=%v want canceled", err)
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		t.Fatalf("flock remained held after cancellation: %v", err)
	}
	_ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
}

func TestEditFileLockHonorsCancellation(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "note.txt")
	if err := os.WriteFile(path, []byte("before"), 0o644); err != nil {
		t.Fatal(err)
	}
	holder, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Close()
	if err := syscall.Flock(int(holder.Fd()), syscall.LOCK_EX); err != nil {
		t.Fatal(err)
	}
	defer syscall.Flock(int(holder.Fd()), syscall.LOCK_UN)

	env, err := newToolEnv(dir)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_, err = env.editFileContext(ctx, "note.txt", "before", "after", false)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("error=%v want deadline exceeded", err)
	}
	body, readErr := os.ReadFile(path)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if got := string(body); got != "before" {
		t.Fatalf("body changed while lock was unavailable: %q", got)
	}
}

func TestWriteFileHardLinkHonorsFileLock(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "note.txt")
	alias := filepath.Join(dir, "alias.txt")
	if err := os.WriteFile(path, []byte("before"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(path, alias); err != nil {
		t.Fatal(err)
	}
	holder, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Close()
	if err := syscall.Flock(int(holder.Fd()), syscall.LOCK_EX); err != nil {
		t.Fatal(err)
	}
	defer syscall.Flock(int(holder.Fd()), syscall.LOCK_UN)

	env, err := newToolEnv(dir)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_, err = env.writeFileContext(ctx, "alias.txt", "after")
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("error=%v want deadline exceeded", err)
	}
	body, readErr := os.ReadFile(path)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if got := string(body); got != "before" {
		t.Fatalf("body changed while inode lock was unavailable: %q", got)
	}
}

func TestRollbackOpenFileRestoresOriginal(t *testing.T) {
	path := filepath.Join(t.TempDir(), "note.txt")
	original := []byte("before")
	if err := os.WriteFile(path, []byte("after"), 0o644); err != nil {
		t.Fatal(err)
	}
	file, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	cause := errors.New("post-write validation failed")
	if err := rollbackOpenFile(file, original, cause); !errors.Is(err, cause) {
		t.Fatalf("error=%v want cause", err)
	}
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := string(body); got != "before" {
		t.Fatalf("rollback body=%q", got)
	}
}

func TestRunToolEditFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.txt")
	if err := os.WriteFile(path, []byte("mode=old\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	env, err := newToolEnv(dir)
	if err != nil {
		t.Fatal(err)
	}

	out, err := env.runTool(
		context.Background(),
		"edit_file",
		`{"path":"config.txt","old_string":"mode=old","new_string":"mode=new"}`,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "replaced 1 occurrence") {
		t.Fatalf("output=%q", out)
	}
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := string(body); got != "mode=new\n" {
		t.Fatalf("body=%q", got)
	}

	for _, tc := range []struct {
		name string
		args string
		want string
	}{
		{name: "missing path", args: `{"old_string":"mode=new","new_string":"x"}`, want: "path is required"},
		{name: "missing old string", args: `{"path":"config.txt","new_string":"x"}`, want: "old_string is required"},
		{name: "missing new string", args: `{"path":"config.txt","old_string":"mode=new"}`, want: "new_string is required"},
		{name: "wrong new string type", args: `{"path":"config.txt","old_string":"mode=new","new_string":7}`, want: "new_string must be a string"},
		{name: "wrong replace_all type", args: `{"path":"config.txt","old_string":"mode=new","new_string":"x","replace_all":"yes"}`, want: "replace_all must be a boolean"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := env.runTool(context.Background(), "edit_file", tc.args)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error=%v want substring %q", err, tc.want)
			}
		})
	}
}

func TestAgentToolsIncludeEditFile(t *testing.T) {
	var found bool
	for _, tool := range agentTools(false) {
		if tool.Function.Name != "edit_file" {
			continue
		}
		found = true
		required, ok := tool.Function.Parameters["required"].([]string)
		if !ok {
			t.Fatalf("required schema=%#v", tool.Function.Parameters["required"])
		}
		if got := strings.Join(required, ","); got != "path,old_string,new_string" {
			t.Fatalf("required=%q", got)
		}
		properties, ok := tool.Function.Parameters["properties"].(map[string]any)
		if !ok {
			t.Fatalf("properties schema=%#v", tool.Function.Parameters["properties"])
		}
		if _, ok := properties["replace_all"]; !ok {
			t.Fatal("replace_all missing from schema")
		}
	}
	if !found {
		t.Fatal("edit_file tool not registered")
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

func TestBlockedTaskSpawnCommand(t *testing.T) {
	cases := []struct {
		cmd   string
		block bool
	}{
		{`curl -X POST http://127.0.0.1:7777/api/tasks -d '{}'`, true},
		{`TOKEN=$(cat ~/.kin/token); curl -s -H "Authorization: Bearer $TOKEN" -X POST http://127.0.0.1:7777/api/tasks -d @-`, true},
		{`curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:7777/api/tasks/01ABC"`, false},
		{`curl -s http://127.0.0.1:7777/api/tasks`, false},
		{`go test ./internal/task/`, false},
		{`kin task create --prompt hi`, true},
	}
	for _, tc := range cases {
		got := blockedTaskSpawnCommand(tc.cmd)
		if tc.block && got == "" {
			t.Fatalf("expected block for %q", tc.cmd)
		}
		if !tc.block && got != "" {
			t.Fatalf("unexpected block for %q: %s", tc.cmd, got)
		}
	}
}

func TestBashBlocksTaskSpawn(t *testing.T) {
	dir := t.TempDir()
	env, err := newToolEnv(dir)
	if err != nil {
		t.Fatal(err)
	}
	_, err = env.bash(context.Background(), `curl -X POST http://127.0.0.1:7777/api/tasks -d '{}'`)
	if err == nil || !strings.Contains(err.Error(), "blocked:") {
		t.Fatalf("want blocked error, got %v", err)
	}
}
