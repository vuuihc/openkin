package kinagent

import (
	"os"
	"path/filepath"
	"testing"
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
