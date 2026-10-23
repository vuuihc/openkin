package workspace

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/vuuihc/openkin/internal/toolpath"
)

const (
	// ControlStdoutLimit is for rev-parse / status / small control commands.
	ControlStdoutLimit int64 = 64 * 1024
	// PathListStdoutLimit is for NUL-delimited path listings.
	PathListStdoutLimit int64 = 4 * 1024 * 1024
	// stderrCap is always applied to captured stderr in errors.
	stderrCap int64 = 64 * 1024
	// pipeGrace bounds how long a finished command's inherited pipes may stay
	// open after the process itself is gone.
	pipeGrace = 2 * time.Second
)

// gitRunner runs git with explicit argv (never a shell).
type gitRunner interface {
	Run(ctx context.Context, dir string, env map[string]string, stdoutLimit int64, args ...string) ([]byte, error)
}

// gitPathEnv names an environment variable holding an explicit git to run.
const gitPathEnv = "KIN_GIT_PATH"

// resolveGit returns an absolute path to a git binary Kin is willing to run.
//
// Deliberately not exec.LookPath. On a machine that also runs an agent desktop
// app, PATH is not trustworthy: that app installs per-session wrappers — the
// whole `git-*` family, not only `gh` — and injects its directory into this
// daemon's PATH twice, ahead of /usr/bin and /opt/homebrew/bin. Every git
// operation Kin performs would then run inside another product's session, on
// the same path that will carry `git push`. See internal/toolpath.
//
// A missing git is not fatal here: the runner reports ErrGitUnavailable when it
// is asked to do something, which is the answer callers already handle.
func resolveGit() string {
	path, err := toolpath.Resolve(toolpath.Spec{
		Name:   "git",
		EnvVar: gitPathEnv,
		Known:  knownGitLocations(),
	})
	if err != nil {
		return ""
	}
	return path
}

func knownGitLocations() []string {
	paths := []string{"/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git"}
	if home, err := os.UserHomeDir(); err == nil {
		paths = append(paths, filepath.Join(home, ".local", "bin", "git"))
	}
	return paths
}

// execGit is the production gitRunner.
type execGit struct {
	Path string
}

// Run executes git with args in dir. stdout is hard-capped; exceeding the limit
// returns ErrOutputTooLarge (no silent truncation of protocol data). stderr is
// capped at 64 KiB in the returned error text.
func (g execGit) Run(ctx context.Context, dir string, env map[string]string, stdoutLimit int64, args ...string) ([]byte, error) {
	if g.Path == "" {
		return nil, ErrGitUnavailable
	}
	if err := rejectNULs(args, env); err != nil {
		return nil, err
	}
	if stdoutLimit <= 0 {
		stdoutLimit = ControlStdoutLimit
	}

	cmd := exec.CommandContext(ctx, g.Path, args...)
	if dir != "" {
		cmd.Dir = dir
	}
	// PATH is filtered, not inherited: git finds `git-remote-https` and the
	// credential helpers through it, so a wrapper directory left in the child's
	// environment would be picked up one level down even though Kin resolved
	// git itself to a clean absolute path.
	cmd.Env = toolpath.SanitizeEnv(mergeEnv(os.Environ(), env))
	// Always force non-interactive git; replace any inherited value.
	cmd.Env = mergeEnv(cmd.Env, map[string]string{"GIT_TERMINAL_PROMPT": "0"})
	// The context kills git, but git is not always the only process holding the
	// output pipe: a clean filter it spawned inherits it, and Wait would sit on
	// that pipe until the filter exits on its own. A short grace period bounds
	// the wait — the timeout a caller set is a promise about when this returns,
	// not about when the first process in the tree dies.
	cmd.WaitDelay = pipeGrace

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &limitWriter{w: &stdout, n: stdoutLimit + 1}
	cmd.Stderr = &limitWriter{w: &stderr, n: stderrCap + 1}

	err := cmd.Run()
	out := stdout.Bytes()
	if int64(len(out)) > stdoutLimit {
		return nil, fmt.Errorf("%w: stdout exceeded %d bytes", ErrOutputTooLarge, stdoutLimit)
	}
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, fmt.Errorf("git %s: %w", strings.Join(args, " "), context.DeadlineExceeded)
		}
		if errors.Is(ctx.Err(), context.Canceled) {
			return nil, fmt.Errorf("git %s: %w", strings.Join(args, " "), context.Canceled)
		}
		// A lingering pipe is not a failed command. os/exec returns ErrWaitDelay
		// — and nothing else — when the process itself exited 0 and only the
		// pipes stayed open: "returned by Cmd.Wait if the process exits with a
		// successful status code but its output pipes are not closed before the
		// command's WaitDelay expires". Reporting that as a failure would turn a
		// read that succeeded into an error, and the caller wants the bytes.
		if errors.Is(err, exec.ErrWaitDelay) {
			return out, nil
		}
		msg := strings.TrimSpace(string(capBytes(stderr.Bytes(), stderrCap)))
		if msg == "" {
			msg = err.Error()
		}
		return out, fmt.Errorf("git %s: %s", strings.Join(args, " "), msg)
	}
	return out, nil
}

func rejectNULs(args []string, env map[string]string) error {
	for _, a := range args {
		if strings.ContainsRune(a, 0) {
			return fmt.Errorf("git argument contains NUL")
		}
	}
	for k, v := range env {
		if strings.ContainsRune(k, 0) || strings.ContainsRune(v, 0) {
			return fmt.Errorf("git environment contains NUL")
		}
	}
	return nil
}

// mergeEnv copies base then applies overrides by key (replace, never duplicate).
func mergeEnv(base []string, overrides map[string]string) []string {
	if len(overrides) == 0 {
		out := make([]string, len(base))
		copy(out, base)
		return out
	}
	index := make(map[string]int, len(base))
	out := make([]string, 0, len(base)+len(overrides))
	for _, kv := range base {
		k, _, _ := strings.Cut(kv, "=")
		if i, ok := index[k]; ok {
			out[i] = kv
			continue
		}
		index[k] = len(out)
		out = append(out, kv)
	}
	for k, v := range overrides {
		entry := k + "=" + v
		if i, ok := index[k]; ok {
			out[i] = entry
			continue
		}
		index[k] = len(out)
		out = append(out, entry)
	}
	return out
}

type limitWriter struct {
	w io.Writer
	n int64
	// written counts bytes accepted.
	written int64
}

func (l *limitWriter) Write(p []byte) (int, error) {
	if l.written >= l.n {
		// Discard remainder but report full length so cmd.Run succeeds when the
		// process exits 0; the caller detects overflow via buffer length.
		return len(p), nil
	}
	remain := l.n - l.written
	if int64(len(p)) > remain {
		n, err := l.w.Write(p[:remain])
		l.written += int64(n)
		if err != nil {
			return n, err
		}
		// Pretend we accepted the rest so the child is not broken by a short write.
		return len(p), nil
	}
	n, err := l.w.Write(p)
	l.written += int64(n)
	return n, err
}

func capBytes(b []byte, n int64) []byte {
	if int64(len(b)) <= n {
		return b
	}
	return b[:n]
}
