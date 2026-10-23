// Package github reads pull-request state for a repository Kin already knows
// about, using credentials that are already on the machine.
//
// The package holds no token and never asks the user for one. It runs the
// user's own GitHub CLI when one it is willing to run exists, and otherwise
// falls back to unauthenticated reads of the public API. Both paths are
// read-only, and nothing here is reachable from a write path.
package github

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/vuuihc/openkin/internal/toolpath"
)

// Environment variable naming a gh binary to use, ahead of every search path.
const ghPathEnv = "KIN_GH_PATH"

var (
	// ErrGHUnavailable means no gh binary Kin is willing to run was found.
	ErrGHUnavailable = errors.New("no usable gh CLI found")
	// ErrNotAuthenticated means gh exists but has no working credential.
	ErrNotAuthenticated = errors.New("gh is not authenticated")
	// ErrNotFound means the repository or pull request is not visible to the
	// credentials in use. For anonymous reads this also covers private repos,
	// which is why it must not be read as "does not exist".
	ErrNotFound = errors.New("not found or not visible")
	// ErrRateLimited means the forge refused the request for quota reasons.
	ErrRateLimited = errors.New("github rate limit reached")
)

// GHBinary is a resolved, trusted path to the GitHub CLI.
type GHBinary struct {
	Path string
}

// ResolveGH locates a gh binary Kin is willing to run.
//
// The search order and the refusals live in internal/toolpath, which git uses
// too: the wrapper that has to be avoided here installs the whole `git-*`
// family, so resolving one tool and not the other would only move the problem.
func ResolveGH() (GHBinary, error) {
	path, err := toolpath.Resolve(toolpath.Spec{
		Name:   "gh",
		EnvVar: ghPathEnv,
		Known:  knownGHLocations(),
	})
	if err != nil {
		return GHBinary{}, fmt.Errorf("%w: %s", ErrGHUnavailable, err)
	}
	return GHBinary{Path: path}, nil
}

func knownGHLocations() []string {
	paths := []string{"/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"}
	if home, err := os.UserHomeDir(); err == nil {
		paths = append(paths, filepath.Join(home, ".local", "bin", "gh"))
	}
	return paths
}

// ghTimeout bounds a single gh invocation. Reading a pull request is a small
// request; anything slower is a network problem, not a slow answer.
const ghTimeout = 30 * time.Second

// ghOutputLimit caps captured stdout. Lists are bounded by --paginate limits at
// the call sites; this is the backstop.
const ghOutputLimit int64 = 8 * 1024 * 1024

const ghStderrCap int64 = 8 * 1024

// GHClient runs the resolved gh binary.
type GHClient struct {
	Bin     GHBinary
	Timeout time.Duration
}

// Run executes `gh args...` with argv only, never a shell.
//
// The child environment keeps the user's own gh configuration and credentials —
// that is the point of using their CLI — but the session-shim directories are
// stripped from PATH so that anything gh itself shells out to cannot pick the
// wrapper up either.
func (c GHClient) Run(ctx context.Context, args ...string) ([]byte, error) {
	if c.Bin.Path == "" {
		return nil, ErrGHUnavailable
	}
	timeout := c.Timeout
	if timeout <= 0 {
		timeout = ghTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, c.Bin.Path, args...)
	cmd.Env = ghEnv()

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &limitWriter{w: &stdout, n: ghOutputLimit + 1}
	cmd.Stderr = &limitWriter{w: &stderr, n: ghStderrCap + 1}

	err := cmd.Run()
	out := stdout.Bytes()
	if int64(len(out)) > ghOutputLimit {
		return nil, fmt.Errorf("gh %s: output exceeded %d bytes", strings.Join(args, " "), ghOutputLimit)
	}
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, fmt.Errorf("gh %s: %w", strings.Join(args, " "), context.DeadlineExceeded)
		}
		if errors.Is(ctx.Err(), context.Canceled) {
			return nil, fmt.Errorf("gh %s: %w", strings.Join(args, " "), context.Canceled)
		}
		msg := strings.TrimSpace(string(capBytes(stderr.Bytes(), ghStderrCap)))
		if msg == "" {
			msg = err.Error()
		}
		return out, classifyGHError(msg)
	}
	return out, nil
}

// ghEnv builds the child environment: the user's, minus wrapper directories,
// plus the settings that keep gh non-interactive and machine-readable.
//
// gh runs helpers of its own — git among them — so the PATH it is handed is
// filtered rather than inherited: resolving gh to a clean absolute path while
// leaving the wrapper on the child's PATH would let it back in one level down.
func ghEnv() []string {
	return append(toolpath.SanitizeEnv(os.Environ()),
		"GH_PROMPT_DISABLED=1",
		"GH_NO_UPDATE_NOTIFIER=1",
		"GH_PAGER=cat",
		"GH_HOST=github.com",
		"NO_COLOR=1",
		"CLICOLOR=0",
	)
}

// httpStatusRe matches the "(HTTP 404)" suffix gh appends to API errors. The
// number is the part worth trusting; the message around it is not stable.
var httpStatusRe = regexp.MustCompile(`\(HTTP (\d{3})\)`)

// classifyGHError turns gh's stderr into one of the sentinel errors.
//
// gh does not expose a machine-readable failure code, so this reads its text:
// the HTTP status when it printed one, and otherwise the few messages that mean
// "you are not logged in". Anything unrecognized stays a plain error, so a new
// gh release degrades to "we could not read this" rather than being misfiled as
// an empty answer.
func classifyGHError(stderr string) error {
	if m := httpStatusRe.FindStringSubmatch(stderr); m != nil {
		if code, err := strconv.Atoi(m[1]); err == nil {
			switch {
			case code == 401:
				return fmt.Errorf("%w: %s", ErrNotAuthenticated, stderr)
			case code == 403:
				return fmt.Errorf("%w: %s", ErrRateLimited, stderr)
			case code == 404:
				return fmt.Errorf("%w: %s", ErrNotFound, stderr)
			}
		}
	}
	lower := strings.ToLower(stderr)
	for _, hint := range []string{
		"gh auth login",
		"authentication required",
		"not logged in",
		"bad credentials",
		"http 401",
	} {
		if strings.Contains(lower, hint) {
			return fmt.Errorf("%w: %s", ErrNotAuthenticated, stderr)
		}
	}
	return errors.New(stderr)
}

type limitWriter struct {
	w io.Writer
	n int64
}

func (l *limitWriter) Write(p []byte) (int, error) {
	if l.n <= 0 {
		return len(p), nil
	}
	if int64(len(p)) > l.n {
		p = p[:l.n]
	}
	n, err := l.w.Write(p)
	l.n -= int64(n)
	return n, err
}

func capBytes(b []byte, limit int64) []byte {
	if int64(len(b)) <= limit {
		return b
	}
	return b[:limit]
}
