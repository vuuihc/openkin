package workspace

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestGitHelperProcess is not a real test; it is re-exec'd as a fake git binary.
func TestGitHelperProcess(t *testing.T) {
	if os.Getenv("KIN_GIT_HELPER") != "1" {
		return
	}
	args := os.Args
	// Args after "--" are the git argv (including fake "git" path as argv0 from exec).
	// When invoked as: testbin -test.run=TestGitHelperProcess -- <git-args...>
	dash := -1
	for i, a := range args {
		if a == "--" {
			dash = i
			break
		}
	}
	gitArgs := []string{}
	if dash >= 0 && dash+1 < len(args) {
		gitArgs = args[dash+1:]
	}

	// Behavior switches via KIN_GIT_HELPER_MODE.
	switch os.Getenv("KIN_GIT_HELPER_MODE") {
	case "echo-args":
		// Print argv joined by \n so tests can assert no shell metachar expansion.
		fmt.Print(strings.Join(gitArgs, "\n"))
		os.Exit(0)
	case "echo-env":
		key := os.Getenv("KIN_GIT_HELPER_ENVKEY")
		fmt.Print(os.Getenv(key))
		os.Exit(0)
	case "stderr-large":
		// Write more than 64 KiB to stderr, exit 1.
		chunk := bytes.Repeat([]byte("E"), 1024)
		for i := 0; i < 80; i++ {
			_, _ = os.Stderr.Write(chunk)
		}
		os.Exit(1)
	case "stdout-large":
		chunk := bytes.Repeat([]byte("O"), 1024)
		for i := 0; i < 70; i++ { // 70 KiB > 64 KiB control limit
			_, _ = os.Stdout.Write(chunk)
		}
		os.Exit(0)
	case "sleep":
		time.Sleep(5 * time.Second)
		os.Exit(0)
	default:
		fmt.Fprintf(os.Stderr, "unknown helper mode\n")
		os.Exit(2)
	}
}

func helperGit(t *testing.T, mode string, extraEnv map[string]string) execGit {
	t.Helper()
	env := []string{
		"KIN_GIT_HELPER=1",
		"KIN_GIT_HELPER_MODE=" + mode,
	}
	for k, v := range extraEnv {
		env = append(env, k+"="+v)
	}
	// Wrap os/exec so Run uses the test binary as Path, but we need execGit.Path
	// to be the test executable and inject helper args. Use a custom runner instead.
	_ = env
	return execGit{Path: fakeGitPath(t, mode, extraEnv)}
}

// fakeGitPath writes a tiny shell-free wrapper... we cannot use shell.
// Instead return the test binary path; execGit will be replaced by helperRunner in tests.

type helperRunner struct {
	mode string
	env  map[string]string
}

func (h helperRunner) Run(ctx context.Context, dir string, env map[string]string, stdoutLimit int64, args ...string) ([]byte, error) {
	// Merge caller env with helper mode env, then force through execGit against test binary.
	merged := map[string]string{
		"KIN_GIT_HELPER":      "1",
		"KIN_GIT_HELPER_MODE": h.mode,
	}
	for k, v := range h.env {
		merged[k] = v
	}
	for k, v := range env {
		merged[k] = v
	}
	// exec.CommandContext with test binary; first args are -test.run and --
	testBin, err := os.Executable()
	if err != nil {
		return nil, err
	}
	// Use execGit but override Path to test binary and prepend helper flags via a thin adapter.
	g := execGit{Path: testBin}
	full := append([]string{"-test.run=TestGitHelperProcess", "--"}, args...)
	// We need Run to invoke testBin with those full args. execGit treats Path as git and
	// args as git args — so pass full as args with Path=testBin.
	return g.Run(ctx, dir, merged, stdoutLimit, full...)
}

func fakeGitPath(t *testing.T, mode string, extra map[string]string) string {
	t.Helper()
	// Unused when using helperRunner; kept for API symmetry.
	_ = mode
	_ = extra
	p, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestGitRunner_ArgsWithoutShell(t *testing.T) {
	r := helperRunner{mode: "echo-args"}
	// If a shell were used, the quoted/meta bits would be interpreted.
	out, err := r.Run(context.Background(), t.TempDir(), nil, ControlStdoutLimit,
		"status", "--porcelain=v1", "-z", "file; rm -rf /")
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(string(out), "\n")
	// Args after -- should be exactly the git args we passed (no shell split).
	// helper receives: -test.run=... -- status --porcelain=v1 -z "file; rm -rf /"
	// Our helper prints all args after --, which includes nothing from test harness if
	// we put them after --. Wait: g.Run passes full as args to Command(testBin, full...),
	// so argv is [testBin, -test.run=..., --, status, ...]. Helper looks for -- and
	// prints rest: status, --porcelain=v1, -z, file; rm -rf /
	if len(lines) < 4 {
		t.Fatalf("args lines=%q", string(out))
	}
	// Find status among printed args
	joined := string(out)
	if !strings.Contains(joined, "status") || !strings.Contains(joined, "file; rm -rf /") {
		t.Fatalf("expected raw args preserved, got %q", joined)
	}
	if strings.Contains(joined, "rm: ") {
		t.Fatalf("shell appears to have interpreted args: %q", joined)
	}
}

func TestGitRunner_TerminalPromptForcedZero(t *testing.T) {
	r := helperRunner{
		mode: "echo-env",
		env:  map[string]string{"KIN_GIT_HELPER_ENVKEY": "GIT_TERMINAL_PROMPT"},
	}
	// Caller tries to set a non-zero value; runner must replace with 0.
	out, err := r.Run(context.Background(), "", map[string]string{
		"GIT_TERMINAL_PROMPT": "1",
	}, ControlStdoutLimit, "rev-parse", "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != "0" {
		t.Fatalf("GIT_TERMINAL_PROMPT=%q want 0", string(out))
	}
}

func TestGitRunner_StderrCapped(t *testing.T) {
	r := helperRunner{mode: "stderr-large"}
	_, err := r.Run(context.Background(), "", nil, ControlStdoutLimit, "fail")
	if err == nil {
		t.Fatal("expected error")
	}
	msg := err.Error()
	// Error text should not include full 80 KiB of E's.
	if len(msg) > 64*1024+512 {
		t.Fatalf("error message too large: %d bytes", len(msg))
	}
	if !strings.Contains(msg, "git ") {
		t.Fatalf("error=%v", err)
	}
}

func TestGitRunner_StdoutLimit(t *testing.T) {
	r := helperRunner{mode: "stdout-large"}
	_, err := r.Run(context.Background(), "", nil, ControlStdoutLimit, "blob")
	if err == nil {
		t.Fatal("expected ErrOutputTooLarge")
	}
	if !errors.Is(err, ErrOutputTooLarge) {
		t.Fatalf("err=%v", err)
	}
}

func TestGitRunner_ContextDeadline(t *testing.T) {
	r := helperRunner{mode: "sleep"}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_, err := r.Run(ctx, "", nil, ControlStdoutLimit, "sleep")
	if err == nil {
		t.Fatal("expected deadline error")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err=%v want DeadlineExceeded", err)
	}
}

func TestGitRunner_RejectNULArg(t *testing.T) {
	g := execGit{Path: "git"}
	_, err := g.Run(context.Background(), "", nil, ControlStdoutLimit, "status", "foo\x00bar")
	if err == nil {
		t.Fatal("expected NUL rejection")
	}
	if !strings.Contains(err.Error(), "NUL") {
		t.Fatalf("err=%v", err)
	}
}

func TestGitRunner_RejectNULEnv(t *testing.T) {
	g := execGit{Path: "git"}
	_, err := g.Run(context.Background(), "", map[string]string{"BAD\x00KEY": "v"}, ControlStdoutLimit, "status")
	if err == nil {
		t.Fatal("expected NUL rejection")
	}
}

func TestMergeEnv_ReplacesDuplicates(t *testing.T) {
	base := []string{"A=1", "B=2", "GIT_TERMINAL_PROMPT=1"}
	out := mergeEnv(base, map[string]string{"GIT_TERMINAL_PROMPT": "0", "C": "3"})
	got := map[string]string{}
	for _, kv := range out {
		k, v, _ := strings.Cut(kv, "=")
		if _, exists := got[k]; exists {
			t.Fatalf("duplicate key %q in %v", k, out)
		}
		got[k] = v
	}
	if got["GIT_TERMINAL_PROMPT"] != "0" {
		t.Fatalf("prompt=%q", got["GIT_TERMINAL_PROMPT"])
	}
	if got["C"] != "3" || got["A"] != "1" {
		t.Fatalf("got=%v", got)
	}
}

func TestGitRunner_RealGitOptional(t *testing.T) {
	// Sanity: production path works when git exists.
	path, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git not installed")
	}
	g := execGit{Path: path}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "x"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	// non-repo status fails; just ensure runner returns an error with stderr, no panic
	_, err = g.Run(context.Background(), dir, nil, ControlStdoutLimit, "status")
	if err == nil {
		t.Fatal("expected error in non-repo")
	}
}
