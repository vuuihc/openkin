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
		// Both sentinels are kept: ErrGHUnavailable is what a caller asks about,
		// and the resolver's own error says whether the problem was a refusal, a
		// missing binary, or an override pointing somewhere unusable.
		return GHBinary{}, fmt.Errorf("%w: %w", ErrGHUnavailable, err)
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

// ghPipeGrace bounds how long a finished gh invocation's inherited output pipes
// may stay open.
const ghPipeGrace = 2 * time.Second

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
	// The context kills gh, but gh is not always the only process holding the
	// output pipe: a helper it spawned inherits it, and Wait would sit on that
	// pipe until the helper exits on its own. A short grace period bounds the
	// wait — the timeout a caller set is a promise about when this returns, not
	// about when the first process in the tree dies.
	cmd.WaitDelay = ghPipeGrace

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
		// A lingering pipe is not a failed command. os/exec returns ErrWaitDelay
		// — and nothing else — when the process itself exited 0 and only the
		// pipes stayed open: "returned by Cmd.Wait if the process exits with a
		// successful status code but its output pipes are not closed before the
		// command's WaitDelay expires". Reporting that as a failure would turn a
		// read that succeeded into an error, and the caller wants the bytes.
		//
		// The bytes are all there: the copier drains what gh wrote before it
		// blocks on the pipe, so a helper holding it open costs latency, not
		// output. Anything the cap did drop is reported by the length check
		// above, which runs first.
		if errors.Is(err, exec.ErrWaitDelay) {
			return out, nil
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
	// written counts bytes accepted.
	written int64
}

// Write keeps at most n bytes and discards the rest, but always reports the
// whole slice as accepted.
//
// os/exec copies gh's output through this writer, and it treats a short write
// as ErrShortWrite: returning the truncated count would turn a successful gh
// call into a failed query the moment gh printed more than the cap — which a
// talkative gh does on stderr as a matter of course. The caller detects the
// truncation from the buffer length, which is the half that can be trusted.
func (l *limitWriter) Write(p []byte) (int, error) {
	if l.written >= l.n {
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

func capBytes(b []byte, limit int64) []byte {
	if int64(len(b)) <= limit {
		return b
	}
	return b[:limit]
}
