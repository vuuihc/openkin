package workspace

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
)

const (
	// ControlStdoutLimit is for rev-parse / status / small control commands.
	ControlStdoutLimit int64 = 64 * 1024
	// PathListStdoutLimit is for NUL-delimited path listings.
	PathListStdoutLimit int64 = 4 * 1024 * 1024
	// stderrCap is always applied to captured stderr in errors.
	stderrCap int64 = 64 * 1024
)

// gitRunner runs git with explicit argv (never a shell).
type gitRunner interface {
	Run(ctx context.Context, dir string, env map[string]string, stdoutLimit int64, args ...string) ([]byte, error)
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
	cmd.Env = mergeEnv(os.Environ(), env)
	// Always force non-interactive git; replace any inherited value.
	cmd.Env = mergeEnv(cmd.Env, map[string]string{"GIT_TERMINAL_PROMPT": "0"})

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
